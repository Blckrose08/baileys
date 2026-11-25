import { Mutex } from 'async-mutex';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'rosedb';
import { proto } from '../../WAProto/index.js';
import { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types/index.js';
import { initAuthCreds } from './auth-utils.js';
import { BufferJSON } from './generics.js';
import { formatSafeError } from './session-security.js';

export interface RoseDBAuthStateOptions {
    sessionId: string;
    ownerId?: string;
    dbPath?: string;
    db?: Database;
    dbOptions?: Record<string, unknown>;
    encryptionKey: string | Buffer;
    lockFilePath?: string;
    backupIntervalMs?: number;
    backupDir?: string;
}

export interface RoseDBAuthSecurity {
    createEncryptedBackup(destFile: string): Promise<{ file: string; keyCount: number }>;
    restoreEncryptedBackup(srcFile: string): Promise<{ restoredKeys: number }>;
    rotateEncryptionKey(newEncryptionKey: string | Buffer): Promise<{ keyVersion: number; rotatedKeys: number }>;
    verifyIntegrity(): Promise<{ ok: boolean; configured: boolean; keyVersion?: number; dbCheck?: unknown; error?: string }>;
    verifyFingerprint(): Promise<{ configured: boolean; matched: boolean; note: string }>;
    clearSession(): Promise<void>;
    close(): Promise<void>;
    getLockStatus(): { locked: boolean; lockPath: string };
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const LOCK_STALE_MS = 5 * 60 * 1000;

const sessionMutexes = new Map<string, Mutex>();
const openDatabases = new Map<string, Database>();

function getSessionMutex(sessionKey: string): Mutex {
    let mutex = sessionMutexes.get(sessionKey);
    if (!mutex) {
        mutex = new Mutex();
        sessionMutexes.set(sessionKey, mutex);
    }
    return mutex;
}

function normalizeMasterKey(encryptionKey: string | Buffer, salt: string): Buffer {
    if (Buffer.isBuffer(encryptionKey)) {
        if (encryptionKey.length !== 32) {
            throw new Error('encryptionKey Buffer must be exactly 32 bytes for AES-256-GCM');
        }
        return encryptionKey;
    }
    if (typeof encryptionKey === 'string') {
        const trimmed = encryptionKey.trim();
        if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
            return Buffer.from(trimmed, 'hex');
        }
        return scryptSync(trimmed, salt, 32);
    }
    throw new Error('encryptionKey is required and must be a 32-byte Buffer or passphrase string');
}

function encryptPayload(plaintextObj: unknown, key: Buffer, aadText: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    if (aadText) cipher.setAAD(Buffer.from(aadText, 'utf8'));
    const serialized = JSON.stringify(plaintextObj, BufferJSON.replacer);
    const encrypted = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
        v: 1,
        alg: ALGORITHM,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: encrypted.toString('base64')
    });
}

function decryptPayload<T = any>(rawEnvelope: string | Record<string, any>, key: Buffer, aadText: string): T {
    const envelope = typeof rawEnvelope === 'string' ? JSON.parse(rawEnvelope) : rawEnvelope;
    if (!envelope || envelope.alg !== ALGORITHM || !envelope.iv || !envelope.tag || !envelope.data) {
        throw new Error('Invalid encrypted session envelope');
    }
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    if (tag.length !== TAG_LENGTH) {
        throw new Error('Invalid GCM authentication tag length');
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    if (aadText) decipher.setAAD(Buffer.from(aadText, 'utf8'));
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'), BufferJSON.reviver);
}

export function getRuntimeFingerprint(sessionId = 'default'): string {
    const raw = [os.hostname(), os.platform(), os.arch(), process.version, sessionId].join('|');
    return createHash('sha256').update(raw).digest('hex');
}

async function acquireProcessLock(lockPath: string) {
    await mkdir(dirname(lockPath), { recursive: true });
    const tryOpen = async () => {
        const fh = await open(lockPath, 'wx', 0o600);
        try {
            await fh.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), 'utf8');
        }
        finally {
            await fh.close();
        }
    };
    try {
        await tryOpen();
    }
    catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
        let stale = false;
        try {
            const parsed = JSON.parse(await readFile(lockPath, 'utf8'));
            if (Date.now() - (parsed.acquiredAt || 0) > LOCK_STALE_MS || parsed.pid === process.pid) {
                stale = true;
            }
            else if (parsed.pid) {
                try { process.kill(parsed.pid, 0); } catch { stale = true; }
            }
        }
        catch { stale = true; }
        if (!stale) throw new Error(`Session is already locked by another process (${lockPath})`);
        await unlink(lockPath).catch(() => {});
        await tryOpen();
    }
    return { lockPath, release: async () => { await unlink(lockPath).catch(() => {}); } };
}

async function openRoseDB(dbPath: string, dbOptions?: Record<string, unknown>): Promise<Database> {
    if (openDatabases.has(dbPath)) {
        return openDatabases.get(dbPath)!;
    }
    await mkdir(dirname(dbPath), { recursive: true });
    const instance = new Database(dbPath, dbOptions);
    openDatabases.set(dbPath, instance);
    return instance;
}

export const useRoseDBAuthState = async (options: RoseDBAuthStateOptions): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    security: RoseDBAuthSecurity;
}> => {
    const {
        sessionId = 'default',
        ownerId = 'default',
        dbPath = './database.db',
        db: externalDb,
        dbOptions,
        encryptionKey,
        lockFilePath,
        backupIntervalMs = 0,
        backupDir
    } = options || ({} as RoseDBAuthStateOptions);

    if (!sessionId || typeof sessionId !== 'string') throw new Error('sessionId must be a non-empty string');
    if (!ownerId || typeof ownerId !== 'string') throw new Error('ownerId must be a non-empty string');

    const salt = `baileys-rosedb:${sessionId}:${ownerId}`;
    let masterKey = normalizeMasterKey(encryptionKey, salt);
    const db = externalDb || (await openRoseDB(dbPath, dbOptions));
    const ownsDb = !externalDb;

    const lockPath = lockFilePath || join(dbPath ? dirname(dbPath) : os.tmpdir(), `.${sessionId}.lock`);
    const lockHandle = await acquireProcessLock(lockPath);
    const mutex = getSessionMutex(`${dbPath || 'external'}:${sessionId}`);

    const prefix = `s:${sessionId}:`;
    const metaKey = `${prefix}meta`;
    const credsKey = `${prefix}creds`;
    const keyPrefix = `${prefix}key:`;
    const keyEnd = `${prefix}key;`;

    const buildAad = (recordKey: string) => `${sessionId}:${ownerId}:${recordKey}`;
    const computeOwnerMac = (meta: Record<string, any>) =>
        createHmac('sha256', masterKey)
            .update(`${meta.sessionId}|${meta.ownerId}|${meta.keyVersion}|${meta.fingerprint}`)
            .digest('hex');

    const verifyOwnerAndMeta = () => {
        const rawMeta = db.get(metaKey);
        if (!rawMeta) return null;
        const meta = JSON.parse(rawMeta);
        if (meta.ownerId !== ownerId || meta.sessionId !== sessionId) throw new Error('Access denied: session owner mismatch');
        if (meta.mac !== computeOwnerMac(meta)) throw new Error('Session integrity check failed: metadata MAC mismatch');
        return meta;
    };

    const ensureMetaInitialized = () => {
        const existing = verifyOwnerAndMeta();
        if (existing) return existing;
        const meta = {
            sessionId,
            ownerId,
            keyVersion: 1,
            fingerprint: getRuntimeFingerprint(sessionId),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            mac: ''
        };
        meta.mac = computeOwnerMac(meta);
        db.put(metaKey, JSON.stringify(meta));
        return meta;
    };

    const readEncryptedRecord = <T = any>(recordKey: string): T | null => {
        const raw = db.get(recordKey);
        return raw ? decryptPayload<T>(raw, masterKey, buildAad(recordKey)) : null;
    };

    const writeEncryptedRecord = (recordKey: string, value: unknown) => {
        db.put(recordKey, encryptPayload(value, masterKey, buildAad(recordKey)));
    };

    let creds!: AuthenticationCreds;
    await mutex.runExclusive(async () => {
        ensureMetaInitialized();
        const existingCreds = readEncryptedRecord<AuthenticationCreds>(credsKey);
        if (existingCreds) {
            creds = existingCreds;
        }
        else {
            creds = initAuthCreds();
            writeEncryptedRecord(credsKey, creds);
        }
    });

    const saveCreds = async () => {
        return mutex.runExclusive(async () => {
            const meta = ensureMetaInitialized();
            meta.updatedAt = Date.now();
            meta.mac = computeOwnerMac(meta);
            db.batch([
                { op: 'put', key: metaKey, value: JSON.stringify(meta) },
                { op: 'put', key: credsKey, value: encryptPayload(creds, masterKey, buildAad(credsKey)) }
            ]);
        });
    };

    const keyCache = new Map<string, any>();
    const MAX_KEY_CACHE_SIZE = 10000;
    const setKeyCache = (dbKey: string, val: any) => {
        if (keyCache.size >= MAX_KEY_CACHE_SIZE && !keyCache.has(dbKey)) {
            const oldest = keyCache.keys().next().value;
            if (oldest !== undefined) keyCache.delete(oldest);
        }
        keyCache.set(dbKey, val);
    };

    const keys = {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
            const result: { [id: string]: SignalDataTypeMap[T] } = {};
            if (!ids || ids.length === 0) return result;
            return mutex.runExclusive(async () => {
                const missing: { id: string; dbKey: string }[] = [];
                for (const id of ids) {
                    const dbKey = `${keyPrefix}${type}:${id}`;
                    if (keyCache.has(dbKey)) result[id] = keyCache.get(dbKey);
                    else missing.push({ id, dbKey });
                }
                if (missing.length === 0) return result;
                verifyOwnerAndMeta();
                const rawMap = db.mget(missing.map(m => m.dbKey)) as any;
                for (let i = 0; i < missing.length; i++) {
                    const { id, dbKey } = missing[i];
                    const rawVal = (Array.isArray(rawMap) ? rawMap[i] : rawMap?.[dbKey]) ?? null;
                    if (!rawVal) {
                        result[id] = null as any;
                        setKeyCache(dbKey, null);
                        continue;
                    }
                    let value: any = decryptPayload(rawVal, masterKey, buildAad(dbKey));
                    if (type === 'app-state-sync-key' && value) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    result[id] = value;
                    setKeyCache(dbKey, value);
                }
                return result;
            });
        },
        set: async (data: any) => {
            return mutex.runExclusive(async () => {
                verifyOwnerAndMeta();
                const ops: { op: 'put' | 'delete'; key: string; value?: string }[] = [];
                for (const category in data) {
                    for (const id in data[category]) {
                        const value = data[category][id];
                        const dbKey = `${keyPrefix}${category}:${id}`;
                        if (value) {
                            ops.push({ op: 'put', key: dbKey, value: encryptPayload(value, masterKey, buildAad(dbKey)) });
                            setKeyCache(dbKey, value);
                        }
                        else {
                            ops.push({ op: 'delete', key: dbKey });
                            setKeyCache(dbKey, null);
                        }
                    }
                }
                if (ops.length > 0) db.batch(ops);
            });
        },
        clear: async () => {
            return mutex.runExclusive(async () => {
                verifyOwnerAndMeta();
                keyCache.clear();
                const entries = db.scan(keyPrefix, keyEnd);
                if (entries.length > 0) db.batch(entries.map(e => ({ op: 'delete', key: e.key })));
            });
        }
    };

    const createEncryptedBackup = async (destFile: string) => {
        return mutex.runExclusive(async () => {
            const meta = verifyOwnerAndMeta();
            const keyEntries = db.scan(keyPrefix, keyEnd);
            const rawCreds = db.get(credsKey);
            const snapshot = { sessionId, ownerId, meta, creds: rawCreds, keys: keyEntries };
            const encryptedBackup = encryptPayload(snapshot, masterKey, `backup:${sessionId}:${ownerId}`);
            await mkdir(dirname(destFile), { recursive: true });
            const tmpFile = `${destFile}.tmp-${process.pid}-${Date.now()}`;
            await writeFile(tmpFile, encryptedBackup, { encoding: 'utf8', mode: 0o600 });
            await rename(tmpFile, destFile);
            return { file: destFile, keyCount: keyEntries.length };
        });
    };

    const restoreEncryptedBackup = async (srcFile: string) => {
        return mutex.runExclusive(async () => {
            const raw = await readFile(srcFile, 'utf8');
            const snapshot = decryptPayload(raw, masterKey, `backup:${sessionId}:${ownerId}`);
            if (snapshot.sessionId !== sessionId || snapshot.ownerId !== ownerId) throw new Error('Backup session/owner mismatch');
            const ops: { op: 'put'; key: string; value: string }[] = [];
            if (snapshot.meta) ops.push({ op: 'put', key: metaKey, value: JSON.stringify(snapshot.meta) });
            if (snapshot.creds) ops.push({ op: 'put', key: credsKey, value: snapshot.creds });
            for (const entry of snapshot.keys || []) ops.push({ op: 'put', key: entry.key, value: entry.value });
            if (ops.length > 0) db.batch(ops);
            keyCache.clear();
            creds = readEncryptedRecord<AuthenticationCreds>(credsKey) || initAuthCreds();
            return { restoredKeys: (snapshot.keys || []).length };
        });
    };

    const rotateEncryptionKey = async (newEncryptionKey: string | Buffer) => {
        return mutex.runExclusive(async () => {
            const meta = verifyOwnerAndMeta();
            const newMasterKey = normalizeMasterKey(newEncryptionKey, salt);
            const keyEntries = db.scan(keyPrefix, keyEnd);
            const currentCreds = readEncryptedRecord(credsKey);
            const ops: { op: 'put'; key: string; value: string }[] = [];
            meta.keyVersion = (meta.keyVersion || 1) + 1;
            meta.updatedAt = Date.now();
            meta.mac = createHmac('sha256', newMasterKey)
                .update(`${meta.sessionId}|${meta.ownerId}|${meta.keyVersion}|${meta.fingerprint}`)
                .digest('hex');
            ops.push({ op: 'put', key: metaKey, value: JSON.stringify(meta) });
            if (currentCreds) ops.push({ op: 'put', key: credsKey, value: encryptPayload(currentCreds, newMasterKey, buildAad(credsKey)) });
            for (const entry of keyEntries) {
                const plain = decryptPayload(entry.value, masterKey, buildAad(entry.key));
                ops.push({ op: 'put', key: entry.key, value: encryptPayload(plain, newMasterKey, buildAad(entry.key)) });
            }
            db.batch(ops);
            masterKey = newMasterKey;
            return { keyVersion: meta.keyVersion, rotatedKeys: keyEntries.length };
        });
    };

    const verifyIntegrity = async () => {
        return mutex.runExclusive(async () => {
            try {
                const meta = verifyOwnerAndMeta();
                const dbCheck = typeof db.integrityCheck === 'function' ? db.integrityCheck() : { ok: true };
                const credsOk = !!readEncryptedRecord(credsKey);
                return { ok: Boolean(meta && credsOk && dbCheck?.ok !== false), configured: true, keyVersion: meta?.keyVersion || 1, dbCheck };
            }
            catch (err) {
                return { ok: false, configured: true, error: formatSafeError(err).message };
            }
        });
    };

    const verifyFingerprint = async () => {
        return mutex.runExclusive(async () => {
            const meta = verifyOwnerAndMeta();
            return {
                configured: true,
                matched: meta?.fingerprint === getRuntimeFingerprint(sessionId),
                note: 'Device fingerprinting is a runtime signal and not proof of WhatsApp account safety.'
            };
        });
    };

    let backupTimer: ReturnType<typeof setInterval> | null = null;
    if (backupIntervalMs > 0 && backupDir) {
        backupTimer = setInterval(() => {
            createEncryptedBackup(join(backupDir, `${sessionId}-latest.enc.bak`)).catch(() => {});
        }, backupIntervalMs);
        if (typeof backupTimer.unref === 'function') backupTimer.unref();
    }

    const close = async () => {
        if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
        await lockHandle.release();
        if (ownsDb && typeof db.close === 'function') {
            openDatabases.delete(dbPath);
            db.close();
        }
    };

    const clearSession = async () => {
        await mutex.runExclusive(async () => {
            verifyOwnerAndMeta();
            const keyEntries = db.scan(keyPrefix, keyEnd);
            const ops = [
                { op: 'delete' as const, key: credsKey },
                { op: 'delete' as const, key: metaKey },
                ...keyEntries.map(e => ({ op: 'delete' as const, key: e.key }))
            ];
            db.batch(ops);
            keyCache.clear();
            if (typeof db.checkpoint === 'function') db.checkpoint();
        });
        await close();
    };

    const security: RoseDBAuthSecurity = {
        createEncryptedBackup,
        restoreEncryptedBackup,
        rotateEncryptionKey,
        verifyIntegrity,
        verifyFingerprint,
        clearSession,
        close,
        getLockStatus: () => ({ locked: true, lockPath })
    };
    const state: AuthenticationState = { creds, keys };
    Object.defineProperty(state, Symbol.for('baileys.authSecurity'), { value: security, enumerable: false });

    return { state, saveCreds, security };
};

(globalThis as any).useRoseDBAuthState ??= useRoseDBAuthState;

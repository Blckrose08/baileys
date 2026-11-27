import { Mutex } from 'async-mutex';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'rosedb';
import { proto } from '../../WAProto/index.js';
import { initAuthCreds } from './auth-utils.js';
import { BufferJSON } from './generics.js';
import { formatSafeError } from './session-security.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const LOCK_STALE_MS = 5 * 60 * 1000;

const sessionMutexes = new Map();
const openDatabases = new Map();

function getSessionMutex(sessionKey) {
    let mutex = sessionMutexes.get(sessionKey);
    if (!mutex) {
        mutex = new Mutex();
        sessionMutexes.set(sessionKey, mutex);
    }
    return mutex;
}

function normalizeMasterKey(encryptionKey, salt) {
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

function encryptPayload(plaintextObj, key, aadText) {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    if (aadText) {
        cipher.setAAD(Buffer.from(aadText, 'utf8'));
    }
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

function decryptPayload(rawEnvelope, key, aadText) {
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
    if (aadText) {
        decipher.setAAD(Buffer.from(aadText, 'utf8'));
    }
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final()
    ]);
    return JSON.parse(decrypted.toString('utf8'), BufferJSON.reviver);
}

export function getRuntimeFingerprint(sessionId) {
    const raw = [
        os.hostname(),
        os.platform(),
        os.arch(),
        process.version,
        sessionId || 'default'
    ].join('|');
    return createHash('sha256').update(raw).digest('hex');
}

async function acquireProcessLock(lockPath) {
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
    catch (err) {
        if (err?.code !== 'EEXIST') {
            throw err;
        }
        // Check if existing lock is stale or dead PID
        let stale = false;
        try {
            const raw = await readFile(lockPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (Date.now() - (parsed.acquiredAt || 0) > LOCK_STALE_MS || parsed.pid === process.pid) {
                stale = true;
            }
            else if (parsed.pid) {
                try {
                    process.kill(parsed.pid, 0);
                }
                catch {
                    stale = true;
                }
            }
        }
        catch {
            stale = true;
        }
        if (!stale) {
            throw new Error(`Session is already locked by another process (${lockPath})`);
        }
        await unlink(lockPath).catch(() => {});
        await tryOpen();
    }
    return {
        lockPath,
        release: async () => {
            await unlink(lockPath).catch(() => {});
        }
    };
}

async function maybeCompactRoseDB(dbPath, thresholdBytes = 3 * 1024 * 1024, maxPreKeys = 100) {
    try {
        const dataFile = join(dbPath, 'data.rdb');
        const walFile = join(dbPath, 'wal.log');
        const [stData, stWal] = await Promise.all([
            stat(dataFile).catch(() => null),
            stat(walFile).catch(() => null)
        ]);
        const dataSize = stData ? stData.size : 0;
        const walSize = stWal ? stWal.size : 0;
        const totalSize = dataSize + walSize;

        if (totalSize < thresholdBytes && walSize < 2 * 1024 * 1024) {
            return { compacted: false, oldSizeBytes: totalSize, newSizeBytes: totalSize };
        }

        const oldSizeBytes = totalSize;
        const tmpPath = `${dbPath}.compact.${Date.now()}`;
        const dbOld = new Database(dbPath);
        const dbNew = new Database(tmpPath, { sync_on_commit: true });

        const entries = dbOld.scan('', '\uffff', 500000);
        const preKeys = [];
        const otherKeys = [];

        for (const e of entries) {
            if (e.key.includes(':key:pre-key:')) {
                preKeys.push(e);
            } else {
                otherKeys.push(e);
            }
        }

        preKeys.sort((a, b) => {
            const idA = parseInt(a.key.split(':').pop() || '0', 10) || 0;
            const idB = parseInt(b.key.split(':').pop() || '0', 10) || 0;
            return idB - idA;
        });

        const keptPreKeys = preKeys.slice(0, maxPreKeys);
        const allKept = [...otherKeys, ...keptPreKeys];

        dbNew.batch(allKept.map(e => ({ op: 'put', key: e.key, value: e.value })));
        if (typeof dbNew.checkpoint === 'function') {
            dbNew.checkpoint();
        }

        dbOld.close();
        dbNew.close();

        const backupPath = `${dbPath}.old.${Date.now()}`;
        await rename(dbPath, backupPath);
        await rename(tmpPath, dbPath);
        await rm(backupPath, { recursive: true, force: true }).catch(() => {});

        const [newStData, newStWal] = await Promise.all([
            stat(dataFile).catch(() => null),
            stat(walFile).catch(() => null)
        ]);
        const newSizeBytes = (newStData ? newStData.size : 0) + (newStWal ? newStWal.size : 0);
        return { compacted: true, oldSizeBytes, newSizeBytes };
    } catch {
        return { compacted: false, oldSizeBytes: 0, newSizeBytes: 0 };
    }
}

async function openRoseDB(dbPath, dbOptions) {
    if (openDatabases.has(dbPath)) {
        return openDatabases.get(dbPath);
    }
    await mkdir(dirname(dbPath), { recursive: true });
    const instance = new Database(dbPath, dbOptions);
    openDatabases.set(dbPath, instance);
    return instance;
}

export const useRoseDBAuthState = async (options) => {
    const {
        sessionId = 'default',
        ownerId = 'default',
        dbPath = './database.db',
        db: externalDb,
        dbOptions,
        encryptionKey,
        lockFilePath,
        backupIntervalMs = 0,
        backupDir,
        autoPrune = true,
        maxPreKeys = 100,
        checkpointIntervalOps = 50,
        autoCompact = true,
        compactThresholdBytes = 3 * 1024 * 1024
    } = options || {};

    if (!sessionId || typeof sessionId !== 'string') {
        throw new Error('sessionId must be a non-empty string');
    }
    if (!ownerId || typeof ownerId !== 'string') {
        throw new Error('ownerId must be a non-empty string');
    }

    const lockPath = lockFilePath || join(dbPath ? dirname(dbPath) : os.tmpdir(), `.${sessionId}.lock`);
    const lockHandle = await acquireProcessLock(lockPath);
    const mutex = getSessionMutex(`${dbPath || 'external'}:${sessionId}`);
    const ownsDb = !externalDb;

    if (ownsDb && autoCompact) {
        await maybeCompactRoseDB(dbPath, compactThresholdBytes, maxPreKeys);
    }

    const salt = `baileys-rosedb:${sessionId}:${ownerId}`;
    let masterKey = normalizeMasterKey(encryptionKey, salt);
    const db = externalDb || (await openRoseDB(dbPath, dbOptions));
    let opsSinceLastCheckpoint = 0;

    const prefix = `s:${sessionId}:`;
    const metaKey = `${prefix}meta`;
    const credsKey = `${prefix}creds`;
    const keyPrefix = `${prefix}key:`;
    const keyEnd = `${prefix}key;`; // ';' is ASCII 59, right after ':' (ASCII 58)

    const buildAad = (recordKey) => `${sessionId}:${ownerId}:${recordKey}`;
    const computeOwnerMac = (meta) =>
        createHmac('sha256', masterKey)
            .update(`${meta.sessionId}|${meta.ownerId}|${meta.keyVersion}|${meta.fingerprint}`)
            .digest('hex');

    const verifyOwnerAndMeta = () => {
        const rawMeta = db.get(metaKey);
        if (!rawMeta) {
            return null;
        }
        const meta = JSON.parse(rawMeta);
        if (meta.ownerId !== ownerId || meta.sessionId !== sessionId) {
            throw new Error('Access denied: session owner mismatch');
        }
        const expectedMac = computeOwnerMac(meta);
        if (meta.mac !== expectedMac) {
            throw new Error('Session integrity check failed: metadata MAC mismatch');
        }
        return meta;
    };

    const ensureMetaInitialized = () => {
        const existing = verifyOwnerAndMeta();
        if (existing) {
            return existing;
        }
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

    const readEncryptedRecord = (recordKey) => {
        const raw = db.get(recordKey);
        if (!raw) {
            return null;
        }
        return decryptPayload(raw, masterKey, buildAad(recordKey));
    };

    const writeEncryptedRecord = (recordKey, value) => {
        const encrypted = encryptPayload(value, masterKey, buildAad(recordKey));
        db.put(recordKey, encrypted);
    };

    let creds;
    await mutex.runExclusive(async () => {
        ensureMetaInitialized();
        const existingCreds = readEncryptedRecord(credsKey);
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
            if (typeof db.checkpoint === 'function') {
                try { db.checkpoint(); } catch {}
                opsSinceLastCheckpoint = 0;
            }
        });
    };

    const keyCache = new Map();
    const MAX_KEY_CACHE_SIZE = 10000;
    const setKeyCache = (dbKey, val) => {
        if (keyCache.size >= MAX_KEY_CACHE_SIZE && !keyCache.has(dbKey)) {
            const oldest = keyCache.keys().next().value;
            if (oldest !== undefined) {
                keyCache.delete(oldest);
            }
        }
        keyCache.set(dbKey, val);
    };

    const keys = {
        get: async (type, ids) => {
            if (!ids || ids.length === 0) {
                return {};
            }
            return mutex.runExclusive(async () => {
                const result = {};
                const missing = [];
                for (const id of ids) {
                    const dbKey = `${keyPrefix}${type}:${id}`;
                    if (keyCache.has(dbKey)) {
                        result[id] = keyCache.get(dbKey);
                    }
                    else {
                        missing.push({ id, dbKey });
                    }
                }
                if (missing.length === 0) {
                    return result;
                }
                verifyOwnerAndMeta();
                const rawMap = db.mget(missing.map(m => m.dbKey));
                for (let i = 0; i < missing.length; i++) {
                    const { id, dbKey } = missing[i];
                    const rawVal = (Array.isArray(rawMap) ? rawMap[i] : rawMap?.[dbKey]) ?? null;
                    if (!rawVal) {
                        result[id] = null;
                        setKeyCache(dbKey, null);
                        continue;
                    }
                    let value = decryptPayload(rawVal, masterKey, buildAad(dbKey));
                    if (type === 'app-state-sync-key' && value) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    result[id] = value;
                    setKeyCache(dbKey, value);
                }
                return result;
            });
        },
        set: async (data) => {
            return mutex.runExclusive(async () => {
                verifyOwnerAndMeta();
                const ops = [];
                let hasPreKeyUpdates = false;
                for (const category in data) {
                    if (category === 'pre-key') hasPreKeyUpdates = true;
                    for (const id in data[category]) {
                        const value = data[category][id];
                        const dbKey = `${keyPrefix}${category}:${id}`;
                        if (value) {
                            ops.push({
                                op: 'put',
                                key: dbKey,
                                value: encryptPayload(value, masterKey, buildAad(dbKey))
                            });
                            setKeyCache(dbKey, value);
                        }
                        else {
                            ops.push({ op: 'delete', key: dbKey });
                            setKeyCache(dbKey, null);
                        }
                    }
                }
                if (ops.length > 0) {
                    db.batch(ops);
                    opsSinceLastCheckpoint += ops.length;
                }

                if (autoPrune && hasPreKeyUpdates) {
                    const preKeyPrefix = `${keyPrefix}pre-key:`;
                    const preKeyEnd = `${keyPrefix}pre-key;`;
                    const preKeyEntries = db.scan(preKeyPrefix, preKeyEnd, 100000);
                    if (preKeyEntries.length > maxPreKeys + 20) {
                        preKeyEntries.sort((a, b) => {
                            const idA = parseInt(a.key.slice(preKeyPrefix.length), 10) || 0;
                            const idB = parseInt(b.key.slice(preKeyPrefix.length), 10) || 0;
                            return idB - idA;
                        });
                        const toDelete = preKeyEntries.slice(maxPreKeys);
                        if (toDelete.length > 0) {
                            db.batch(toDelete.map(e => ({ op: 'delete', key: e.key })));
                            for (const e of toDelete) {
                                keyCache.delete(e.key);
                            }
                        }
                        if (typeof db.checkpoint === 'function') {
                            try { db.checkpoint(); } catch {}
                            opsSinceLastCheckpoint = 0;
                        }
                    }
                }

                if (opsSinceLastCheckpoint >= checkpointIntervalOps) {
                    if (typeof db.checkpoint === 'function') {
                        try { db.checkpoint(); } catch {}
                        opsSinceLastCheckpoint = 0;
                    }
                }
            });
        },
        clear: async () => {
            return mutex.runExclusive(async () => {
                verifyOwnerAndMeta();
                keyCache.clear();
                const entries = db.scan(keyPrefix, keyEnd);
                if (entries.length > 0) {
                    db.batch(entries.map(e => ({ op: 'delete', key: e.key })));
                }
            });
        }
    };

    const createEncryptedBackup = async (destFile) => {
        return mutex.runExclusive(async () => {
            const meta = verifyOwnerAndMeta();
            const keyEntries = db.scan(keyPrefix, keyEnd);
            const rawCreds = db.get(credsKey);
            const snapshot = {
                sessionId,
                ownerId,
                meta,
                creds: rawCreds,
                keys: keyEntries
            };
            const encryptedBackup = encryptPayload(snapshot, masterKey, `backup:${sessionId}:${ownerId}`);
            await mkdir(dirname(destFile), { recursive: true });
            const tmpFile = `${destFile}.tmp-${process.pid}-${Date.now()}`;
            await writeFile(tmpFile, encryptedBackup, { encoding: 'utf8', mode: 0o600 });
            await rename(tmpFile, destFile);
            return { file: destFile, keyCount: keyEntries.length };
        });
    };

    const restoreEncryptedBackup = async (srcFile) => {
        return mutex.runExclusive(async () => {
            const raw = await readFile(srcFile, 'utf8');
            const snapshot = decryptPayload(raw, masterKey, `backup:${sessionId}:${ownerId}`);
            if (snapshot.sessionId !== sessionId || snapshot.ownerId !== ownerId) {
                throw new Error('Backup session/owner mismatch');
            }
            const ops = [];
            if (snapshot.meta) {
                ops.push({ op: 'put', key: metaKey, value: JSON.stringify(snapshot.meta) });
            }
            if (snapshot.creds) {
                ops.push({ op: 'put', key: credsKey, value: snapshot.creds });
            }
            for (const entry of snapshot.keys || []) {
                ops.push({ op: 'put', key: entry.key, value: entry.value });
            }
            if (ops.length > 0) {
                db.batch(ops);
            }
            keyCache.clear();
            creds = readEncryptedRecord(credsKey) || initAuthCreds();
            return { restoredKeys: (snapshot.keys || []).length };
        });
    };

    const rotateEncryptionKey = async (newEncryptionKey) => {
        return mutex.runExclusive(async () => {
            const meta = verifyOwnerAndMeta();
            const newMasterKey = normalizeMasterKey(newEncryptionKey, salt);
            const keyEntries = db.scan(keyPrefix, keyEnd);
            const currentCreds = readEncryptedRecord(credsKey);
            const ops = [];

            meta.keyVersion = (meta.keyVersion || 1) + 1;
            meta.updatedAt = Date.now();
            meta.mac = createHmac('sha256', newMasterKey)
                .update(`${meta.sessionId}|${meta.ownerId}|${meta.keyVersion}|${meta.fingerprint}`)
                .digest('hex');
            ops.push({ op: 'put', key: metaKey, value: JSON.stringify(meta) });

            if (currentCreds) {
                ops.push({
                    op: 'put',
                    key: credsKey,
                    value: encryptPayload(currentCreds, newMasterKey, buildAad(credsKey))
                });
            }
            for (const entry of keyEntries) {
                const plain = decryptPayload(entry.value, masterKey, buildAad(entry.key));
                ops.push({
                    op: 'put',
                    key: entry.key,
                    value: encryptPayload(plain, newMasterKey, buildAad(entry.key))
                });
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
                return {
                    ok: Boolean(meta && credsOk && dbCheck?.valid !== false && dbCheck?.ok !== false),
                    configured: true,
                    keyVersion: meta?.keyVersion || 1,
                    dbCheck
                };
            }
            catch (err) {
                return {
                    ok: false,
                    configured: true,
                    error: formatSafeError(err).message
                };
            }
        });
    };

    const verifyFingerprint = async () => {
        return mutex.runExclusive(async () => {
            const meta = verifyOwnerAndMeta();
            const current = getRuntimeFingerprint(sessionId);
            return {
                configured: true,
                matched: meta?.fingerprint === current,
                note: 'Device fingerprinting is a runtime signal and not proof of WhatsApp account safety.'
            };
        });
    };

    let backupTimer = null;
    if (backupIntervalMs > 0 && backupDir) {
        backupTimer = setInterval(() => {
            const target = join(backupDir, `${sessionId}-latest.enc.bak`);
            createEncryptedBackup(target).catch(() => {});
        }, backupIntervalMs);
        if (typeof backupTimer.unref === 'function') {
            backupTimer.unref();
        }
    }

    const close = async () => {
        if (backupTimer) {
            clearInterval(backupTimer);
            backupTimer = null;
        }
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
                { op: 'delete', key: credsKey },
                { op: 'delete', key: metaKey },
                ...keyEntries.map(e => ({ op: 'delete', key: e.key }))
            ];
            db.batch(ops);
            keyCache.clear();
            if (typeof db.checkpoint === 'function') {
                db.checkpoint();
            }
        });
        await close();
    };

    const prune = async (opts) => {
        const targetMax = typeof opts?.maxPreKeys === 'number' ? opts.maxPreKeys : maxPreKeys;
        return mutex.runExclusive(async () => {
            verifyOwnerAndMeta();
            const preKeyPrefix = `${keyPrefix}pre-key:`;
            const preKeyEnd = `${keyPrefix}pre-key;`;
            const entries = db.scan(preKeyPrefix, preKeyEnd, 100000);
            if (entries.length > targetMax) {
                entries.sort((a, b) => {
                    const idA = parseInt(a.key.slice(preKeyPrefix.length), 10) || 0;
                    const idB = parseInt(b.key.slice(preKeyPrefix.length), 10) || 0;
                    return idB - idA;
                });
                const toDelete = entries.slice(targetMax);
                if (toDelete.length > 0) {
                    db.batch(toDelete.map(e => ({ op: 'delete', key: e.key })));
                    for (const e of toDelete) {
                        keyCache.delete(e.key);
                    }
                }
                if (typeof db.checkpoint === 'function') {
                    try { db.checkpoint(); } catch {}
                    opsSinceLastCheckpoint = 0;
                }
                return { prunedPreKeys: toDelete.length, remainingPreKeys: targetMax };
            }
            if (typeof db.checkpoint === 'function') {
                try { db.checkpoint(); } catch {}
                opsSinceLastCheckpoint = 0;
            }
            return { prunedPreKeys: 0, remainingPreKeys: entries.length };
        });
    };

    const checkpoint = async () => {
        return mutex.runExclusive(async () => {
            if (typeof db.checkpoint === 'function') {
                try { db.checkpoint(); } catch {}
                opsSinceLastCheckpoint = 0;
            }
        });
    };

    const stats = async () => {
        return mutex.runExclusive(async () => {
            verifyOwnerAndMeta();
            const allEntries = db.scan(keyPrefix, keyEnd, 500000);
            let preKeys = 0;
            let sessions = 0;
            let senderKeys = 0;
            let otherKeys = 0;
            for (const e of allEntries) {
                const sub = e.key.slice(keyPrefix.length);
                if (sub.startsWith('pre-key:')) preKeys++;
                else if (sub.startsWith('session:')) sessions++;
                else if (sub.startsWith('sender-key:')) senderKeys++;
                else otherKeys++;
            }
            return {
                totalKeys: allEntries.length,
                preKeys,
                sessions,
                senderKeys,
                otherKeys,
                dbStats: typeof db.stats === 'function' ? db.stats() : undefined
            };
        });
    };

    const compact = async (threshold = 0) => {
        return mutex.runExclusive(async () => {
            if (!ownsDb) return { compacted: false, oldSizeBytes: 0, newSizeBytes: 0 };
            openDatabases.delete(dbPath);
            if (typeof db.close === 'function') db.close();
            const res = await maybeCompactRoseDB(dbPath, threshold, maxPreKeys);
            const reOpened = await openRoseDB(dbPath, dbOptions);
            Object.assign(db, reOpened);
            keyCache.clear();
            return res;
        });
    };

    if (autoPrune) {
        prune({ maxPreKeys }).catch(() => {});
    }

    const security = {
        createEncryptedBackup,
        restoreEncryptedBackup,
        rotateEncryptionKey,
        verifyIntegrity,
        verifyFingerprint,
        prune,
        compact,
        checkpoint,
        stats,
        clearSession,
        close,
        getLockStatus: () => ({ locked: true, lockPath })
    };
    const state = {
        creds,
        keys
    };
    Object.defineProperty(state, Symbol.for('baileys.authSecurity'), {
        value: security,
        enumerable: false
    });

    return {
        state,
        saveCreds,
        security,
        prune,
        compact,
        checkpoint,
        stats
    };
};

globalThis.useRoseDBAuthState ??= useRoseDBAuthState;

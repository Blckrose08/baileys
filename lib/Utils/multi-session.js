import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Database } from 'rosedb';
import { DisconnectReason } from '../Types/index.js';
import makeWASocket from '../Socket/index.js';
import { useRoseDBAuthState } from './use-rosedb-auth-state.js';

export async function createRoseDBStore(options = {}) {
    const {
        dbPath = './sessions/multi-session.db',
        db: externalDb,
        dbOptions = { sync_on_commit: false },
        defaultOwnerId = 'default',
        defaultEncryptionKey,
        lockDir
    } = options;

    let db = externalDb;
    const ownsDb = !externalDb;
    if (!db) {
        await mkdir(dirname(dbPath), { recursive: true });
        db = new Database(dbPath, dbOptions);
    }

    let destroyed = false;
    const sessionCache = new Map();
    const destroyInflight = new Map();

    const ensureAlive = () => {
        if (destroyed) {
            throw new Error('RoseDB store has been destroyed');
        }
    };

    const session = async (sessionId, sessionOpts = {}) => {
        ensureAlive();
        if (!sessionId || typeof sessionId !== 'string') {
            throw new Error('sessionId must be a non-empty string');
        }
        if (sessionCache.has(sessionId)) {
            return sessionCache.get(sessionId);
        }
        const pending = useRoseDBAuthState({
            sessionId,
            ownerId: sessionOpts.ownerId || defaultOwnerId,
            db,
            dbPath,
            encryptionKey: sessionOpts.encryptionKey || defaultEncryptionKey,
            lockFilePath: sessionOpts.lockFilePath || (lockDir ? `${lockDir}/.${sessionId}.lock` : undefined),
            backupIntervalMs: sessionOpts.backupIntervalMs,
            backupDir: sessionOpts.backupDir
        });
        sessionCache.set(sessionId, pending);
        try {
            const bundle = await pending;
            sessionCache.set(sessionId, bundle);
            return bundle;
        }
        catch (err) {
            sessionCache.delete(sessionId);
            throw err;
        }
    };

    const destroySession = async (sessionId) => {
        if (destroyInflight.has(sessionId)) {
            return destroyInflight.get(sessionId);
        }
        const run = (async () => {
            const entry = sessionCache.get(sessionId);
            sessionCache.delete(sessionId);
            if (!entry) {
                return;
            }
            try {
                const bundle = await entry;
                await bundle.security?.close?.();
            }
            catch { }
        })();
        destroyInflight.set(sessionId, run);
        try {
            await run;
        }
        finally {
            destroyInflight.delete(sessionId);
        }
    };

    const logoutSession = async (sessionId) => {
        const entry = sessionCache.get(sessionId);
        sessionCache.delete(sessionId);
        if (entry) {
            try {
                const bundle = await entry;
                await bundle.security?.clearSession?.();
                return;
            }
            catch { }
        }
        // Fallback if session wasn't loaded in memory
        const prefix = `s:${sessionId}:`;
        const entries = db.scan(prefix, `s:${sessionId};`);
        if (entries.length > 0) {
            db.batch(entries.map(e => ({ op: 'delete', key: e.key })));
        }
    };

    const listLoadedSessions = () => Array.from(sessionCache.keys());

    const listStoredSessions = () => {
        const entries = db.scan('s:', 's;');
        const ids = new Set();
        for (const e of entries) {
            if (e.key.endsWith(':meta')) {
                const id = e.key.slice(2, -5);
                if (id) {
                    ids.add(id);
                }
            }
        }
        return Array.from(ids);
    };

    const destroy = async () => {
        if (destroyed) {
            return;
        }
        destroyed = true;
        const ids = Array.from(sessionCache.keys());
        await Promise.all(ids.map(id => destroySession(id)));
        if (ownsDb && typeof db.close === 'function') {
            db.close();
        }
    };

    return {
        db,
        session,
        destroySession,
        logoutSession,
        listLoadedSessions,
        listStoredSessions,
        destroy
    };
}

export function createMultiSessionManager(options = {}) {
    const {
        store,
        logger,
        socketConfig = {},
        maxSessions = 0,
        autoReconnect = true
    } = options;

    if (!store || typeof store.session !== 'function') {
        throw new Error('A valid RoseDB store from createRoseDBStore() is required');
    }

    const clients = new Map();
    const reconnectTimers = new Map();

    const clearReconnectTimer = (sessionId) => {
        const timer = reconnectTimers.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            reconnectTimers.delete(sessionId);
        }
    };

    const disconnect = async (sessionId) => {
        clearReconnectTimer(sessionId);
        const entry = clients.get(sessionId);
        if (!entry) {
            return;
        }
        entry.manualClose = true;
        clients.delete(sessionId);
        try {
            entry.sock?.ws?.close?.();
        }
        catch { }
    };

    const destroySession = async (sessionId) => {
        await disconnect(sessionId);
        await store.destroySession(sessionId);
    };

    const logout = async (sessionId) => {
        await disconnect(sessionId);
        await store.logoutSession(sessionId);
    };

    const spawn = async (sessionId, spawnOpts = {}) => {
        if (clients.has(sessionId)) {
            return clients.get(sessionId);
        }
        if (maxSessions > 0 && clients.size >= maxSessions) {
            throw new Error(`Maximum concurrent sessions (${maxSessions}) reached`);
        }

        clearReconnectTimer(sessionId);
        const authBundle = await store.session(sessionId, spawnOpts);

        const sock = makeWASocket({
            syncFullHistory: false,
            markOnlineOnConnect: false,
            emitOwnEvents: false,
            ...(logger ? { logger } : {}),
            ...socketConfig,
            ...(spawnOpts.socketConfig || {}),
            auth: authBundle.state
        });

        const entry = {
            sessionId,
            sock,
            auth: authBundle,
            manualClose: false
        };
        clients.set(sessionId, entry);

        sock.ev.on('creds.update', authBundle.saveCreds);

        sock.ev.on('connection.update', async (update) => {
            if (typeof spawnOpts.onConnectionUpdate === 'function') {
                await spawnOpts.onConnectionUpdate(update, entry);
            }
            if (update.connection === 'close' && !entry.manualClose) {
                const statusCode = update.lastDisconnect?.error?.output?.statusCode;
                const { conflict } = sock.security.connection.detectSessionConflict(update.lastDisconnect);
                if (statusCode === DisconnectReason.loggedOut || conflict) {
                    await logout(sessionId);
                    return;
                }
                if (autoReconnect) {
                    const next = sock.security.connection.nextReconnectDelay();
                    if (next.allowed) {
                        clients.delete(sessionId);
                        const timer = setTimeout(() => {
                            reconnectTimers.delete(sessionId);
                            spawn(sessionId, spawnOpts).catch(() => {});
                        }, next.delayMs);
                        if (typeof timer.unref === 'function') {
                            timer.unref();
                        }
                        reconnectTimers.set(sessionId, timer);
                    }
                }
            }
        });

        return entry;
    };

    const destroyAll = async () => {
        const ids = Array.from(clients.keys());
        await Promise.all(ids.map(id => disconnect(id)));
        for (const id of Array.from(reconnectTimers.keys())) {
            clearReconnectTimer(id);
        }
        await store.destroy();
    };

    return {
        store,
        spawn,
        get: (sessionId) => clients.get(sessionId),
        has: (sessionId) => clients.has(sessionId),
        list: () => Array.from(clients.keys()),
        disconnect,
        destroySession,
        logout,
        destroyAll
    };
}

globalThis.createRoseDBStore ??= createRoseDBStore;
globalThis.createMultiSessionManager ??= createMultiSessionManager;

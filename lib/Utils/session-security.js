import { jidDecode } from '../WABinary/index.js';
import { DisconnectReason } from '../Types/index.js';

const SENSITIVE_KEYS = new Set([
    'creds',
    'privateKey',
    'private',
    'advSecretKey',
    'noiseKey',
    'signedIdentityKey',
    'signedPreKey',
    'pairingEphemeralKeyPair',
    'encryptionKey',
    'masterKey',
    'authKey'
]);

const DEFAULT_RECONNECT_POLICY = {
    maxAttempts: 10,
    initialDelay: 1000,
    maxDelay: 60000,
    multiplier: 2,
    jitter: true,
    windowMs: 300000,
    maxReconnectsInWindow: 15,
    connectionTimeoutMs: 30000
};

const DEFAULT_PAIRING_POLICY = {
    cooldownMs: 60000,
    maxAttempts: 5,
    windowMs: 900000
};

const DEFAULT_MESSAGE_POLICY = {
    maxMessageBytes: 1024 * 1024, // 1 MB
    dedupTtlMs: 300000,
    maxDedupEntries: 5000,
    allowedMimeTypes: null,
    blockedMimeTypes: [
        'application/x-msdownload',
        'application/x-sh',
        'application/x-executable'
    ],
    allowedEvents: null,
    blockedEvents: []
};

export function redactCredentials(input, seen = new WeakSet()) {
    if (input === null || input === undefined) {
        return input;
    }
    if (typeof input !== 'object') {
        return input;
    }
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
        return '[REDACTED_BUFFER]';
    }
    if (seen.has(input)) {
        return '[Circular]';
    }
    seen.add(input);
    if (Array.isArray(input)) {
        return input.map(item => redactCredentials(item, seen));
    }
    const output = {};
    for (const [key, value] of Object.entries(input)) {
        if (SENSITIVE_KEYS.has(key)) {
            output[key] = '[REDACTED]';
        }
        else {
            output[key] = redactCredentials(value, seen);
        }
    }
    return output;
}

export function formatSafeError(err) {
    if (!err) {
        return { message: 'Unknown error' };
    }
    if (typeof err === 'string') {
        return { message: err };
    }
    return {
        name: err.name || 'Error',
        message: err.message || 'Unknown error',
        code: err.code || err.output?.statusCode,
        data: err.data ? redactCredentials(err.data) : undefined
    };
}

export function validatePairingCode(code) {
    if (typeof code !== 'string') {
        return false;
    }
    const normalized = code.trim().replace(/-/g, '').toUpperCase();
    return /^[A-Z0-9]{8}$/.test(normalized);
}

export function isValidJidFormat(jid) {
    if (typeof jid !== 'string' || jid.length === 0 || jid.length > 256) {
        return false;
    }
    const decoded = jidDecode(jid);
    if (!decoded || !decoded.user || !decoded.server) {
        return false;
    }
    return ['s.whatsapp.net', 'g.us', 'lid', 'broadcast', 'newsletter', 'hosted', 'hosted.lid', 'call'].includes(decoded.server);
}

export class ConnectionSecurityGuard {
    constructor(options = {}) {
        this.reconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, ...(options.reconnectPolicy || {}) };
        this.pairingPolicy = { ...DEFAULT_PAIRING_POLICY, ...(options.pairingPolicy || {}) };
        this.reconnectAttempts = 0;
        this.reconnectTimestamps = [];
        this.pairingState = new Map();
    }

    resetReconnects() {
        this.reconnectAttempts = 0;
    }

    nextReconnectDelay() {
        const now = Date.now();
        this.reconnectTimestamps = this.reconnectTimestamps.filter(ts => now - ts <= this.reconnectPolicy.windowMs);
        if (this.reconnectAttempts >= this.reconnectPolicy.maxAttempts) {
            return { allowed: false, reason: 'max_reconnect_attempts_exceeded', delayMs: null };
        }
        if (this.reconnectTimestamps.length >= this.reconnectPolicy.maxReconnectsInWindow) {
            return { allowed: false, reason: 'max_reconnects_in_window_exceeded', delayMs: null };
        }
        const expDelay = Math.min(
            this.reconnectPolicy.maxDelay,
            this.reconnectPolicy.initialDelay * Math.pow(this.reconnectPolicy.multiplier, this.reconnectAttempts)
        );
        const delayMs = this.reconnectPolicy.jitter
            ? Math.floor(expDelay * (0.5 + Math.random() * 0.5))
            : expDelay;
        this.reconnectAttempts += 1;
        this.reconnectTimestamps.push(now);
        return {
            allowed: true,
            attempt: this.reconnectAttempts,
            delayMs
        };
    }

    canRequestPairing(accountKey) {
        const key = String(accountKey || 'default');
        const now = Date.now();
        const entry = this.pairingState.get(key) || { attempts: [], lastAttemptAt: 0 };
        entry.attempts = entry.attempts.filter(ts => now - ts <= this.pairingPolicy.windowMs);
        this.pairingState.set(key, entry);

        if (entry.lastAttemptAt && now - entry.lastAttemptAt < this.pairingPolicy.cooldownMs) {
            return {
                allowed: false,
                reason: 'pairing_cooldown',
                retryAfterMs: this.pairingPolicy.cooldownMs - (now - entry.lastAttemptAt)
            };
        }
        if (entry.attempts.length >= this.pairingPolicy.maxAttempts) {
            return {
                allowed: false,
                reason: 'max_pairing_attempts_exceeded',
                retryAfterMs: this.pairingPolicy.windowMs - (now - entry.attempts[0])
            };
        }
        return { allowed: true, retryAfterMs: 0 };
    }

    recordPairingAttempt(accountKey) {
        const check = this.canRequestPairing(accountKey);
        if (!check.allowed) {
            return check;
        }
        const key = String(accountKey || 'default');
        const now = Date.now();
        const entry = this.pairingState.get(key) || { attempts: [], lastAttemptAt: 0 };
        entry.attempts.push(now);
        entry.lastAttemptAt = now;
        this.pairingState.set(key, entry);
        return { allowed: true, attemptsInWindow: entry.attempts.length };
    }

    detectSessionConflict(lastDisconnect) {
        const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
        const conflict = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;
        return {
            conflict,
            statusCode: statusCode ?? null
        };
    }

    async withConnectionTimeout(promise, timeoutMs = this.reconnectPolicy.connectionTimeoutMs) {
        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`Connection timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });
        try {
            return await Promise.race([promise, timeoutPromise]);
        }
        finally {
            clearTimeout(timer);
        }
    }
}

export class MessageSecurityGuard {
    constructor(options = {}) {
        this.policy = { ...DEFAULT_MESSAGE_POLICY, ...options };
        this.seenEvents = new Map();
    }

    validateJid(jid) {
        return isValidJidFormat(jid);
    }

    validateMessageSize(message) {
        if (message === null || message === undefined) {
            return { valid: true, bytes: 0 };
        }
        const serialized = typeof message === 'string' ? message : JSON.stringify(message);
        const bytes = Buffer.byteLength(serialized, 'utf8');
        return {
            valid: bytes <= this.policy.maxMessageBytes,
            bytes,
            maxBytes: this.policy.maxMessageBytes
        };
    }

    isDuplicateEvent(eventId) {
        if (!eventId) {
            return false;
        }
        const now = Date.now();
        for (const [id, ts] of this.seenEvents) {
            if (now - ts > this.policy.dedupTtlMs) {
                this.seenEvents.delete(id);
            }
            else {
                break;
            }
        }
        if (this.seenEvents.has(eventId)) {
            return true;
        }
        if (this.seenEvents.size >= this.policy.maxDedupEntries) {
            const oldestKey = this.seenEvents.keys().next().value;
            if (oldestKey !== undefined) {
                this.seenEvents.delete(oldestKey);
            }
        }
        this.seenEvents.set(eventId, now);
        return false;
    }

    validateMimeType(mimeType) {
        if (!mimeType || typeof mimeType !== 'string') {
            return { valid: false, reason: 'missing_mime_type' };
        }
        const normalized = mimeType.split(';')[0].trim().toLowerCase();
        if (this.policy.blockedMimeTypes?.includes(normalized)) {
            return { valid: false, reason: 'blocked_mime_type', mimeType: normalized };
        }
        if (Array.isArray(this.policy.allowedMimeTypes) && !this.policy.allowedMimeTypes.includes(normalized)) {
            return { valid: false, reason: 'mime_type_not_allowed', mimeType: normalized };
        }
        return { valid: true, mimeType: normalized };
    }

    guardEvent(eventName, payload = {}) {
        if (this.policy.blockedEvents?.includes(eventName)) {
            return { allowed: false, reason: 'event_blocked' };
        }
        if (Array.isArray(this.policy.allowedEvents) && !this.policy.allowedEvents.includes(eventName)) {
            return { allowed: false, reason: 'event_not_allowed' };
        }
        if (payload.jid && !this.validateJid(payload.jid)) {
            return { allowed: false, reason: 'invalid_jid' };
        }
        if (payload.eventId && this.isDuplicateEvent(payload.eventId)) {
            return { allowed: false, reason: 'duplicate_event' };
        }
        if (payload.message !== undefined) {
            const sizeCheck = this.validateMessageSize(payload.message);
            if (!sizeCheck.valid) {
                return { allowed: false, reason: 'message_size_exceeded', bytes: sizeCheck.bytes };
            }
        }
        if (payload.mimeType !== undefined) {
            const mimeCheck = this.validateMimeType(payload.mimeType);
            if (!mimeCheck.valid) {
                return { allowed: false, reason: mimeCheck.reason };
            }
        }
        return { allowed: true };
    }
}

export class ResourceQuotaGuard {
    constructor(options = {}) {
        this.maxRssBytes = options.maxRssBytes || 512 * 1024 * 1024;
        this.maxHeapUsedBytes = options.maxHeapUsedBytes || 384 * 1024 * 1024;
    }

    checkQuota() {
        const usage = process.memoryUsage();
        const rssOk = usage.rss <= this.maxRssBytes;
        const heapOk = usage.heapUsed <= this.maxHeapUsedBytes;
        return {
            ok: rssOk && heapOk,
            rssBytes: usage.rss,
            maxRssBytes: this.maxRssBytes,
            heapUsedBytes: usage.heapUsed,
            maxHeapUsedBytes: this.maxHeapUsedBytes
        };
    }
}

export async function withPanicRecovery(fn, onPanic) {
    try {
        return await fn();
    }
    catch (err) {
        const safeErr = formatSafeError(err);
        if (typeof onPanic === 'function') {
            await onPanic(safeErr);
        }
        return { recovered: true, error: safeErr };
    }
}

export async function runSecurityDiagnostics({ authSecurity, connectionGuard, messageGuard, resourceGuard } = {}) {
    const report = {
        timestamp: new Date().toISOString(),
        encryption: authSecurity ? await authSecurity.verifyIntegrity() : { configured: false },
        fingerprint: authSecurity ? await authSecurity.verifyFingerprint() : { configured: false },
        lock: authSecurity ? authSecurity.getLockStatus() : { locked: false },
        resourceQuota: resourceGuard ? resourceGuard.checkQuota() : new ResourceQuotaGuard().checkQuota(),
        reconnectPolicy: connectionGuard ? connectionGuard.reconnectPolicy : DEFAULT_RECONNECT_POLICY,
        messagePolicy: messageGuard ? messageGuard.policy : DEFAULT_MESSAGE_POLICY
    };
    return redactCredentials(report);
}

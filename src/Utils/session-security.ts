import { jidDecode } from '../WABinary/index.js';
import { DisconnectReason } from '../Types/index.js';

export interface ReconnectPolicy {
    maxAttempts: number;
    initialDelay: number;
    maxDelay: number;
    multiplier: number;
    jitter: boolean;
    windowMs: number;
    maxReconnectsInWindow: number;
    connectionTimeoutMs: number;
}

export interface PairingPolicy {
    cooldownMs: number;
    maxAttempts: number;
    windowMs: number;
}

export interface MessageSecurityPolicy {
    maxMessageBytes: number;
    dedupTtlMs: number;
    maxDedupEntries: number;
    allowedMimeTypes: string[] | null;
    blockedMimeTypes: string[];
    allowedEvents: string[] | null;
    blockedEvents: string[];
}

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

const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
    maxAttempts: 10,
    initialDelay: 1000,
    maxDelay: 60000,
    multiplier: 2,
    jitter: true,
    windowMs: 300000,
    maxReconnectsInWindow: 15,
    connectionTimeoutMs: 30000
};

const DEFAULT_PAIRING_POLICY: PairingPolicy = {
    cooldownMs: 60000,
    maxAttempts: 5,
    windowMs: 900000
};

const DEFAULT_MESSAGE_POLICY: MessageSecurityPolicy = {
    maxMessageBytes: 1024 * 1024,
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

export function redactCredentials<T>(input: T, seen = new WeakSet<object>()): T {
    if (input === null || input === undefined || typeof input !== 'object') {
        return input;
    }
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
        return '[REDACTED_BUFFER]' as unknown as T;
    }
    if (seen.has(input)) {
        return '[Circular]' as unknown as T;
    }
    seen.add(input);
    if (Array.isArray(input)) {
        return input.map(item => redactCredentials(item, seen)) as unknown as T;
    }
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        output[key] = SENSITIVE_KEYS.has(key) ? '[REDACTED]' : redactCredentials(value, seen);
    }
    return output as T;
}

export function formatSafeError(err: unknown): {
    name?: string;
    message: string;
    code?: number | string;
    data?: unknown;
} {
    if (!err) {
        return { message: 'Unknown error' };
    }
    if (typeof err === 'string') {
        return { message: err };
    }
    const e = err as Record<string, any>;
    return {
        name: e.name || 'Error',
        message: e.message || 'Unknown error',
        code: e.code || e.output?.statusCode,
        data: e.data ? redactCredentials(e.data) : undefined
    };
}

export function validatePairingCode(code: string): boolean {
    if (typeof code !== 'string') {
        return false;
    }
    const normalized = code.trim().replace(/-/g, '').toUpperCase();
    return /^[A-Z0-9]{8}$/.test(normalized);
}

export function isValidJidFormat(jid: string): boolean {
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
    reconnectPolicy: ReconnectPolicy;
    pairingPolicy: PairingPolicy;
    private reconnectAttempts = 0;
    private reconnectTimestamps: number[] = [];
    private pairingState = new Map<string, { attempts: number[]; lastAttemptAt: number }>();

    constructor(options: { reconnectPolicy?: Partial<ReconnectPolicy>; pairingPolicy?: Partial<PairingPolicy> } = {}) {
        this.reconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, ...(options.reconnectPolicy || {}) };
        this.pairingPolicy = { ...DEFAULT_PAIRING_POLICY, ...(options.pairingPolicy || {}) };
    }

    resetReconnects(): void {
        this.reconnectAttempts = 0;
    }

    nextReconnectDelay(): { allowed: boolean; attempt?: number; delayMs: number | null; reason?: string } {
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
        return { allowed: true, attempt: this.reconnectAttempts, delayMs };
    }

    canRequestPairing(accountKey = 'default'): { allowed: boolean; reason?: string; retryAfterMs: number } {
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

    recordPairingAttempt(accountKey = 'default') {
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

    detectSessionConflict(lastDisconnect: any): { conflict: boolean; statusCode: number | null } {
        const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
        const conflict = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;
        return { conflict, statusCode: statusCode ?? null };
    }

    async withConnectionTimeout<T>(promise: Promise<T>, timeoutMs = this.reconnectPolicy.connectionTimeoutMs): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Connection timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        try {
            return await Promise.race([promise, timeoutPromise]);
        }
        finally {
            if (timer) clearTimeout(timer);
        }
    }
}

export class MessageSecurityGuard {
    policy: MessageSecurityPolicy;
    private seenEvents = new Map<string, number>();

    constructor(options: Partial<MessageSecurityPolicy> = {}) {
        this.policy = { ...DEFAULT_MESSAGE_POLICY, ...options };
    }

    validateJid(jid: string): boolean {
        return isValidJidFormat(jid);
    }

    validateMessageSize(message: unknown): { valid: boolean; bytes: number; maxBytes: number } {
        if (message === null || message === undefined) {
            return { valid: true, bytes: 0, maxBytes: this.policy.maxMessageBytes };
        }
        const serialized = typeof message === 'string' ? message : JSON.stringify(message);
        const bytes = Buffer.byteLength(serialized, 'utf8');
        return { valid: bytes <= this.policy.maxMessageBytes, bytes, maxBytes: this.policy.maxMessageBytes };
    }

    isDuplicateEvent(eventId: string): boolean {
        if (!eventId) return false;
        const now = Date.now();
        for (const [id, ts] of this.seenEvents) {
            if (now - ts > this.policy.dedupTtlMs) this.seenEvents.delete(id);
            else break;
        }
        if (this.seenEvents.has(eventId)) return true;
        if (this.seenEvents.size >= this.policy.maxDedupEntries) {
            const oldestKey = this.seenEvents.keys().next().value;
            if (oldestKey !== undefined) this.seenEvents.delete(oldestKey);
        }
        this.seenEvents.set(eventId, now);
        return false;
    }

    validateMimeType(mimeType: string): { valid: boolean; reason?: string; mimeType?: string } {
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

    guardEvent(eventName: string, payload: { jid?: string; eventId?: string; message?: unknown; mimeType?: string } = {}) {
        if (this.policy.blockedEvents?.includes(eventName)) return { allowed: false, reason: 'event_blocked' };
        if (Array.isArray(this.policy.allowedEvents) && !this.policy.allowedEvents.includes(eventName)) return { allowed: false, reason: 'event_not_allowed' };
        if (payload.jid && !this.validateJid(payload.jid)) return { allowed: false, reason: 'invalid_jid' };
        if (payload.eventId && this.isDuplicateEvent(payload.eventId)) return { allowed: false, reason: 'duplicate_event' };
        if (payload.message !== undefined) {
            const sizeCheck = this.validateMessageSize(payload.message);
            if (!sizeCheck.valid) return { allowed: false, reason: 'message_size_exceeded', bytes: sizeCheck.bytes };
        }
        if (payload.mimeType !== undefined) {
            const mimeCheck = this.validateMimeType(payload.mimeType);
            if (!mimeCheck.valid) return { allowed: false, reason: mimeCheck.reason };
        }
        return { allowed: true };
    }
}

export class ResourceQuotaGuard {
    maxRssBytes: number;
    maxHeapUsedBytes: number;

    constructor(options: { maxRssBytes?: number; maxHeapUsedBytes?: number } = {}) {
        this.maxRssBytes = options.maxRssBytes || 512 * 1024 * 1024;
        this.maxHeapUsedBytes = options.maxHeapUsedBytes || 384 * 1024 * 1024;
    }

    checkQuota() {
        const usage = process.memoryUsage();
        return {
            ok: usage.rss <= this.maxRssBytes && usage.heapUsed <= this.maxHeapUsedBytes,
            rssBytes: usage.rss,
            maxRssBytes: this.maxRssBytes,
            heapUsedBytes: usage.heapUsed,
            maxHeapUsedBytes: this.maxHeapUsedBytes
        };
    }
}

export async function withPanicRecovery<T>(
    fn: () => Promise<T> | T,
    onPanic?: (error: ReturnType<typeof formatSafeError>) => Promise<void> | void
): Promise<T | { recovered: true; error: ReturnType<typeof formatSafeError> }> {
    try {
        return await fn();
    }
    catch (err) {
        const safeErr = formatSafeError(err);
        if (typeof onPanic === 'function') await onPanic(safeErr);
        return { recovered: true, error: safeErr };
    }
}

export async function runSecurityDiagnostics({ authSecurity, connectionGuard, messageGuard, resourceGuard }: {
    authSecurity?: { verifyIntegrity(): Promise<unknown>; verifyFingerprint(): Promise<unknown>; getLockStatus(): unknown } | null;
    connectionGuard?: ConnectionSecurityGuard;
    messageGuard?: MessageSecurityGuard;
    resourceGuard?: ResourceQuotaGuard;
} = {}) {
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

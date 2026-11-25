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

export declare function redactCredentials<T>(input: T): T;
export declare function formatSafeError(err: unknown): {
    name?: string;
    message: string;
    code?: number | string;
    data?: unknown;
};
export declare function validatePairingCode(code: string): boolean;
export declare function isValidJidFormat(jid: string): boolean;

export declare class ConnectionSecurityGuard {
    reconnectPolicy: ReconnectPolicy;
    pairingPolicy: PairingPolicy;
    constructor(options?: {
        reconnectPolicy?: Partial<ReconnectPolicy>;
        pairingPolicy?: Partial<PairingPolicy>;
    });
    resetReconnects(): void;
    nextReconnectDelay(): {
        allowed: boolean;
        attempt?: number;
        delayMs: number | null;
        reason?: string;
    };
    canRequestPairing(accountKey?: string): {
        allowed: boolean;
        reason?: string;
        retryAfterMs: number;
    };
    recordPairingAttempt(accountKey?: string): {
        allowed: boolean;
        reason?: string;
        retryAfterMs?: number;
        attemptsInWindow?: number;
    };
    detectSessionConflict(lastDisconnect: unknown): {
        conflict: boolean;
        statusCode: number | null;
    };
    withConnectionTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T>;
}

export declare class MessageSecurityGuard {
    policy: MessageSecurityPolicy;
    constructor(options?: Partial<MessageSecurityPolicy>);
    validateJid(jid: string): boolean;
    validateMessageSize(message: unknown): {
        valid: boolean;
        bytes: number;
        maxBytes: number;
    };
    isDuplicateEvent(eventId: string): boolean;
    validateMimeType(mimeType: string): {
        valid: boolean;
        reason?: string;
        mimeType?: string;
    };
    guardEvent(eventName: string, payload?: {
        jid?: string;
        eventId?: string;
        message?: unknown;
        mimeType?: string;
    }): {
        allowed: boolean;
        reason?: string;
        bytes?: number;
    };
}

export declare class ResourceQuotaGuard {
    maxRssBytes: number;
    maxHeapUsedBytes: number;
    constructor(options?: {
        maxRssBytes?: number;
        maxHeapUsedBytes?: number;
    });
    checkQuota(): {
        ok: boolean;
        rssBytes: number;
        maxRssBytes: number;
        heapUsedBytes: number;
        maxHeapUsedBytes: number;
    };
}

export declare function withPanicRecovery<T>(
    fn: () => Promise<T> | T,
    onPanic?: (error: ReturnType<typeof formatSafeError>) => Promise<void> | void
): Promise<T | { recovered: true; error: ReturnType<typeof formatSafeError> }>;

export declare function runSecurityDiagnostics(options?: {
    authSecurity?: {
        verifyIntegrity(): Promise<unknown>;
        verifyFingerprint(): Promise<unknown>;
        getLockStatus(): unknown;
    };
    connectionGuard?: ConnectionSecurityGuard;
    messageGuard?: MessageSecurityGuard;
    resourceGuard?: ResourceQuotaGuard;
}): Promise<Record<string, unknown>>;

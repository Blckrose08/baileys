import { AuthenticationState } from '../Types/index.js';

export interface RoseDBAuthStateOptions {
    sessionId: string;
    ownerId?: string;
    dbPath?: string;
    db?: unknown;
    dbOptions?: Record<string, unknown>;
    encryptionKey: string | Buffer;
    lockFilePath?: string;
    backupIntervalMs?: number;
    backupDir?: string;
    autoPrune?: boolean;
    maxPreKeys?: number;
    checkpointIntervalOps?: number;
    autoCompact?: boolean;
    compactThresholdBytes?: number;
}

export interface RoseDBAuthSecurity {
    createEncryptedBackup(destFile: string): Promise<{ file: string; keyCount: number }>;
    restoreEncryptedBackup(srcFile: string): Promise<{ restoredKeys: number }>;
    rotateEncryptionKey(newEncryptionKey: string | Buffer): Promise<{ keyVersion: number; rotatedKeys: number }>;
    verifyIntegrity(): Promise<{ ok: boolean; configured: boolean; keyVersion?: number; dbCheck?: unknown; error?: string }>;
    verifyFingerprint(): Promise<{ configured: boolean; matched: boolean; note: string }>;
    prune(options?: { maxPreKeys?: number }): Promise<{ prunedPreKeys: number; remainingPreKeys: number }>;
    compact(thresholdBytes?: number): Promise<{ compacted: boolean; oldSizeBytes: number; newSizeBytes: number }>;
    checkpoint(): Promise<void>;
    stats(): Promise<{ totalKeys: number; preKeys: number; sessions: number; senderKeys: number; otherKeys: number; dbStats?: unknown }>;
    clearSession(): Promise<void>;
    close(): Promise<void>;
    getLockStatus(): { locked: boolean; lockPath: string };
}

export declare function getRuntimeFingerprint(sessionId?: string): string;

export declare const useRoseDBAuthState: (options: RoseDBAuthStateOptions) => Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    security: RoseDBAuthSecurity;
    prune: (options?: { maxPreKeys?: number }) => Promise<{ prunedPreKeys: number; remainingPreKeys: number }>;
    compact: (thresholdBytes?: number) => Promise<{ compacted: boolean; oldSizeBytes: number; newSizeBytes: number }>;
    checkpoint: () => Promise<void>;
    stats: () => Promise<{ totalKeys: number; preKeys: number; sessions: number; senderKeys: number; otherKeys: number; dbStats?: unknown }>;
}>;

import { AuthenticationState, ConnectionState, UserFacingSocketConfig } from '../Types/index.js';
import { RoseDBAuthSecurity } from './use-rosedb-auth-state.js';

export interface RoseDBStoreOptions {
    dbPath?: string;
    db?: unknown;
    dbOptions?: Record<string, unknown>;
    defaultOwnerId?: string;
    defaultEncryptionKey?: string | Buffer;
    lockDir?: string;
}

export interface RoseDBSessionBundle {
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    security: RoseDBAuthSecurity;
}

export interface RoseDBStore {
    db: unknown;
    session(sessionId: string, sessionOpts?: {
        ownerId?: string;
        encryptionKey?: string | Buffer;
        lockFilePath?: string;
        backupIntervalMs?: number;
        backupDir?: string;
    }): Promise<RoseDBSessionBundle>;
    destroySession(sessionId: string): Promise<void>;
    logoutSession(sessionId: string): Promise<void>;
    listLoadedSessions(): string[];
    listStoredSessions(): string[];
    destroy(): Promise<void>;
}

export interface ManagedSessionClient {
    sessionId: string;
    sock: any;
    auth: RoseDBSessionBundle;
    manualClose: boolean;
}

export interface MultiSessionManagerOptions {
    store: RoseDBStore;
    logger?: any;
    socketConfig?: Partial<UserFacingSocketConfig>;
    maxSessions?: number;
    autoReconnect?: boolean;
}

export interface MultiSessionManager {
    store: RoseDBStore;
    spawn(sessionId: string, spawnOpts?: {
        ownerId?: string;
        encryptionKey?: string | Buffer;
        lockFilePath?: string;
        socketConfig?: Partial<UserFacingSocketConfig>;
        onConnectionUpdate?: (update: Partial<ConnectionState>, client: ManagedSessionClient) => Promise<void> | void;
    }): Promise<ManagedSessionClient>;
    get(sessionId: string): ManagedSessionClient | undefined;
    has(sessionId: string): boolean;
    list(): string[];
    disconnect(sessionId: string): Promise<void>;
    destroySession(sessionId: string): Promise<void>;
    logout(sessionId: string): Promise<void>;
    destroyAll(): Promise<void>;
}

export declare function createRoseDBStore(options?: RoseDBStoreOptions): Promise<RoseDBStore>;
export declare function createMultiSessionManager(options: MultiSessionManagerOptions): MultiSessionManager;

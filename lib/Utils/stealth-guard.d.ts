export declare const MODE_OFF = 0;
export declare const MODE_ON = 1;
export declare const MODE_WARN = 2;

export type StealthMode = typeof MODE_OFF | typeof MODE_ON | typeof MODE_WARN | number;

export type StealthConfig = {
    threshold: number;
    windowMs: number;
    graceMs: number;
    warmupMs: number;
    maxAgeMs: number;
    cooldownMs: number;
    breakerAuthors: number;
    breakerPauseMs: number;
    noticeEveryMs: number;
    revokeBudgetMs: number;
    commandHint: string;
    reasonPattern: RegExp;
};

export type StealthDeps = {
    getGroup?: (chat: string) => Promise<{ antistealth?: number } | null | undefined> | { antistealth?: number } | null | undefined;
    protectedNumbers?: () => Promise<any[]> | any[];
};

export type StealthRuntimeInfo = {
    readyAt: number;
    warmupLeftMs: number;
};

export type SocketStealthController = {
    MODE_OFF: typeof MODE_OFF;
    MODE_ON: typeof MODE_ON;
    MODE_WARN: typeof MODE_WARN;
    attach: () => any;
    isAttached: () => boolean;
    setMode: (chat: string, mode: StealthMode) => void;
    getMode: (chat: string) => number;
    setDeps: (next: StealthDeps) => StealthDeps;
    getConfig: () => StealthConfig;
    getRuntime: () => StealthRuntimeInfo;
    inspect: (msg: any, upsertType?: string) => Promise<string>;
};

export declare const setStealthMode: (chat: string, mode: StealthMode) => void;
export declare const getStealthMode: (chat: string) => number;
export declare const setStealthDeps: (next: StealthDeps) => StealthDeps;
export declare const __setStealthDeps: typeof setStealthDeps;
export declare const getStealthConfig: () => StealthConfig;
export declare const isStealthAttached: (sock: any) => boolean;
export declare const attachStealthGuard: <T>(sock: T) => T;
export declare const startStealthWatcher: (getSock?: () => any) => void;
export declare const getStealthRuntime: (sock: any) => StealthRuntimeInfo;
export declare const stealthInspect: (sock: any, msg: any, upsertType?: string) => Promise<string>;
export declare const createSocketStealth: (sock: any, autoAttach?: boolean) => SocketStealthController;
export declare const __resetStealthGuard: () => void;

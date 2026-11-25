export type AudioConfig = {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    framesPerChunk: number;
};

export type AudioInputSource = string | Buffer | Uint8Array;

export type CallOptions = {
    to?: string;
    audioSource?: AudioInputSource;
    audio?: AudioInputSource;
    durationMs?: number;
    loop?: boolean;
};

export type CallEvents = {
    ringing: () => void;
    connected: () => void;
    audio: (pcm: Float32Array) => void;
    ended: (reason: string) => void;
    error: (err: Error) => void;
};

export type VoipSdkConfig = {
    authDir?: string;
    sock?: any;
    resourcesPath?: string;
    wasmPath?: string;
    enableLogs?: boolean;
};

export const CallState = {
    Idle: 0,
    Calling: 1,
    PreacceptReceived: 2,
    ReceivedCall: 3,
    AcceptSent: 4,
    AcceptReceived: 5,
    Active: 6,
    ActiveElsewhere: 7,
    Ending: 13
} as const;

export type CallState = (typeof CallState)[keyof typeof CallState];

export type RelayListUpdate = {
    relay_key: string;
    relay_tokens: string[];
    auth_tokens?: string[];
    enable_edgeray_dtls_active_mode?: boolean;
    relays: ReadonlyArray<{
        relay_id: number;
        relay_name: string;
        token_id: number;
        auth_token_id?: number;
        addresses: ReadonlyArray<{
            protocol: number;
            ipv4?: string;
            ipv6?: string;
            port?: number;
            port_v6?: number;
        }>;
    }>;
};

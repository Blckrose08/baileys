import { EventEmitter } from 'node:events';
import { AudioFeeder } from './audio-feeder.js';
import { RelayRtcTransport } from './relay-transport.js';
import { SignalingBridge, type BaileysCallerSocket } from './signaling.js';
import { CallState, type AudioConfig, type AudioInputSource, type CallEvents, type CallOptions, type RelayListUpdate, type VoipSdkConfig } from './types.js';
import { WasmEngine } from './wasm-engine.js';

export type { AudioConfig, AudioInputSource, CallEvents, CallOptions, RelayListUpdate, VoipSdkConfig };
export { AudioFeeder, CallState, RelayRtcTransport, SignalingBridge, WasmEngine };

export declare class ActiveCall extends EventEmitter {
    #private;
    readonly callId: string;
    readonly engine: WasmEngine;
    _audioSource: AudioInputSource;
    _audioLoop: boolean;
    constructor(callId: string, engine: WasmEngine, durationMs: number);
    get state(): CallState;
    end: (reason?: string) => void;
    mute: (muted: boolean) => void;
    waitForEnd: () => Promise<string>;
    _updateState: (state: number) => void;
    _emitAudio: (pcm: Float32Array) => void;
    _forceEnd: (reason: string) => void;
}

export type BaileysCallerOptions = {
    resourcesPath?: string;
    wasmPath?: string;
    enableLogs?: boolean;
};

export declare class BaileysCaller {
    #private;
    constructor(sock: BaileysCallerSocket, options?: BaileysCallerOptions);
    isInitialized: () => boolean;
    getActiveCall: () => ActiveCall | null;
    init: () => Promise<void>;
    call: (targetOrOpts: string | CallOptions, opts?: Omit<CallOptions, 'to'>) => Promise<ActiveCall>;
    endCall: (reason?: string) => void;
    mute: (muted?: boolean) => void;
    destroy: () => void;
}

export declare const createSocketCaller: (sock: BaileysCallerSocket, options?: BaileysCallerOptions) => BaileysCaller;

export declare class VoipClient {
    #private;
    constructor(config?: VoipSdkConfig);
    getSocket: () => any;
    getActiveCall: () => ActiveCall | null;
    connect: () => Promise<void>;
    call: (phoneNumberOrJid: string | CallOptions, opts?: Omit<CallOptions, 'to'>) => Promise<ActiveCall>;
    disconnect: () => void;
}

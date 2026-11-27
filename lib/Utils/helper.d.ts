export declare class A2UI {
    [key: string]: any;
}
export declare class StickerPack {
    [key: string]: any;
}
export declare function sendA2UIWidget(conn: any, jid: string, options?: any): Promise<any>;
export declare function sendAudiosticker(jid: string, audio: string | Buffer, webp: string | Buffer, options?: any): Promise<any>;
export default function makeHelper(conn: any): void;

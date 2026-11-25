<p align="center">
  <img src="https://raw.githubusercontent.com/Blckrose08/baileys/main/Media/banner.png" alt="@blckrose/baileys" width="760" />
</p>

<h1 align="center">@blckrose/baileys</h1>

<p align="center">
  Enhanced WhatsApp Web WebSockets API for Node.js — built on Baileys v7 with encrypted RoséDB auth state, automatic LID→PN resolution, VoIP voice calling (WASM), Anti-Stealth group protection, multi-session manager, and interactive message builders.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@blckrose/baileys"><img src="https://img.shields.io/npm/v/@blckrose/baileys?color=e11d48&label=npm" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-16a34a" alt="Node.js >= 20" />
  <img src="https://img.shields.io/badge/module-ESM-f59e0b" alt="ESM" />
  <img src="https://img.shields.io/badge/license-MIT-3b82f6" alt="License MIT" />
</p>

---

## Features

- **Encrypted RoséDB Auth State**: `useMultiFileAuthState` & `useRoseDBAuthState` store credentials and Signal keys in AES-256-GCM encrypted RoséDB with L1 in-memory caching, atomic batching, and backup/restore.
- **Automatic LID → PN Resolution**: Transparently resolves `@lid` to `@s.whatsapp.net` across incoming messages, mentions, and group metadata while preserving LID routing for group `SenderKeyDistributionMessage`.
- **Session & Connection Security Guards**: Built-in `sock.security` (`ConnectionSecurityGuard`, `MessageSecurityGuard`, `ResourceQuotaGuard`, credential redaction, and `libsignal` log suppression).
- **Multi-Session Manager**: `createRoseDBStore` and `createMultiSessionManager` for running multiple WhatsApp sessions cleanly on a shared encrypted database.
- **VoIP Voice Calling (WASM + WebRTC)**: Built-in `sock.call()` / `sock.caller` and `VoipClient` supporting outbound 1:1 WhatsApp voice calls with MP3/WAV/Buffer audio streaming (`ffmpeg` + `@roamhq/wrtc`).
- **Anti-Stealth Group Protection**: Built-in `sock.stealth` / `attachStealthGuard` detecting invisible/stealth `CIPHERTEXT` sender-key bursts with `OFF` / `WARN` / `ON` modes, grace window, warmup, and circuit breaker.
- **Interactive & Rich Builders**: `Button`, `ButtonV2`, `Carousel`, `AIRich`, `Toolkit`, `StickerPack`, `A2UI`, `sendAlbumMessage`, `cards`, `shop`, `collection`, `pin`, `keep`, `pollResult`, `payment`, `createCallLink`, and full Channel/Newsletter helpers.

---

## Installation

```bash
npm install @blckrose/baileys
```

Or install under the `baileys` alias:

```bash
npm install baileys@npm:@blckrose/baileys
```

---

## Quick Start

```js
import makeWASocket, { useMultiFileAuthState, Browsers } from '@blckrose/baileys'

const { state, saveCreds } = await useMultiFileAuthState('./sessions')

const sock = makeWASocket({
  auth: state,
  browser: Browsers.ubuntu('Chrome')
})

sock.ev.on('creds.update', saveCreds)
```

### VoIP Voice Call

```js
const call = await sock.call('6281234567890', {
  audio: './hello.mp3',
  durationMs: 30000
})

call.on('ringing', () => console.log('Ringing...'))
call.on('connected', () => console.log('Connected!'))
call.on('ended', (reason) => console.log('Ended:', reason))
```

### Anti-Stealth Group Protection

```js
sock.stealth.setMode('120363000000000000@g.us', sock.stealth.MODE_WARN)
```

---

## Disclaimer

This project is not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp or Meta. Use responsibly.

## License

MIT © Blckrosé

<p align="center">
  <img src="https://raw.githubusercontent.com/Blckrose08/baileys/main/Media/banner.png" alt="@blckrose/baileys" width="760" />
</p>

<h1 align="center">@blckrose/baileys</h1>

<p align="center">
  <b>Production-ready, feature-packed WhatsApp Web WebSockets API for Node.js & Bun.</b><br />
  Built on modern Baileys v7 architecture with RoséDB auto-compaction, VoIP WebRTC calling, Anti-Stealth defense, transparent LID resolution, Newsletter auto-follow, and rich interactive builders.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@blckrose/baileys"><img src="https://img.shields.io/npm/v/@blckrose/baileys?color=e11d48&label=npm" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-16a34a" alt="Node.js >= 20" />
  <img src="https://img.shields.io/badge/bun-supported-f472b6" alt="Bun Ready" />
  <img src="https://img.shields.io/badge/module-ESM-f59e0b" alt="ESM" />
  <img src="https://img.shields.io/badge/license-MIT-3b82f6" alt="License MIT" />
</p>

---

## 🚀 Key Highlights

- ⚡ **Auto-Compacting RoséDB Auth State**: Ultra-fast AES-256-GCM encrypted session storage with automatic WAL checkpointing, pre-key pruning, and index slot repair to prevent disk bloat (keeps sessions ~1-2 MB).
- 🔘 **Native Flow Buttons & Interactive Menus**: Full support for WhatsApp Interactive Buttons, Bottom Sheets, List Menus, Copy-Code, URL buttons, and Call buttons via `conn.sendButtons()` and the fluent `Button` builder class.
- 🎠 **Multi-Card Carousel Slider**: Swipeable carousel cards with image/video headers and custom interactive actions per card via `Carousel`.
- 🖼️ **Media Albums Grid**: Group multiple photos and videos into a single cohesive WhatsApp Media Album grid via `conn.sendAlbumMessage()`.
- 🤖 **Meta AI Rich Cards**: Send formatted AI responses with code snippets, tables, citations, and Instagram Reels using `AIRich`.
- 📢 **Full Newsletter / Channels Support**: Create, manage, subscribe, react, and post media/PTVs with full broadcast channel support.
- 📹 **Video Note (PTV) Support**: Native support for circular WhatsApp Video Notes (`ptv: true`) across direct chats, groups, and broadcast channels.
- 📞 **VoIP Voice Calling (WASM + WebRTC)**: Outbound 1:1 WhatsApp voice calling with automated audio streaming (MP3, WAV, PCM buffers) powered by WebRTC and `conn.createCallLink()`.
- 🛡️ **Anti-Stealth Protection**: Built-in `sock.stealth` engine detecting invisible sender-key spam attacks with configurable sensitivity, grace windows, and circuit breakers.
- 🔄 **Transparent LID → Phone Resolution**: Seamlessly decodes and handles `@lid` addresses back to standard phone number JIDs (`@s.whatsapp.net`).

---

## 📦 Installation

```bash
# npm
npm install @blckrose/baileys

# bun
bun add @blckrose/baileys

# yarn / pnpm
yarn add @blckrose/baileys
pnpm add @blckrose/baileys
```

*Tip: You can also alias `@blckrose/baileys` as `baileys`:*
```bash
npm install baileys@npm:@blckrose/baileys
```

---

## ⚡ Quick Start & Authentication

### 1. Pairing Code Authentication (Phone Number)

```javascript
import makeWASocket, { useMultiFileAuthState, Browsers, DisconnectReason } from '@blckrose/baileys'

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./sessions')

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false
  })

  // Request 8-digit Pairing Code
  if (!sock.authState.creds.registered) {
    const phoneNumber = '6281234567890' // Country code + phone number (no + or spaces)
    const code = await sock.requestPairingCode(phoneNumber)
    console.log(`Your Pairing Code: ${code}`)
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('Connection closed, reconnecting:', shouldReconnect)
      if (shouldReconnect) connectToWhatsApp()
    } else if (connection === 'open') {
      console.log('✅ Connected successfully to WhatsApp!')
    }
  })
}

connectToWhatsApp()
```

### 2. RoséDB Storage with Auto-Compaction

Keep session directories lightweight (~1-2 MB) with automated Signal pre-key pruning and WAL compaction:

```javascript
import makeWASocket, { useRoseDBAuthState } from '@blckrose/baileys'

const { state, saveCreds } = await useRoseDBAuthState('./sessions', {
  compactThresholdBytes: 10 * 1024 * 1024, // Compact when database reaches 10MB
  preKeyLimit: 100,                        // Retain 100 freshest Signal pre-keys
  checkpointIntervalOps: 50                // Checkpoint write-ahead log every 50 ops
})

const sock = makeWASocket({ auth: state })
sock.ev.on('creds.update', saveCreds)
```

---

## 🔘 Interactive Buttons & Menus

### 1. `conn.sendButtons()` (List Menus, Bottom Sheet, URLs, & Quick Replies)

Send rich interactive buttons with image/location headers, bottom sheet category drawers, list selections, and external action links:

```javascript
const jid = '6281234567890@s.whatsapp.net'

await sock.sendButtons(jid, {
  image: fs.readFileSync('./banner.jpg'),
  text: `👋 *Welcome to Bot Services!*\nPlease choose an option from the menu below:`,
  footer: 'Powered by @blckrose/baileys',
  messageParams: {
    bottom_sheet: {
      in_thread_buttons_limit: 1,
      list_title: 'Categories',
      button_title: 'Explore Menu'
    }
  },
  buttons: [
    // 1. Interactive List Menu / Selection Drawer
    {
      title: 'Commands',
      sections: [
        {
          title: 'Main Features',
          rows: [
            { title: 'All Commands', description: 'View full bot feature list', id: '.menu all' },
            { title: 'AI Assistant', description: 'Chat with ChatGPT / Claude', id: '.ai' },
            { title: 'Media Downloader', description: 'Download TikTok, IG & YouTube', id: '.dl' }
          ]
        },
        {
          title: 'Information & Support',
          rows: [
            { title: 'Owner Profile', description: 'Contact bot creator', id: '.owner' },
            { title: 'Source Code', description: 'Visit GitHub repository', id: '.script' }
          ]
        }
      ]
    },
    // 2. Direct Web URL Button
    {
      displayText: '🌐 Visit Website',
      url: 'https://github.com/Blckrose08/baileys'
    },
    // 3. One-Tap Copy Code Button
    {
      name: 'cta_copy',
      buttonParamsJson: JSON.stringify({
        display_text: '📋 Copy Redeem Code',
        copy_code: 'PROMO-2026-DISCOUNT'
      })
    },
    // 4. Quick Call Button
    {
      name: 'cta_call',
      buttonParamsJson: JSON.stringify({
        display_text: '📞 Call Support',
        phone_number: '+6281234567890'
      })
    }
  ]
}, { quoted: m })
```

---

### 2. Fluent `Button` Class Builder

Build interactive messages dynamically with method chaining:

```javascript
import { Button } from '@blckrose/baileys'

const button = new Button(sock)

await button
  .setImage('./header.png')
  .setTitle('🚀 Server Status & Management')
  .setSubtitle('Control Panel')
  .setBody('System is operating at 99.98% uptime.\nChoose an action below:')
  .setFooter('System v2.0.11')
  // Quick Reply Buttons
  .addReply('📊 Analytics', '.stats')
  .addReply('🔄 Restart Service', '.restart')
  // External Action Links
  .addUrl('🔗 Dashboard', 'https://status.example.com')
  // Direct Phone Call
  .addCall('📞 Call Admin', '+6281234567890')
  // Copy Code to Clipboard
  .addCopy('🔑 Copy API Key', 'sk_live_9876543210')
  // Dropdown List Selection
  .addSelection('Select Server Node', [
    { title: 'Singapore (SG-01)', description: 'Latency: 18ms', id: '.node sg01' },
    { title: 'Jakarta (JKT-01)', description: 'Latency: 4ms', id: '.node jkt01' },
    { title: 'Tokyo (TYO-01)', description: 'Latency: 65ms', id: '.node tyo01' }
  ])
  .send(jid, { quoted: m })
```

---

### 3. Swipeable Multi-Card `Carousel`

Display product catalogs, portfolios, or multi-item search results in a swipeable slider:

```javascript
import { Carousel } from '@blckrose/baileys'

const carousel = new Carousel(sock)

carousel
  .addCard({
    header: {
      hasMediaAttachment: true,
      imageMessage: await sock.waUploadToServer('./product-1.jpg')
    },
    body: { text: 'Premium Plan - 1 Month\nPrice: $9.99' },
    footer: { text: 'Instant Delivery' },
    nativeFlowMessage: {
      buttons: [
        {
          name: 'quick_reply',
          buttonParamsJson: JSON.stringify({ display_text: 'Buy Plan 1', id: '.order 1' })
        },
        {
          name: 'cta_url',
          buttonParamsJson: JSON.stringify({ display_text: 'Details', url: 'https://example.com/plan1' })
        }
      ]
    }
  })
  .addCard({
    header: {
      hasMediaAttachment: true,
      imageMessage: await sock.waUploadToServer('./product-2.jpg')
    },
    body: { text: 'Enterprise Plan - 1 Year\nPrice: $89.99' },
    footer: { text: 'Priority Support' },
    nativeFlowMessage: {
      buttons: [
        {
          name: 'quick_reply',
          buttonParamsJson: JSON.stringify({ display_text: 'Buy Enterprise', id: '.order 2' })
        }
      ]
    }
  })

const carouselMsg = carousel.build(jid)
await sock.relayMessage(jid, carouselMsg.message, { messageId: carouselMsg.key.id })
```

---

## 🖼️ Media Albums Grid (`conn.sendAlbumMessage`)

Send multiple photos and videos bundled together into a single WhatsApp Album grid:

```javascript
await sock.sendAlbumMessage(jid, [
  { image: fs.readFileSync('./photo1.jpg'), caption: 'First album photo' },
  { image: { url: 'https://example.com/photo2.jpg' }, caption: 'Second album photo' },
  { video: fs.readFileSync('./video.mp4'), caption: 'Album video clip' }
], {
  quoted: m,
  delay: 400 // Interval delay between items
})
```

---

## 🤖 Meta AI Rich Format Cards (`AIRich`)

Send rich AI conversation payloads with markdown, tables, syntax-highlighted code, citations, and video reels:

```javascript
import { AIRich } from '@blckrose/baileys'

const rich = new AIRich(sock)

await rich
  .addText('Here is the explanation you requested:')
  .addCode('python', 'def hello_world():\n    print("Hello from Baileys!")\nhello_world()')
  .addTable([
    ['Feature', 'Status', 'Speed'],
    ['RoséDB Compaction', 'Active', 'Instant'],
    ['VoIP Calling', 'Supported', 'Realtime'],
    ['Video Notes (PTV)', 'Supported', 'Ultra Fast']
  ])
  .addSource([
    { title: 'Official Documentation', url: 'https://github.com/Blckrose08/baileys' },
    { title: 'WhatsApp Web Protocol Spec', url: 'https://whatsapp.com' }
  ])
  .send(jid)
```

---

## 📢 Channels & Newsletters

### Channel Management & Broadcasting
```javascript
const channelJid = '120363000000000000@newsletter'

// Follow / Unfollow
await sock.newsletterFollow(channelJid)
await sock.newsletterUnfollow(channelJid)

// Mute / Unmute
await sock.newsletterMute(channelJid)
await sock.newsletterUnmute(channelJid)

// Post Media to Channel
await sock.sendMessage(channelJid, {
  image: fs.readFileSync('./announcement.png'),
  caption: '📢 Major System Update v2.0.11 is now live!'
})

// Post Video Note (PTV) to Channel
await sock.sendMessage(channelJid, {
  video: fs.readFileSync('./greeting.mp4'),
  ptv: true
})

// React to Channel Posts
await sock.newsletterReactMessage(channelJid, '1234567890', '❤️')
```

---

## 📹 Video Note (PTV / Circular Video)

Send circular WhatsApp Video Notes to direct chats, groups, or channels:

```javascript
await sock.sendMessage(jid, {
  video: fs.readFileSync('./selfie-video.mp4'),
  ptv: true // Renders as circular Video Note
}, { quoted: m })
```

---

## 📞 VoIP Voice Calling (WASM + WebRTC)

Make outbound 1:1 voice calls directly to WhatsApp contacts with custom audio streams:

```javascript
// Start an automated call
const call = await sock.call('6281234567890', {
  audio: './audio/welcome.mp3', // File path, web URL, or PCM Buffer
  durationMs: 45000              // Max duration limit
})

call.on('ringing', () => console.log('🔔 Phone is ringing...'))
call.on('connected', () => console.log('📞 Call connected and audio playing!'))
call.on('ended', (reason) => console.log('📴 Call ended. Reason:', reason))

// Manually hang up
setTimeout(() => {
  call.hangup()
}, 30000)

// Generate Official WhatsApp Call Link (Audio / Video)
const callLink = await sock.createCallLink('audio') // or 'video'
console.log('Join Call:', `https://call.whatsapp.com/voice/${callLink}`)
```

---

## 🛡️ Anti-Stealth Group Defense

Block malicious sender-key bursts designed to crash or overload group chats:

```javascript
const groupJid = '120363000000000000@g.us'

// Modes: MODE_OFF (0), MODE_WARN (1), MODE_ON (2)
sock.stealth.setMode(groupJid, sock.stealth.MODE_ON)

// Listen to security alarms
sock.stealth.on('stealth:burst', ({ jid, sender, burstCount }) => {
  console.warn(`[DEFENSE] Detected stealth attack from ${sender} in ${jid} (${burstCount} packets)`)
  // Auto-kick attacker:
  sock.groupParticipantsUpdate(jid, [sender], 'remove')
})
```

---

## 💬 Basic Messages & Media

```javascript
// Text Message
await sock.sendMessage(jid, { text: 'Hello World!' })

// Mentions
await sock.sendMessage(jid, {
  text: 'Hello @6281234567890',
  mentions: ['6281234567890@s.whatsapp.net']
})

// Photo / Image
await sock.sendMessage(jid, {
  image: fs.readFileSync('./image.png'),
  caption: 'Sample photo'
})

// Voice Note (PTT)
await sock.sendMessage(jid, {
  audio: fs.readFileSync('./audio.mp3'),
  mimetype: 'audio/mp4',
  ptt: true
})

// Document
await sock.sendMessage(jid, {
  document: fs.readFileSync('./document.pdf'),
  mimetype: 'application/pdf',
  fileName: 'Contract.pdf'
})

// Emoji Reaction
await sock.sendMessage(jid, {
  react: { text: '🔥', key: m.key }
})

// Interactive Poll
await sock.sendMessage(jid, {
  poll: {
    name: 'Favorite Runtime?',
    values: ['Node.js', 'Bun', 'Deno'],
    selectableCount: 1
  }
})
```

---

## 👥 Group Management

```javascript
const groupJid = '120363000000000000@g.us'

// Create Group
const group = await sock.groupCreate('My Bot Group', ['6281234567890@s.whatsapp.net'])

// Metadata
const meta = await sock.groupMetadata(groupJid)

// Add / Remove / Promote / Demote
await sock.groupParticipantsUpdate(groupJid, ['6281234567890@s.whatsapp.net'], 'add')
await sock.groupParticipantsUpdate(groupJid, ['6281234567890@s.whatsapp.net'], 'promote')
await sock.groupParticipantsUpdate(groupJid, ['6281234567890@s.whatsapp.net'], 'remove')

// Invite Link
const code = await sock.groupInviteCode(groupJid)
console.log('Join URL:', `https://chat.whatsapp.com/${code}`)
```

---

## ⚙️ Configuration Reference

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `auth` | `AuthenticationState` | **Required** | Auth state from `useMultiFileAuthState` or `useRoseDBAuthState`. |
| `browser` | `WABrowserDescription` | `Browsers.macOS('Chrome')` | Linked device identity shown in WhatsApp. |
| `printQRInTerminal` | `boolean` | `false` | Displays terminal QR code. |
| `markOnlineOnConnect`| `boolean` | `true` | Updates presence to online immediately after connecting. |
| `syncFullHistory` | `boolean` | `true` | Fetches full conversation history on initial sync. |
| `connectTimeoutMs` | `number` | `20000` | Socket handshake timeout (ms). |
| `keepAliveIntervalMs`| `number` | `30000` | Ping-pong keep-alive interval (ms). |
| `logger` | `ILogger` | `Pino Logger` | Custom logger instance. |

---

## ⚠️ Disclaimer

This project is an open-source reverse-engineering of the WhatsApp Web protocol. It is **not** officially affiliated with, authorized, maintained, or endorsed by WhatsApp, Meta, or any of its subsidiaries. Use responsibly and adhere to WhatsApp's Terms of Service.

---

## 📄 License

Published under the [MIT License](LICENSE).  
Maintained with ❤️ by **Blckrosé**.

# OTPZ iMessage Bridge Server

A local Node.js server that watches your iMessages for OTP codes and pushes them to the OTPZ Chrome extension in real time.

## Requirements

- **macOS** (iMessages are stored locally on macOS only)
- **Node.js 18+** ([download](https://nodejs.org/))
- **Full Disk Access** for Terminal (to read `~/Library/Messages/chat.db`)
- **Messages in iCloud** enabled on your iPhone

## Quick Start

```bash
cd server
npm install
node server.js
```

Or use the startup script:

```bash
./start.sh
```

## Granting Full Disk Access

1. Open **System Settings → Privacy & Security → Full Disk Access**
2. Click **"+"** and add your terminal app (Terminal, iTerm, Warp, etc.)
3. Restart the server

## How It Works

1. The server uses [imessage-kit](https://github.com/photon-hq/imessage-kit) to monitor `~/Library/Messages/chat.db` for new messages (polls every 2 seconds)
2. When a new SMS/iMessage arrives, it runs OTP extraction regex to detect verification codes
3. Detected OTPs are pushed to connected Chrome extension clients over WebSocket (`ws://127.0.0.1:7483`)
4. The extension displays iMessage OTPs alongside Gmail OTPs with a 💬 source badge

## Endpoints

| Endpoint | Description |
|---|---|
| `ws://127.0.0.1:7483` | WebSocket — real-time OTP push |
| `GET http://127.0.0.1:7483/health` | Health check |
| `GET http://127.0.0.1:7483/otps` | List active OTPs (for debugging) |

## Configuration

Set the port via environment variable:

```bash
OTPZ_PORT=8080 node server.js
```

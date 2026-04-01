# OTPZ Companion Server

A local Node.js server that watches your iMessages and SMS for OTP codes and pushes them to the OTPZ Chrome extension in real time over WebSocket.

## Requirements

- **macOS** (iMessages are stored locally on macOS only)
- **Node.js 18+** ([download](https://nodejs.org/))
- **Full Disk Access** for your terminal app (required to read `~/Library/Messages/chat.db`)
- **Messages in iCloud** enabled on your iPhone (so texts sync to your Mac)

## Quick Start

```bash
cd server
npm install
npm start
```

> **Got a "Cannot find package" error?** You need to run `npm install` first — dependencies are not included in the repository.

## Granting Full Disk Access

1. Open **System Settings → Privacy & Security → Full Disk Access**
2. Click **"+"** and add your terminal app (Terminal, iTerm, Warp, etc.)
3. Restart the terminal and run the server again

## How It Works

1. The server polls Apple's `chat.db` SQLite database every 2 seconds using a **10-minute sliding window** — this ensures OTPs are never missed, even after your Mac wakes from sleep and syncs delayed iCloud messages
2. When a new SMS/iMessage arrives, it runs OTP extraction to detect verification codes (4–8 digit numeric, 4–10 character alphanumeric)
3. Detected OTPs are broadcast to connected Chrome extension clients over WebSocket (`ws://127.0.0.1:7483`)
4. The extension displays iMessage OTPs alongside Gmail OTPs with a 💬 source badge

## Endpoints

| Endpoint | Description |
|---|---|
| `ws://127.0.0.1:7483` | WebSocket — real-time OTP push |
| `GET /health` | Health check |
| `GET /otps` | List active OTPs (useful for debugging) |

## Configuration

Set the port via environment variable:

```bash
OTPZ_PORT=8080 npm start
```

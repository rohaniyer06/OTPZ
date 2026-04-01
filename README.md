# OTPZ — Smart OTP Manager (Chrome Extension)

A Chrome extension that automatically retrieves and autofills one-time passwords from **Gmail** and **Apple iMessage/SMS**, eliminating the need to check your phone or switch tabs during multi-factor authentication.

## Features

- **📧 Gmail OTPs** — Fetches OTP codes from recent unread emails via the Gmail API
- **💬 iMessage/SMS OTPs** *(macOS only)* — Reads OTP codes from your Mac's Messages database in real time via a lightweight local server
- **⚡ Autofill** — Injects codes directly into the active tab's OTP input fields (single box or per-digit)
- **📋 One-Click Copy** — Copy any code to your clipboard instantly
- **🔒 Privacy-First** — All processing happens locally; no data is sent to external servers

## How It Works

The extension has two OTP sources:

1. **Gmail:** Uses Chrome's Identity API with OAuth to query the Gmail API for recent emails containing verification codes. Everything runs in the browser.
2. **iMessage/SMS:** A local Node.js companion server watches Apple's `chat.db` database on your Mac for incoming text messages. Detected OTPs are pushed to the extension over WebSocket in real time.

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/rohaniyer06/OTPZ.git
```

### 2. Load the Extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `OTPZ/` folder
4. Copy your **Extension ID** from the card that appears

### 3. Create a Google OAuth Client

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. **APIs & Services → Library** → search for and enable the **Gmail API**
4. **APIs & Services → OAuth consent screen**:
   - Go to **Audience** → **Test Users**
   - Add your Gmail address under **Test users**
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Chrome extension**
   - **Application ID** = the Extension ID from step 2
   - Copy the generated **Client ID**

### 4. Configure the Manifest

1. Copy `manifest.example.json` to `manifest.json`:
   ```bash
   cp manifest.example.json manifest.json
   ```
2. Open `manifest.json` and replace the `client_id` in the `oauth2` block:
   ```json
   "oauth2": {
     "client_id": "YOUR_CLIENT_ID_HERE",
     "scopes": ["https://www.googleapis.com/auth/gmail.readonly"]
   }
   ```
3. Back in `chrome://extensions`, **remove** the extension and **Load unpacked** again (Chrome caches the `oauth2` block on install)

### 5. Use It

Click the OTPZ icon in Chrome → approve the Google sign-in once → recent Gmail OTPs appear. Use **Autofill** or **Copy**.

### 6. Enable iMessage OTPs *(macOS only, optional)*

See [server/README.md](server/README.md) for setup instructions. Once the companion server is running:

1. Click the ⚙️ gear icon in the extension
2. Toggle **iMessage OTPs** on
3. A green "Connected" indicator confirms the link

## Privacy & Security

- Requests only **Gmail read-only** scope — cannot modify or delete emails
- Authentication handled entirely by Chrome's Identity API; no secrets stored in the repo
- The iMessage server runs **locally** on `127.0.0.1` and never exposes data to the network
- `manifest.json` is gitignored to protect your OAuth client ID

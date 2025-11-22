# OTPZ (Chrome Extension)

Prototype extension that pulls recent OTP codes from your Gmail and lets you **Copy**, **Autofill**, or **Hide** them in a simple popup.  
*Preparing for Chrome Web Store. Until then, you can run it locally via “Load unpacked.”*

## Features
- **Gmail read-only** integration via Chrome Identity API
- **OTP extraction** (4–8 digits; matches “OTP”, “verification code”, “security code”, etc.)
- **Autofill** into the active tab + **Copy** as a fallback
- Minimal, responsive popup with loading and refresh

## How it works
- Uses `chrome.identity.getAuthToken` with an **OAuth client of type “Chrome extension.”**
- Queries Gmail for recent messages that look like OTP emails and extracts 4–8 digit codes.
- Autofill targets common OTP fields (single input or per-digit boxes).
- Tokens are handled by Chrome; no client secrets are stored in the repo.

## Quickstart 

1. **Get the code**
   - **Git:** `git clone https://github.com/rohaniyer06/OTPZ.git`
   - **Or** download ZIP from GitHub → **Extract** → open the extracted folder.

2. **Load the extension**
   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** → select the **`otpz/`** folder 
   - Copy your **Extension ID** from the card

3. **Create a Google OAuth client (Chrome App)**
   - Google Cloud Console → create/select a project
   - **APIs & Services → Library** → enable **Gmail API**
   - **OAuth consent screen**: *External* → *Testing* → add your Gmail under **Test users**
   - **Credentials → Create credentials → OAuth client ID → Chrome extension**
     - **Application ID** = your **Extension ID** from step 2
     - Copy the generated **client_id**

4. **Add the client ID to the manifest**
   - Edit `otpz/manifest.json` and set:
     ```json
     {
       "oauth2": {
         "client_id": "YOUR_CLIENT_ID",  <- (should end in: apps.googleusercontent.com)
         "scopes": ["https://www.googleapis.com/auth/gmail.readonly"]
       }
     }
     ```
   - Back in `chrome://extensions`, **Remove** the extension and **Load unpacked** again  
     *(Chrome caches the oauth2 block on install).*

5. **Use it**
   - Click the extension → approve once → recent OTPs appear. Use **Autofill**, **Copy**, or **Hide**.

## Privacy & Security
- Requests only **Gmail read-only** scope.
- Authentication handled by Chrome Identity; no secrets committed.
- All processing happens locally; only Gmail API calls leave your browser.

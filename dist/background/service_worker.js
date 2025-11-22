// background/service_worker.js (MV3, module)
import { fetchOtpsFromGmail } from "../services/gmail.js";

// Storage keys
const COPIED_OTPS_KEY = 'copiedOtps';
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes in milliseconds

/* ---------- Auth helpers ---------- */

// Silent attempt: resolve null on failure (do NOT throw) to avoid noisy errors.
function getAuthTokenSilent() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) return resolve(null);
      resolve(token);
    });
  });
}

// Interactive attempt: if user cancels/denies, resolve null (do NOT throw).
function getAuthTokenInteractive() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      const err = chrome.runtime.lastError;
      if (err) {
        // Handle the common cancel/deny path quietly
        if (/user did not approve access/i.test(err.message)) return resolve(null);
        // Anything else is a real error
        return reject(err);
      }
      resolve(token || null);
    });
  });
}

// Remove a cached token so Chrome will fetch/refresh a new one.
function removeCachedAuthToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

// Get a token: try silent first, then interactive. If user canceled, signal back to popup.
async function getTokenSmart() {
  const silent = await getAuthTokenSilent();
  if (silent) return silent;
  const interactive = await getAuthTokenInteractive();
  if (interactive) return interactive;

  // User canceled or closed the dialog.
  const e = new Error("Sign-in was canceled by the user.");
  e.code = "auth_canceled";
  throw e;
}

/* ---------- Request wrapper ---------- */

function isUnauthorized(e) {
  const s = String(e?.message || e || "");
  return s.includes("401") || /unauthori[zs]ed/i.test(s);
}

// Run a Gmail call with auto token (retry once on 401 after clearing cache)
async function withGmailToken(run) {
  let token = await getTokenSmart(); // may throw with code=auth_canceled
  try {
    return await run(token);
  } catch (e) {
    if (isUnauthorized(e)) {
      await removeCachedAuthToken(token);
      token = await getTokenSmart();
      return await run(token);
    }
    throw e;
  }
}

/* ---------- Message handling ---------- */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_OTPS") {
    (async () => {
      try {
        // Get fresh OTPs from Gmail
        const freshOtps = await withGmailToken((token) => fetchOtpsFromGmail(token));
        
        // Get already copied OTPs from storage
        const result = await chrome.storage.local.get(COPIED_OTPS_KEY);
        const copiedOtps = new Set(result[COPIED_OTPS_KEY] || []);
        const now = Date.now();
        
        // Filter OTPs: remove copied ones and those older than 10 minutes
        const filteredOtps = freshOtps.filter(otp => 
          !copiedOtps.has(otp.code) && 
          (now - otp.dateMs) < OTP_TTL_MS
        );
        
        // Add timestamp to each OTP
        const otpsWithTimestamp = filteredOtps.map(otp => ({
          ...otp,
          timestamp: now
        }));
        
        sendResponse({ ok: true, otps: otpsWithTimestamp });
      } catch (err) {
        if (err?.code === "auth_canceled") {
          // Graceful: tell popup the user canceled so it can show a friendly prompt
          return sendResponse({ ok: false, error: "Sign-in canceled", error_code: "auth_canceled" });
        }
        console.error("[GET_OTPS] error:", err?.message || err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true; // async
  }

  // Handle marking an OTP as copied
  if (message?.type === "OTP_COPIED" && message?.code) {
    (async () => {
      try {
        const result = await chrome.storage.local.get(COPIED_OTPS_KEY);
        const copiedOtps = new Set(result[COPIED_OTPS_KEY] || []);
        copiedOtps.add(message.code);
        await chrome.storage.local.set({ [COPIED_OTPS_KEY]: Array.from(copiedOtps) });
        sendResponse({ ok: true });
      } catch (e) {
        console.error('Failed to mark OTP as copied:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // Keep the message channel open for async response
  }

  // Optional: explicit "Sign in" action the popup can trigger to re-open consent
  if (message?.type === "SIGN_IN") {
    (async () => {
      try {
        const token = await getAuthTokenInteractive();
        if (!token) return sendResponse({ ok: false, error: "Sign-in canceled", error_code: "auth_canceled" });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
});

/* ---------- One-time cleanup from old implementation ---------- */
chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.storage.local.remove(["oauth_token", "oauth_token_expiry"]); } catch {}
});


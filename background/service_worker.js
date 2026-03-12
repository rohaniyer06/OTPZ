// background/service_worker.js (MV3, module)
import { fetchOtpsFromGmail } from "../services/gmail.js";

// Storage keys
const COPIED_OTPS_KEY = 'copiedOtps';
const IMESSAGE_ENABLED_KEY = 'imessageEnabled';
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

/* ========== Auth helpers (Gmail) ========== */

function getAuthTokenSilent() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) return resolve(null);
      resolve(token);
    });
  });
}

function getAuthTokenInteractive() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      const err = chrome.runtime.lastError;
      if (err) {
        if (/user did not approve access/i.test(err.message)) return resolve(null);
        return reject(err);
      }
      resolve(token || null);
    });
  });
}

function removeCachedAuthToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function getTokenSmart() {
  const silent = await getAuthTokenSilent();
  if (silent) return silent;
  const interactive = await getAuthTokenInteractive();
  if (interactive) return interactive;

  const e = new Error("Sign-in was canceled by the user.");
  e.code = "auth_canceled";
  throw e;
}

function isUnauthorized(e) {
  const s = String(e?.message || e || "");
  return s.includes("401") || /unauthori[zs]ed/i.test(s);
}

async function withGmailToken(run) {
  let token = await getTokenSmart();
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

/* ========== iMessage WebSocket Client ========== */

const IMESSAGE_WS_URL = "ws://127.0.0.1:7483";
const IMESSAGE_HEALTH_URL = "http://127.0.0.1:7483/health";

let ws = null;
let wsReconnectTimer = null;
let wsReconnectDelay = 1000; // Start at 1s, exponential backoff
const WS_MAX_RECONNECT_DELAY = 30000;
let imessageOtps = []; // OTPs received from the bridge server
let imessageConnected = false;

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return; // Already connected or connecting
  }

  try {
    ws = new WebSocket(IMESSAGE_WS_URL);

    ws.onopen = () => {
      console.log("[iMessage] WebSocket connected");
      imessageConnected = true;
      wsReconnectDelay = 1000; // Reset backoff on successful connect
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "OTP") {
          // New OTP from bridge server
          const otp = {
            code: data.code,
            subject: data.senderName || data.sender || "iMessage",
            from: data.sender || "",
            dateMs: data.dateMs || Date.now(),
            source: "imessage",
            service: data.service || "SMS",
          };
          // Deduplicate
          if (!imessageOtps.some((o) => o.code === otp.code)) {
            imessageOtps.push(otp);
            cleanupImessageOtps();
          }
        } else if (data.type === "SYNC") {
          // Full sync on connect — replace all
          imessageOtps = (data.otps || []).map((o) => ({
            code: o.code,
            subject: o.senderName || o.sender || "iMessage",
            from: o.sender || "",
            dateMs: o.dateMs || Date.now(),
            source: "imessage",
            service: o.service || "SMS",
          }));
          cleanupImessageOtps();
        }
      } catch (e) {
        console.error("[iMessage] Failed to parse WS message:", e);
      }
    };

    ws.onclose = () => {
      console.log("[iMessage] WebSocket disconnected");
      imessageConnected = false;
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error("[iMessage] WebSocket error");
      imessageConnected = false;
    };
  } catch (e) {
    console.error("[iMessage] Failed to create WebSocket:", e);
    imessageConnected = false;
    scheduleReconnect();
  }
}

function wsDisconnect() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = null;
  if (ws) {
    ws.close();
    ws = null;
  }
  imessageConnected = false;
  imessageOtps = [];
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsConnect();
    // Exponential backoff
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_DELAY);
  }, wsReconnectDelay);
}

function cleanupImessageOtps() {
  const cutoff = Date.now() - OTP_TTL_MS;
  imessageOtps = imessageOtps.filter((o) => o.dateMs > cutoff);
}

// Check health endpoint (used by popup for status display)
async function checkImessageHealth() {
  try {
    const res = await fetch(IMESSAGE_HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json();
      return { ok: true, ...data, wsConnected: imessageConnected };
    }
    return { ok: false, wsConnected: false };
  } catch {
    return { ok: false, wsConnected: false };
  }
}

// Initialize iMessage connection based on stored preference
async function initImessage() {
  const result = await chrome.storage.local.get(IMESSAGE_ENABLED_KEY);
  if (result[IMESSAGE_ENABLED_KEY]) {
    wsConnect();
  }
}

/* ========== Message handling ========== */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_OTPS") {
    (async () => {
      try {
        // Get fresh OTPs from Gmail
        const freshOtps = await withGmailToken((token) => fetchOtpsFromGmail(token));

        // Tag Gmail OTPs with source
        const gmailOtps = freshOtps.map((o) => ({ ...o, source: "gmail" }));

        // Get already copied OTPs from storage
        const result = await chrome.storage.local.get(COPIED_OTPS_KEY);
        const copiedOtps = new Set(result[COPIED_OTPS_KEY] || []);
        const now = Date.now();

        // Merge Gmail + iMessage OTPs
        cleanupImessageOtps();
        const allOtps = [...gmailOtps, ...imessageOtps];

        // Filter: remove copied ones and those older than TTL
        const filteredOtps = allOtps.filter(
          (otp) => !copiedOtps.has(otp.code) && now - otp.dateMs < OTP_TTL_MS
        );

        // De-dupe by code (prefer most recent)
        const byCode = new Map();
        for (const otp of filteredOtps) {
          const prev = byCode.get(otp.code);
          if (!prev || otp.dateMs > prev.dateMs) byCode.set(otp.code, otp);
        }

        // Sort by recency
        const finalOtps = Array.from(byCode.values())
          .sort((a, b) => b.dateMs - a.dateMs)
          .map((otp) => ({ ...otp, timestamp: now }));

        sendResponse({ ok: true, otps: finalOtps });
      } catch (err) {
        if (err?.code === "auth_canceled") {
          return sendResponse({ ok: false, error: "Sign-in canceled", error_code: "auth_canceled" });
        }
        console.error("[GET_OTPS] error:", err?.message || err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // Handle marking an OTP as copied
  if (message?.type === "OTP_COPIED" && message?.code) {
    (async () => {
      try {
        const result = await chrome.storage.local.get(COPIED_OTPS_KEY);
        const copiedOtps = new Set(result[COPIED_OTPS_KEY] || []);
        copiedOtps.add(message.code);
        await chrome.storage.local.set({ [COPIED_OTPS_KEY]: Array.from(copiedOtps) });
        // Also remove from iMessage OTPs in memory
        imessageOtps = imessageOtps.filter((o) => o.code !== message.code);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('Failed to mark OTP as copied:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // Sign in
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

  // iMessage toggle
  if (message?.type === "IMESSAGE_SET_ENABLED") {
    (async () => {
      const enabled = !!message.enabled;
      await chrome.storage.local.set({ [IMESSAGE_ENABLED_KEY]: enabled });
      if (enabled) {
        wsConnect();
      } else {
        wsDisconnect();
      }
      sendResponse({ ok: true, enabled });
    })();
    return true;
  }

  // iMessage status check
  if (message?.type === "IMESSAGE_STATUS") {
    (async () => {
      const storageResult = await chrome.storage.local.get(IMESSAGE_ENABLED_KEY);
      const enabled = !!storageResult[IMESSAGE_ENABLED_KEY];
      const health = enabled ? await checkImessageHealth() : { ok: false, wsConnected: false };
      sendResponse({
        ok: true,
        enabled,
        serverRunning: health.ok,
        wsConnected: health.wsConnected || imessageConnected,
      });
    })();
    return true;
  }
});

/* ========== Startup ========== */

chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.storage.local.remove(["oauth_token", "oauth_token_expiry"]); } catch { }
});

// Initialize iMessage connection on service worker startup
initImessage();

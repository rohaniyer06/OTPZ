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
const IMESSAGE_OTPS_URL = "http://127.0.0.1:7483/otps";
const KEEPALIVE_ALARM_NAME = "otpz-imessage-keepalive";
const KEEPALIVE_INTERVAL_MINUTES = 0.4; // ~24 seconds — below the 30s suspend threshold

let ws = null;
let wsReconnectTimer = null;
let wsReconnectDelay = 1000;
const WS_MAX_RECONNECT_DELAY = 30000;
let imessageOtps = [];
let imessageConnected = false;

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    ws = new WebSocket(IMESSAGE_WS_URL);

    ws.onopen = () => {
      console.log("[iMessage] WebSocket connected");
      imessageConnected = true;
      wsReconnectDelay = 1000;
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "OTP") {
          const otp = {
            code: data.code,
            subject: data.senderName || data.sender || "iMessage",
            from: data.sender || "",
            dateMs: data.dateMs || Date.now(),
            source: "imessage",
            service: data.service || "SMS",
          };
          if (!imessageOtps.some((o) => o.code === otp.code)) {
            imessageOtps.push(otp);
            cleanupImessageOtps();
          }
        } else if (data.type === "SYNC") {
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

    ws.onerror = () => {
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
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_DELAY);
  }, wsReconnectDelay);
}

function cleanupImessageOtps() {
  const cutoff = Date.now() - OTP_TTL_MS;
  imessageOtps = imessageOtps.filter((o) => o.dateMs > cutoff);
}

/* ========== Keepalive & HTTP Fallback ========== */

// Chrome.alarms keepalive: fires every ~24 seconds to prevent the
// service worker from being suspended while iMessage is enabled.
// On each tick we also do an HTTP poll to /otps as a fallback
// to catch any OTPs missed during a brief WebSocket gap.

async function startKeepalive() {
  await chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
    periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
  });
  console.log("[iMessage] Keepalive alarm started");
}

async function stopKeepalive() {
  await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
  console.log("[iMessage] Keepalive alarm stopped");
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME) return;

  // 1. Ensure WebSocket is alive
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    wsConnect();
  }

  // 2. HTTP fallback poll — catch anything missed during disconnects
  fetchImessageOtpsHttp().catch(() => { });
});

async function fetchImessageOtpsHttp() {
  try {
    const res = await fetch(IMESSAGE_OTPS_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.otps)) return;

    for (const o of data.otps) {
      const otp = {
        code: o.code,
        subject: o.senderName || o.sender || "iMessage",
        from: o.sender || "",
        dateMs: o.dateMs || Date.now(),
        source: "imessage",
        service: o.service || "SMS",
      };
      if (!imessageOtps.some((existing) => existing.code === otp.code)) {
        imessageOtps.push(otp);
      }
    }
    cleanupImessageOtps();
  } catch {
    // Server not reachable — that's fine, degrade gracefully
  }
}

// Health check (used by popup for status display)
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
    startKeepalive();
  }
}

/* ========== Message handling ========== */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_OTPS") {
    (async () => {
      try {
        const freshOtps = await withGmailToken((token) => fetchOtpsFromGmail(token));
        const gmailOtps = freshOtps.map((o) => ({ ...o, source: "gmail" }));

        const result = await chrome.storage.local.get(COPIED_OTPS_KEY);
        const copiedOtps = new Set(result[COPIED_OTPS_KEY] || []);
        const now = Date.now();

        cleanupImessageOtps();
        const allOtps = [...gmailOtps, ...imessageOtps];

        const filteredOtps = allOtps.filter(
          (otp) => !copiedOtps.has(otp.code) && now - otp.dateMs < OTP_TTL_MS
        );

        const byCode = new Map();
        for (const otp of filteredOtps) {
          const prev = byCode.get(otp.code);
          if (!prev || otp.dateMs > prev.dateMs) byCode.set(otp.code, otp);
        }

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

  if (message?.type === "OTP_COPIED" && message?.code) {
    (async () => {
      try {
        const result = await chrome.storage.local.get(COPIED_OTPS_KEY);
        const copiedOtps = new Set(result[COPIED_OTPS_KEY] || []);
        copiedOtps.add(message.code);
        await chrome.storage.local.set({ [COPIED_OTPS_KEY]: Array.from(copiedOtps) });
        imessageOtps = imessageOtps.filter((o) => o.code !== message.code);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('Failed to mark OTP as copied:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

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

  if (message?.type === "IMESSAGE_SET_ENABLED") {
    (async () => {
      const enabled = !!message.enabled;
      await chrome.storage.local.set({ [IMESSAGE_ENABLED_KEY]: enabled });
      if (enabled) {
        wsConnect();
        startKeepalive();
      } else {
        wsDisconnect();
        stopKeepalive();
      }
      sendResponse({ ok: true, enabled });
    })();
    return true;
  }

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

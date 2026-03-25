// background/service_worker.js (MV3, module)
import { fetchOtpsFromGmail } from "../services/gmail.js";

// Storage keys
const COPIED_OTPS_KEY = 'copiedOtps';
const IMESSAGE_ENABLED_KEY = 'imessageEnabled';
const IMESSAGE_OTPS_KEY = 'imessageOtps'; // Persisted across SW restarts
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

/* ========== iMessage — Offscreen Document Management ========== */
// The WebSocket connection lives in the offscreen document, which is NOT
// subject to Chrome's 30-second service worker suspension. The offscreen
// doc forwards OTP data to us via chrome.runtime messaging.

const IMESSAGE_HEALTH_URL = "http://127.0.0.1:7483/health";
const IMESSAGE_OTPS_URL = "http://127.0.0.1:7483/otps";
const KEEPALIVE_ALARM_NAME = "otpz-imessage-keepalive";
const KEEPALIVE_INTERVAL_MINUTES = 0.5; // 30 seconds

let imessageOtps = [];
let imessageConnected = false;

/* ========== OTP Persistence ========== */

async function persistOtps() {
  try {
    await chrome.storage.local.set({ [IMESSAGE_OTPS_KEY]: imessageOtps });
  } catch (e) {
    console.error("[iMessage] Failed to persist OTPs:", e);
  }
}

async function restoreOtps() {
  try {
    const result = await chrome.storage.local.get(IMESSAGE_OTPS_KEY);
    const stored = result[IMESSAGE_OTPS_KEY];
    if (Array.isArray(stored) && stored.length > 0) {
      for (const otp of stored) {
        if (!imessageOtps.some((o) => o.code === otp.code && o.dateMs === otp.dateMs)) {
          imessageOtps.push(otp);
        }
      }
      cleanupImessageOtps();
      console.log(`[iMessage] Restored ${imessageOtps.length} OTPs from storage`);
    }
  } catch (e) {
    console.error("[iMessage] Failed to restore OTPs:", e);
  }
}

function cleanupImessageOtps() {
  const cutoff = Date.now() - OTP_TTL_MS;
  imessageOtps = imessageOtps.filter((o) => o.dateMs > cutoff);
}

/* ========== Offscreen Document Lifecycle ========== */

let offscreenCreating = null;

async function ensureOffscreenDocument() {
  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen/offscreen.html")],
  });

  if (existingContexts.length > 0) {
    return; // Already exists
  }

  // Avoid race condition if multiple callers try to create simultaneously
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["WORKERS"],
    justification: "Maintains persistent WebSocket connection to the local iMessage bridge server for real-time OTP delivery",
  });

  await offscreenCreating;
  offscreenCreating = null;
  console.log("[iMessage] Offscreen document created");
}

async function closeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen/offscreen.html")],
  });

  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
    console.log("[iMessage] Offscreen document closed");
  }
}

/* ========== Keepalive & HTTP Fallback ========== */

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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME) return;

  // Restore persisted OTPs
  await restoreOtps();

  // Make sure offscreen document is still alive
  try {
    await ensureOffscreenDocument();
  } catch (e) {
    console.error("[iMessage] Failed to ensure offscreen document:", e);
  }

  // HTTP fallback poll
  await fetchImessageOtpsHttp();
});

async function fetchImessageOtpsHttp() {
  try {
    const res = await fetch(IMESSAGE_OTPS_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.otps)) return;

    let added = false;
    for (const o of data.otps) {
      const otp = {
        code: o.code,
        subject: o.senderName || o.sender || "iMessage",
        from: o.sender || "",
        dateMs: o.dateMs || Date.now(),
        source: "imessage",
        service: o.service || "SMS",
      };
      if (!imessageOtps.some((existing) => existing.code === otp.code && existing.dateMs === otp.dateMs)) {
        imessageOtps.push(otp);
        added = true;
      }
    }
    if (added) {
      cleanupImessageOtps();
      persistOtps();
    }
  } catch {
    // Server not reachable
  }
}

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

/* ========== iMessage Init/Teardown ========== */

async function startImessage() {
  await restoreOtps();
  await ensureOffscreenDocument();
  startKeepalive();
}

async function stopImessage() {
  await closeOffscreenDocument();
  stopKeepalive();
  imessageConnected = false;
  imessageOtps = [];
  persistOtps();
}

async function initImessage() {
  const result = await chrome.storage.local.get(IMESSAGE_ENABLED_KEY);
  if (result[IMESSAGE_ENABLED_KEY]) {
    await startImessage();
  }
}

/* ========== Message handling ========== */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // --- Messages FROM the offscreen document ---

  if (message?.type === "WS_STATUS") {
    imessageConnected = message.connected;
    console.log(`[iMessage] WS status: ${message.connected ? "connected" : "disconnected"}`);
    return false;
  }

  if (message?.type === "WS_OTP_DATA") {
    const data = message.payload;
    if (data.type === "OTP") {
      const otp = {
        code: data.code,
        subject: data.senderName || data.sender || "iMessage",
        from: data.sender || "",
        dateMs: data.dateMs || Date.now(),
        source: "imessage",
        service: data.service || "SMS",
      };
      if (!imessageOtps.some((o) => o.code === otp.code && o.dateMs === otp.dateMs)) {
        imessageOtps.push(otp);
        cleanupImessageOtps();
        persistOtps();
        console.log(`[iMessage] OTP received: ${otp.code}`);
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
      persistOtps();
    }
    return false;
  }

  // --- Messages FROM the popup ---

  if (message?.type === "GET_OTPS") {
    (async () => {
      try {
        const freshOtps = await withGmailToken((token) => fetchOtpsFromGmail(token));
        const gmailOtps = freshOtps.map((o) => ({ ...o, source: "gmail" }));

        const result = await chrome.storage.local.get(COPIED_OTPS_KEY);
        const copiedOtps = new Set(result[COPIED_OTPS_KEY] || []);
        const now = Date.now();

        await restoreOtps();
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
        persistOtps();
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
        await startImessage();
      } else {
        await stopImessage();
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

// Initialize iMessage on service worker startup
initImessage();

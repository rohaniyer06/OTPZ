/**
 * OTPZ Offscreen Document — Persistent WebSocket Client
 *
 * This offscreen document maintains the WebSocket connection to the local
 * iMessage bridge server. Unlike the service worker, offscreen documents
 * are NOT subject to Chrome's 30-second idle suspension, making them
 * ideal for persistent connections.
 *
 * Communication with the service worker happens via chrome.runtime messaging.
 */

const IMESSAGE_WS_URL = "ws://127.0.0.1:7483";

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
    }

    try {
        ws = new WebSocket(IMESSAGE_WS_URL);

        ws.onopen = () => {
            console.log("[Offscreen] WebSocket connected");
            reconnectDelay = 1000;
            // Notify service worker
            chrome.runtime.sendMessage({ type: "WS_STATUS", connected: true });
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // Forward OTP and SYNC messages to the service worker
                if (data.type === "OTP" || data.type === "SYNC") {
                    chrome.runtime.sendMessage({ type: "WS_OTP_DATA", payload: data });
                }
            } catch (e) {
                console.error("[Offscreen] Failed to parse message:", e);
            }
        };

        ws.onclose = () => {
            console.log("[Offscreen] WebSocket disconnected");
            ws = null;
            chrome.runtime.sendMessage({ type: "WS_STATUS", connected: false });
            scheduleReconnect();
        };

        ws.onerror = () => {
            console.error("[Offscreen] WebSocket error");
        };
    } catch (e) {
        console.error("[Offscreen] Failed to create WebSocket:", e);
        scheduleReconnect();
    }
}

function disconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (ws) {
        ws.close();
        ws = null;
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, reconnectDelay);
}

// Listen for commands from the service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "WS_CONNECT") {
        connect();
        sendResponse({ ok: true });
    } else if (message.type === "WS_DISCONNECT") {
        disconnect();
        sendResponse({ ok: true });
    } else if (message.type === "WS_PING") {
        // Service worker health-checking the offscreen doc
        sendResponse({
            ok: true,
            connected: ws !== null && ws.readyState === WebSocket.OPEN,
        });
    }
    return false; // Synchronous response
});

// Auto-connect on load (the service worker creates this document when iMessage is enabled)
connect();

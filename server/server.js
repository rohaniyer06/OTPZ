/**
 * OTPZ iMessage Bridge Server
 *
 * Watches incoming iMessages/SMS for OTP codes via imessage-kit and
 * pushes them to the Chrome extension over WebSocket.
 *
 * Usage:
 *   cd server && npm install && node server.js
 *
 * Requires: macOS, Node.js ≥ 18, Full Disk Access permission
 */

import { IMessageSDK } from "@photon-ai/imessage-kit";
import { WebSocketServer } from "ws";
import http from "node:http";
import { extractOtps, isShortcode } from "./otp-parser.js";

/* ========== Config ========== */
const PORT = parseInt(process.env.OTPZ_PORT || "7483", 10);
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const POLL_INTERVAL = 2000; // 2 seconds
const WS_PING_INTERVAL = 25000; // 25 seconds — keeps Chrome extension alive

/* ========== State ========== */
const otpStore = []; // { code, sender, senderName, dateMs, service, addedAt, dedupeKey }
const sentKeys = new Set(); // Track dedup keys to avoid duplicates

/* ========== OTP Store Management ========== */

function makeDedupeKey(code, sender, dateMs) {
    // Round dateMs to nearest 5 seconds to handle slight timestamp variance
    const roundedTime = Math.round(dateMs / 5000) * 5000;
    return `${code}:${sender || "unknown"}:${roundedTime}`;
}

function addOtp(otp) {
    const key = makeDedupeKey(otp.code, otp.sender, otp.dateMs);
    if (sentKeys.has(key)) return false;
    sentKeys.add(key);
    otpStore.push({ ...otp, addedAt: Date.now(), dedupeKey: key });
    cleanupExpired();
    return true;
}

function cleanupExpired() {
    const cutoff = Date.now() - OTP_TTL_MS;
    for (let i = otpStore.length - 1; i >= 0; i--) {
        if (otpStore[i].addedAt < cutoff) {
            sentKeys.delete(otpStore[i].dedupeKey);
            otpStore.splice(i, 1);
        }
    }
}

function getActiveOtps() {
    cleanupExpired();
    return otpStore.map(({ code, sender, senderName, dateMs, service }) => ({
        code,
        sender,
        senderName,
        dateMs,
        service,
    }));
}

/* ========== HTTP Health Endpoint ========== */

const httpServer = http.createServer((req, res) => {
    // CORS headers for Chrome extension
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: "1.0.0", otpCount: otpStore.length }));
        return;
    }

    if (req.url === "/otps" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, otps: getActiveOtps() }));
        return;
    }

    res.writeHead(404);
    res.end("Not Found");
});

/* ========== WebSocket Server ========== */

const wss = new WebSocketServer({ server: httpServer });
const clients = new Set();

wss.on("connection", (ws) => {
    clients.add(ws);
    ws.isAlive = true;
    log(`Client connected (total: ${clients.size})`);

    // Send current OTPs to newly connected client
    const current = getActiveOtps();
    if (current.length > 0) {
        ws.send(JSON.stringify({ type: "SYNC", otps: current }));
    }

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    ws.on("close", () => {
        clients.delete(ws);
        log(`Client disconnected (total: ${clients.size})`);
    });

    ws.on("error", (err) => {
        log(`WebSocket error: ${err.message}`, "error");
        clients.delete(ws);
    });
});

// Ping all clients every 25 seconds to keep the connection alive.
// Chrome MV3 service workers stay awake while receiving WebSocket traffic.
const pingInterval = setInterval(() => {
    for (const client of clients) {
        if (!client.isAlive) {
            // Client didn't respond to last ping — terminate
            log("Terminating unresponsive client", "warn");
            client.terminate();
            clients.delete(client);
            continue;
        }
        client.isAlive = false;
        client.ping();
    }
}, WS_PING_INTERVAL);

wss.on("close", () => {
    clearInterval(pingInterval);
});

function broadcast(data) {
    const json = JSON.stringify(data);
    for (const client of clients) {
        if (client.readyState === 1) {
            // WebSocket.OPEN
            client.send(json);
        }
    }
}

/* ========== iMessage Watcher ========== */

const sdk = new IMessageSDK({
    debug: false,
    // We do NOT use the built-in watcher because it misses delayed iCloud syncs
    // when the Mac wakes from sleep.
});

let watchInterval = null;

async function startWatching() {
    log("Starting reliable 10-minute sliding window watcher...");

    watchInterval = setInterval(async () => {
        try {
            // ALWAYS scan the entire last 10 minutes.
            // This is critical because macOS often syncs messages upon waking from sleep
            // using their historical timestamps (e.g. 8 hours ago). A sliding window ensures
            // no OTPs are missed due to synchronization lag. Our addOtp dedup cache handles duplicates.
            const since = new Date(Date.now() - 10 * 60 * 1000);
            const { messages } = await sdk.getMessages({ since, excludeOwnMessages: false });

            for (const msg of messages) {
                // Skip reactions (tapbacks), but allow self-sent messages
                if (msg.isReaction) continue;

                const text = msg.text;
                if (!text) continue;

                const shortcode = isShortcode(msg.sender);
                const codes = extractOtps(text, { fromShortcode: shortcode });

                if (codes.length === 0) continue;

                for (const code of codes) {
                    const otp = {
                        code,
                        sender: msg.sender,
                        senderName: msg.senderName || msg.sender,
                        dateMs: msg.date ? msg.date.getTime() : Date.now(),
                        service: msg.service || "iMessage",
                    };

                    const isNew = addOtp(otp);
                    if (isNew) {
                        log(`OTP detected: ${code} from ${msg.sender} (${msg.service})`);
                        broadcast({ type: "OTP", ...otp });
                    }
                }
            }
        } catch (error) {
            log(`Watcher error: ${error.message}`, "error");
        }
    }, POLL_INTERVAL);

    log("iMessage watcher active — monitoring for OTP codes");
}

/* ========== Logging ========== */

function log(msg, level = "info") {
    const time = new Date().toLocaleTimeString();
    const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️" : "📱";
    console.log(`${prefix} [${time}] ${msg}`);
}

/* ========== Startup ========== */

async function main() {
    console.log("");
    console.log("  ╔═══════════════════════════════════════╗");
    console.log("  ║     OTPZ iMessage Bridge Server       ║");
    console.log("  ╚═══════════════════════════════════════╝");
    console.log("");

    httpServer.listen(PORT, "127.0.0.1", () => {
        log(`Server listening on http://127.0.0.1:${PORT}`);
        log(`Health check: http://127.0.0.1:${PORT}/health`);
        log(`WebSocket:    ws://127.0.0.1:${PORT}`);
        log(`Ping interval: ${WS_PING_INTERVAL / 1000}s`);
        console.log("");
    });

    try {
        await startWatching();
    } catch (err) {
        if (err.message?.includes("SQLITE_CANTOPEN") || err.message?.includes("permission")) {
            log("Full Disk Access required!", "error");
            log("Go to: System Settings → Privacy & Security → Full Disk Access", "error");
            log("Add your terminal app (Terminal, iTerm, Warp, etc.)", "error");
        } else {
            log(`Failed to start watcher: ${err.message}`, "error");
        }
        // Keep the HTTP/WS server running even if watcher fails
        // so the extension can still check health and see the error
    }
}

// Graceful shutdown
process.on("SIGINT", async () => {
    log("Shutting down...");
    clearInterval(pingInterval);
    if (watchInterval) clearInterval(watchInterval);
    await sdk.close();
    wss.close();
    httpServer.close();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    clearInterval(pingInterval);
    if (watchInterval) clearInterval(watchInterval);
    await sdk.close();
    process.exit(0);
});

main();

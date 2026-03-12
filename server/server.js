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

/* ========== State ========== */
const otpStore = []; // { code, sender, senderName, dateMs, service, addedAt }
const sentCodes = new Set(); // Track codes already pushed to avoid duplicates

/* ========== OTP Store Management ========== */

function addOtp(otp) {
    // Deduplicate by code
    if (sentCodes.has(otp.code)) return false;
    sentCodes.add(otp.code);
    otpStore.push({ ...otp, addedAt: Date.now() });
    cleanupExpired();
    return true;
}

function cleanupExpired() {
    const cutoff = Date.now() - OTP_TTL_MS;
    for (let i = otpStore.length - 1; i >= 0; i--) {
        if (otpStore[i].addedAt < cutoff) {
            sentCodes.delete(otpStore[i].code);
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
    log(`Client connected (total: ${clients.size})`);

    // Send current OTPs to newly connected client
    const current = getActiveOtps();
    if (current.length > 0) {
        ws.send(JSON.stringify({ type: "SYNC", otps: current }));
    }

    ws.on("close", () => {
        clients.delete(ws);
        log(`Client disconnected (total: ${clients.size})`);
    });

    ws.on("error", (err) => {
        log(`WebSocket error: ${err.message}`, "error");
        clients.delete(ws);
    });
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
    watcher: {
        pollInterval: POLL_INTERVAL,
        excludeOwnMessages: true,
    },
});

async function startWatching() {
    log("Starting iMessage watcher...");

    await sdk.startWatching({
        onDirectMessage: (msg) => {
            // Skip messages from self or reactions
            if (msg.isFromMe || msg.isReaction) return;

            const text = msg.text;
            if (!text) return;

            const shortcode = isShortcode(msg.sender);
            const codes = extractOtps(text, { fromShortcode: shortcode });

            if (codes.length === 0) return;

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
        },

        onError: (error) => {
            log(`Watcher error: ${error.message}`, "error");
        },
    });

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
    sdk.stopWatching();
    await sdk.close();
    wss.close();
    httpServer.close();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    sdk.stopWatching();
    await sdk.close();
    process.exit(0);
});

main();

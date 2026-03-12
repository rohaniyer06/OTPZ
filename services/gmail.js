// Helper: base64url decode to UTF-8
function base64UrlToText(b64url) {
  try {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

function stripHtml(html) {
  const noTags = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ");
  return noTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Recursively collect text/plain (prefer) then text/html parts
function collectTextFromPayload(payload) {
  let texts = [];
  if (!payload) return "";

  const walk = (p) => {
    if (!p) return;
    const mime = (p.mimeType || "").toLowerCase();
    if (p.body?.data && (mime === "text/plain" || mime === "text/html")) {
      const raw = base64UrlToText(p.body.data);
      texts.push(mime === "text/html" ? stripHtml(raw) : raw);
    }
    if (Array.isArray(p.parts)) p.parts.forEach(walk);
  };
  walk(payload);
  return texts.join("\n");
}

/* ========== OTP Extraction ========== */

// Common words that should NOT be treated as OTP codes
const FALSE_POSITIVE_WORDS = new Set([
  "please", "verify", "account", "access", "click", "enter",
  "submit", "confirm", "email", "phone", "number", "secure",
  "update", "expires", "expire", "minute", "minutes", "second",
  "password", "login", "signin", "signup", "reset", "change",
  "below", "above", "follow", "request", "received", "ignore",
  "valid", "invalid", "attempt", "current", "recent", "device",
  "browser", "action", "required", "security", "protect", "support",
  "contact", "thanks", "welcome", "hello", "greetings",
  "greenhouse", "company", "copied", "successfully",
  "powered", "rights", "reserved", "privacy", "policy",
  "unsubscribe", "manage", "preferences", "questions",
  "application", "continue", "button",
]);

/**
 * Check if a string looks like a plausible alphanumeric OTP code
 * rather than a regular English word.
 */
function isPlausibleAlphaCode(str) {
  // Reject if it's a common English word (case-insensitive)
  if (FALSE_POSITIVE_WORDS.has(str.toLowerCase())) return false;

  const hasUpper = /[A-Z]/.test(str);
  const hasLower = /[a-z]/.test(str);
  const hasDigit = /\d/.test(str);

  // Mixed letters + digits → almost certainly a code
  if ((hasUpper || hasLower) && hasDigit) return true;

  // Mixed case (uppercase + lowercase) → likely a code
  if (hasUpper && hasLower) {
    // Codes like "LnfrPApg" have uppercase in non-first positions
    const midUpperCount = (str.slice(1).match(/[A-Z]/g) || []).length;
    if (midUpperCount >= 1) return true;
  }

  // All uppercase, 6+ chars → likely a code (e.g., "ABCDEF")
  if (hasUpper && !hasLower && str.length >= 6) return true;

  return false;
}

/**
 * Extract OTP codes from text.
 * Supports:
 *   - Numeric codes: 4–8 digits (e.g., "847291")
 *   - Alphanumeric codes: 4–10 chars near OTP keywords (e.g., "LnfrPApg")
 *   - Codes on their own line after a colon (common email format)
 */
function extractOtpsFromText(text) {
  if (!text) return [];
  const results = new Set();
  const lower = text.toLowerCase();

  // Keywords that indicate an OTP is nearby
  const keywords = [
    "otp", "one-time password", "one-time passcode",
    "verification code", "passcode", "security code",
    "login code", "access code", "confirmation code",
    "your code is", "your code:", "enter code",
    "code is:", "code is ", "code:",
    "code", // standalone — catches "this code", "the code", etc.
  ];

  // --- Pass 1: Numeric codes (4–8 digits) near keywords ---
  for (const kw of keywords) {
    let idx = 0;
    while (true) {
      idx = lower.indexOf(kw, idx);
      if (idx === -1) break;
      const start = Math.max(0, idx - 80);
      const end = Math.min(text.length, idx + kw.length + 80);
      const window = text.slice(start, end);
      for (const m of window.matchAll(/(?<!\d)(\d{4,8})(?!\d)/g)) {
        results.add(m[1]);
      }
      idx += kw.length;
    }
  }

  // --- Pass 2: Alphanumeric codes (4–10 chars) near keywords ---
  for (const kw of keywords) {
    let idx = 0;
    while (true) {
      idx = lower.indexOf(kw, idx);
      if (idx === -1) break;
      // Use wider window to catch codes on separate lines
      const start = Math.max(0, idx - 80);
      const end = Math.min(text.length, idx + kw.length + 120);
      const window = text.slice(start, end);
      for (const m of window.matchAll(/(?<![a-zA-Z0-9])([a-zA-Z0-9]{4,10})(?![a-zA-Z0-9])/g)) {
        const candidate = m[1];
        // Skip if it's purely digits (already caught in pass 1)
        if (/^\d+$/.test(candidate)) continue;
        // Filter false positives
        if (isPlausibleAlphaCode(candidate)) {
          results.add(candidate);
        }
      }
      idx += kw.length;
    }
  }

  // --- Pass 3: Code on its own line after a colon ---
  // Catches patterns like "your code:\n\nABC123" or "code is:\n  LnfrPApg"
  const colonCodePattern = /(?:code|passcode|otp|password)[^:]*:\s*\n?\s*([a-zA-Z0-9]{4,10})\b/gi;
  for (const m of text.matchAll(colonCodePattern)) {
    const candidate = m[1];
    if (/^\d+$/.test(candidate)) {
      // Numeric — only add if 4-8 digits
      if (candidate.length >= 4 && candidate.length <= 8) results.add(candidate);
    } else if (!FALSE_POSITIVE_WORDS.has(candidate.toLowerCase())) {
      results.add(candidate);
    }
  }

  // --- Fallback: any 4–8 digit sequence in full text ---
  if (results.size === 0) {
    for (const m of text.matchAll(/(?<!\d)(\d{4,8})(?!\d)/g)) {
      results.add(m[1]);
    }
  }

  return Array.from(results);
}

/* ========== Gmail API ========== */

async function gmailRequest(token, path, params = {}) {
  const url = new URL(`https://www.googleapis.com/gmail/v1/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401)
    throw new Error("Unauthorized (401). Token may be expired. Reopen popup to re-authenticate.");
  if (!res.ok) throw new Error(`Gmail API error ${res.status}: ${await res.text()}`);
  return await res.json();
}

/**
 * Fetch recent unread messages that likely contain OTPs, parse them, and return
 * a list of { code, subject, from, dateMs, messageId } sorted by recency.
 */
export async function fetchOtpsFromGmail(token) {
  const q = `is:unread newer_than:1h (OTP OR "one-time password" OR "one-time passcode" OR "verification code" OR passcode OR "security code" OR "login code" OR "access code" OR "confirmation code" OR "your code is" OR "enter code" OR code)`;
  const list = await gmailRequest(token, "users/me/messages", {
    q,
    maxResults: "15",
  });

  const items = [];
  const messageIds = (list.messages || []).map((m) => m.id);
  if (messageIds.length === 0) return [];

  const details = await Promise.all(
    messageIds.map((id) =>
      gmailRequest(token, `users/me/messages/${id}`, { format: "full" }).catch(() => null)
    )
  );

  for (const msg of details) {
    if (!msg) continue;
    const headers = msg.payload?.headers || [];
    const getHeader = (name) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

    const subject = getHeader("Subject");
    const from = getHeader("From");
    const dateMs = Number(msg.internalDate || 0);

    const bodyText = collectTextFromPayload(msg.payload) || msg.snippet || subject;
    const codes = extractOtpsFromText(`${subject}\n${bodyText}`);

    for (const code of codes) {
      items.push({
        code,
        subject,
        from,
        dateMs,
        messageId: msg.id,
      });
    }
  }

  // De-dupe by code, keep the most recent
  const byCode = new Map();
  for (const it of items) {
    const prev = byCode.get(it.code);
    if (!prev || it.dateMs > prev.dateMs) byCode.set(it.code, it);
  }

  return Array.from(byCode.values())
    .sort((a, b) => b.dateMs - a.dateMs)
    .slice(0, 10);
}

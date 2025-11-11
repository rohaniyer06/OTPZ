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
  // extremely simple stripping for demo purposes
  const noTags = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
  return noTags.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
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

// Extract 4–8 digit OTP codes. Prefer codes near keywords; fall back to any 4–8 digits.
function extractOtpsFromText(text) {
  if (!text) return [];
  const results = new Set();
  const lower = text.toLowerCase();
  const keywords = ["otp", "one-time password", "verification code", "passcode", "code"];

  // Windowed search near keywords first
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
  // Fallback: any 4–8 digit sequence in full text
  if (results.size === 0) {
    for (const m of text.matchAll(/(?<!\d)(\d{4,8})(?!\d)/g)) results.add(m[1]);
  }
  return Array.from(results);
}

async function gmailRequest(token, path, params = {}) {
  const url = new URL(`https://www.googleapis.com/gmail/v1/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error("Unauthorized (401). Token may be expired. Reopen popup to re-authenticate.");
  if (!res.ok) throw new Error(`Gmail API error ${res.status}: ${await res.text()}`);
  return await res.json();
}

/**
 * Fetch recent unread messages that likely contain OTPs, parse them, and return
 * a list of { code, subject, from, dateMs, messageId } sorted by recency.
 */
export async function fetchOtpsFromGmail(token) {
  // Gmail search query: unread, recent, with likely OTP keywords
  const q = `is:unread newer_than:1h (OTP OR "one-time password" OR "verification code" OR passcode OR code OR "security code" OR "login code" OR "verification number")`;
  const list = await gmailRequest(token, "users/me/messages", {
    q,
    maxResults: "15"
  });

  const items = [];
  const messageIds = (list.messages || []).map((m) => m.id);
  if (messageIds.length === 0) return [];

  // Fetch each message in "full" format for headers + body
  const details = await Promise.all(
    messageIds.map((id) => gmailRequest(token, `users/me/messages/${id}`, { format: "full" }).catch(() => null))
  );

  for (const msg of details) {
    if (!msg) continue;
    const headers = msg.payload?.headers || [];
    const getHeader = (name) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

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
        messageId: msg.id
      });
    }
  }

  // De-dupe by code, keep the most recent
  const byCode = new Map();
  for (const it of items) {
    const prev = byCode.get(it.code);
    if (!prev || it.dateMs > prev.dateMs) byCode.set(it.code, it);
  }

  return Array.from(byCode.values()).sort((a, b) => b.dateMs - a.dateMs).slice(0, 10);
}


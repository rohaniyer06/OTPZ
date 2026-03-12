/**
 * OTP extraction logic shared between the bridge server and the extension.
 * Supports numeric (4–8 digits) and alphanumeric (4–10 chars) codes.
 */

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
    "application", "continue", "button", "message", "texted",
    "verify", "urgent", "important", "service", "customer",
]);

/**
 * Check if a string looks like a plausible alphanumeric OTP code.
 */
function isPlausibleAlphaCode(str) {
    if (FALSE_POSITIVE_WORDS.has(str.toLowerCase())) return false;

    const hasUpper = /[A-Z]/.test(str);
    const hasLower = /[a-z]/.test(str);
    const hasDigit = /\d/.test(str);

    // Mixed letters + digits → almost certainly a code
    if ((hasUpper || hasLower) && hasDigit) return true;

    // Mixed case with uppercase in non-first position → likely a code
    if (hasUpper && hasLower) {
        const midUpperCount = (str.slice(1).match(/[A-Z]/g) || []).length;
        if (midUpperCount >= 1) return true;
    }

    // All uppercase, 6+ chars → likely a code
    if (hasUpper && !hasLower && str.length >= 6) return true;

    return false;
}

/**
 * Check if a sender looks like a shortcode (5-6 digit number).
 * SMS OTPs almost always come from shortcodes.
 */
export function isShortcode(sender) {
    if (!sender) return false;
    const cleaned = sender.replace(/[^0-9]/g, "");
    return cleaned.length >= 4 && cleaned.length <= 6;
}

/**
 * Extract OTP codes from text.
 * @param {string} text - The message or email body text
 * @param {object} options
 * @param {boolean} options.fromShortcode - If true, lower the keyword-proximity bar
 * @returns {string[]} Array of extracted OTP codes
 */
export function extractOtps(text, { fromShortcode = false } = {}) {
    if (!text) return [];
    const results = new Set();
    const lower = text.toLowerCase();

    const keywords = [
        "otp", "one-time password", "one-time passcode",
        "verification code", "passcode", "security code",
        "login code", "access code", "confirmation code",
        "your code is", "your code:", "enter code",
        "code is:", "code is ", "code:",
        "code",
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
            const start = Math.max(0, idx - 80);
            const end = Math.min(text.length, idx + kw.length + 120);
            const window = text.slice(start, end);
            for (const m of window.matchAll(/(?<![a-zA-Z0-9])([a-zA-Z0-9]{4,10})(?![a-zA-Z0-9])/g)) {
                const candidate = m[1];
                if (/^\d+$/.test(candidate)) continue;
                if (isPlausibleAlphaCode(candidate)) {
                    results.add(candidate);
                }
            }
            idx += kw.length;
        }
    }

    // --- Pass 3: Code on its own line after a colon ---
    const colonCodePattern = /(?:code|passcode|otp|password)[^:]*:\s*\n?\s*([a-zA-Z0-9]{4,10})\b/gi;
    for (const m of text.matchAll(colonCodePattern)) {
        const candidate = m[1];
        if (/^\d+$/.test(candidate)) {
            if (candidate.length >= 4 && candidate.length <= 8) results.add(candidate);
        } else if (!FALSE_POSITIVE_WORDS.has(candidate.toLowerCase())) {
            results.add(candidate);
        }
    }

    // --- Pass 4 (SMS shortcode): if sender is a shortcode, grab any digit sequence ---
    if (fromShortcode && results.size === 0) {
        for (const m of text.matchAll(/(?<!\d)(\d{4,8})(?!\d)/g)) {
            results.add(m[1]);
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

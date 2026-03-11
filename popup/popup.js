const $ = (sel) => document.querySelector(sel);
const list = $("#list");
const empty = $("#empty");
const loading = $("#loading");
const err = $("#error");
const refreshBtn = $("#refresh");
const refreshIcon = $(".refresh-icon");
const refreshCountdown = $(".refresh-countdown");

/* ========== Config ========== */
const POLL_INTERVAL_MS = 5_000; // 5 seconds
const THROTTLE_COOLDOWN_MS = 5_000; // matches poll interval

/* ========== State ========== */
let pollTimer = null;
let isFirstLoad = true;
let currentOtpCodes = []; // Track displayed OTPs for smart re-render

// Throttle state
let throttleLocked = false;
let cooldownTimer = null;
let cooldownCountdownTimer = null;

/* ========== Helpers ========== */

function formatDate(ms) {
  if (!ms) return "";
  const now = Date.now();
  const diffMin = Math.floor((now - ms) / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/* ========== Throttle for manual refresh ========== */

function lockRefreshButton() {
  throttleLocked = true;
  refreshBtn.disabled = true;
  refreshIcon.hidden = true;
  refreshCountdown.hidden = false;

  let remaining = Math.ceil(THROTTLE_COOLDOWN_MS / 1000);
  refreshCountdown.textContent = `${remaining}s`;

  // Clear any existing countdown
  clearInterval(cooldownCountdownTimer);

  cooldownCountdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      unlockRefreshButton();
    } else {
      refreshCountdown.textContent = `${remaining}s`;
    }
  }, 1000);

  // Hard unlock after the full cooldown (safety net)
  clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(unlockRefreshButton, THROTTLE_COOLDOWN_MS);
}

function unlockRefreshButton() {
  throttleLocked = false;
  refreshBtn.disabled = false;
  refreshIcon.hidden = false;
  refreshCountdown.hidden = true;
  clearInterval(cooldownCountdownTimer);
  clearTimeout(cooldownTimer);
}

// Reset the throttle cooldown (called when auto-poll fires)
function resetThrottleCooldown() {
  if (throttleLocked) {
    // Restart the countdown from the full duration
    lockRefreshButton();
  }
}

/* ========== Render ========== */

function render(otps) {
  list.innerHTML = "";
  if (!otps || otps.length === 0) {
    list.hidden = true;
    empty.hidden = false;
    currentOtpCodes = [];
    return;
  }
  empty.hidden = true;
  list.hidden = false;
  currentOtpCodes = otps.map((o) => o.code);

  for (const item of otps) {
    const li = document.createElement("li");
    li.className = "li";
    li.innerHTML = `
      <div class="otp-info">
        <div class="code">${item.code}</div>
        <div class="meta">${truncate(item.subject, 32) || "(no subject)"} <span class="from-text">· ${truncate(item.from, 24) || ""}</span></div>
        <div class="timestamp">${formatDate(item.dateMs)}</div>
      </div>
      <div class="actions">
        <button class="autofill" data-code="${item.code}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Autofill
        </button>
        <button class="copy" data-code="${item.code}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy
        </button>
      </div>
    `;
    list.appendChild(li);
  }
}

/* ========== Button handlers ========== */

async function handleListClick(e) {
  if (e.target.closest(".copy")) {
    const btn = e.target.closest(".copy");
    const code = btn.dataset.code;
    try {
      await navigator.clipboard.writeText(code);
      btn.classList.add("btn-success");
      btn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Copied!`;

      try {
        await chrome.runtime.sendMessage({ type: "OTP_COPIED", code });
      } catch (e) {
        console.error("Failed to mark OTP as copied:", e);
      }

      setTimeout(() => {
        const item = btn.closest(".li");
        if (item) {
          item.classList.add("removing");
          setTimeout(() => item.remove(), 350);
        }
      }, 600);
    } catch {
      btn.textContent = "Failed";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    }
  } else if (e.target.closest(".autofill")) {
    const btn = e.target.closest(".autofill");
    const code = btn.dataset.code;
    const item = btn.closest(".li");

    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      Filling…`;
    btn.disabled = true;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) throw new Error("No active tab found");

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/autofill.js"],
      });

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "AUTOFILL_OTP",
        otp: code,
      });

      if (response?.success) {
        btn.classList.add("btn-success");
        btn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Filled!`;

        try {
          await chrome.runtime.sendMessage({ type: "OTP_COPIED", code });
        } catch (e) {
          console.error("Failed to mark OTP as used:", e);
        }

        setTimeout(() => {
          if (item) {
            item.classList.add("removing");
            setTimeout(() => item.remove(), 350);
          }
        }, 600);
      } else {
        throw new Error(response?.message || "Failed to autofill OTP");
      }
    } catch (error) {
      console.error("Autofill error:", error);
      btn.innerHTML = "Failed";
      setTimeout(() => {
        btn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Autofill`;
        btn.disabled = false;
      }, 1500);
    }
  }
}

/* ========== Load OTPs ========== */

async function loadOtps({ silent = false } = {}) {
  // Only show the full loading spinner on first load
  if (!silent && isFirstLoad) {
    loading.hidden = false;
    err.hidden = true;
    empty.hidden = true;
    list.hidden = true;
  }

  // Spin the refresh icon briefly to indicate activity (if visible)
  if (!throttleLocked) {
    refreshBtn.style.transition = "transform 0.5s ease";
    refreshBtn.style.transform = "rotate(360deg)";
    setTimeout(() => {
      refreshBtn.style.transition = "all 0.2s ease";
      refreshBtn.style.transform = "";
    }, 550);
  }

  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_OTPS" }, resolve);
    });

    loading.hidden = true;
    isFirstLoad = false;

    if (!res?.ok) {
      if (res?.error_code === "auth_canceled") {
        err.innerHTML =
          'Sign-in was canceled.<br><button id="signin" class="signin-btn">Sign in with Google</button>';
        document.getElementById("signin")?.addEventListener("click", () => {
          loadOtps();
        });
      } else {
        err.textContent = res?.error || "Failed to fetch OTPs. Please try again.";
      }
      err.hidden = false;
      return;
    }

    if (res.otps && res.otps.length > 0) {
      // Smart re-render: only update if OTPs changed
      const newCodes = res.otps.map((o) => o.code);
      const changed =
        newCodes.length !== currentOtpCodes.length ||
        newCodes.some((c, i) => c !== currentOtpCodes[i]);

      if (changed) {
        render(res.otps);
      }
    } else {
      if (currentOtpCodes.length > 0 || isFirstLoad === false) {
        // OTPs cleared — update UI
        list.hidden = true;
        list.innerHTML = "";
        currentOtpCodes = [];
      }
      empty.hidden = false;
    }
  } catch (error) {
    console.error("Error in loadOtps:", error);
    if (!silent) {
      err.textContent = `Error: ${error.message || "Unknown error occurred"}`;
      err.hidden = false;
    }
    loading.hidden = true;
    isFirstLoad = false;
  }
}

/* ========== Polling ========== */

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    loadOtps({ silent: true });
    // Reset the manual refresh throttle since an auto-poll just fired
    resetThrottleCooldown();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/* ========== Manual refresh (throttled) ========== */

function handleManualRefresh() {
  if (throttleLocked) return; // Ignore clicks during cooldown

  // Fire immediately
  loadOtps({ silent: false });

  // Lock the button for the cooldown period
  lockRefreshButton();

  // Reset the auto-poll timer so it doesn't fire right after
  startPolling();
}

/* ========== Init ========== */

document.addEventListener("DOMContentLoaded", () => {
  // Attach action button handler once (event delegation)
  list.addEventListener("click", handleListClick);

  loadOtps(); // Initial fetch
  startPolling(); // Start 5-second auto-poll
});

refreshBtn.addEventListener("click", handleManualRefresh);

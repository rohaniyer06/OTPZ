const $ = (sel) => document.querySelector(sel);
const list = $("#list");
const empty = $("#empty");
const loading = $("#loading");
const err = $("#error");
const refreshBtn = $("#refresh");
const refreshIcon = $(".refresh-icon");
const refreshCountdown = $(".refresh-countdown");
const settingsToggle = $("#settings-toggle");
const settingsPanel = $("#settings-panel");
const settingsClose = $("#settings-close");
const imessageToggle = $("#imessage-toggle");
const imessageStatus = $("#imessage-status");
const imessageSetup = $("#imessage-setup");
const imessageRetry = $("#imessage-retry");
const imessageSection = $("#imessage-section");

/* ========== Config ========== */
const POLL_INTERVAL_MS = 5_000;
const THROTTLE_COOLDOWN_MS = 5_000;

/* ========== State ========== */
let pollTimer = null;
let isFirstLoad = true;
let currentOtpCodes = [];

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

/* ========== Throttle for manual refresh ========== */

function lockRefreshButton() {
  throttleLocked = true;
  refreshBtn.disabled = true;
  refreshIcon.hidden = true;
  refreshCountdown.hidden = false;

  let remaining = Math.ceil(THROTTLE_COOLDOWN_MS / 1000);
  refreshCountdown.textContent = `${remaining}s`;

  clearInterval(cooldownCountdownTimer);
  cooldownCountdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      unlockRefreshButton();
    } else {
      refreshCountdown.textContent = `${remaining}s`;
    }
  }, 1000);

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

function resetThrottleCooldown() {
  if (throttleLocked) {
    lockRefreshButton();
  }
}

/* ========== Source badge ========== */

function sourceBadgeHtml(source) {
  if (source === "imessage") {
    return '<span class="source-badge imessage">💬 iMessage</span>';
  }
  return '<span class="source-badge gmail">📧 Gmail</span>';
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
        <div class="meta">${item.subject || "(no subject)"}</div>
        <div class="meta from-text">${item.from || ""} · ${formatDate(item.dateMs)} ${sourceBadgeHtml(item.source)}</div>
      </div>
      <div class="actions">
        <button class="autofill" data-code="${item.code}" title="Autofill">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Autofill
        </button>
        <button class="copy" data-code="${item.code}" title="Copy">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy
        </button>
        <button class="remove" data-code="${item.code}" title="Remove code" aria-label="Remove code">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
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
          setTimeout(() => {
            item.remove();
            if (list.children.length === 0) {
              list.hidden = true;
              empty.hidden = false;
            }
          }, 350);
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
            setTimeout(() => {
              item.remove();
              if (list.children.length === 0) {
                list.hidden = true;
                empty.hidden = false;
              }
            }, 350);
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
  } else if (e.target.closest(".remove")) {
    const btn = e.target.closest(".remove");
    const code = btn.dataset.code;
    const item = btn.closest(".li");

    btn.disabled = true;
    try {
      // Reusing OTP_COPIED logic to clear it from the UI cache
      await chrome.runtime.sendMessage({ type: "OTP_COPIED", code });
    } catch (err) {
      console.error("Failed to remove OTP:", err);
    }

    if (item) {
      item.classList.add("removing");
      setTimeout(() => {
        item.remove();
        if (list.children.length === 0) {
          list.hidden = true;
          empty.hidden = false;
        }
      }, 350);
    }
  }
}

/* ========== Load OTPs ========== */

async function loadOtps({ silent = false } = {}) {
  if (!silent && isFirstLoad) {
    loading.hidden = false;
    err.hidden = true;
    empty.hidden = true;
    list.hidden = true;
  }

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
      const newCodes = res.otps.map((o) => o.code);
      const changed =
        newCodes.length !== currentOtpCodes.length ||
        newCodes.some((c, i) => c !== currentOtpCodes[i]);

      if (changed) {
        render(res.otps);
      }
    } else {
      if (currentOtpCodes.length > 0) {
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
    resetThrottleCooldown();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function handleManualRefresh() {
  if (throttleLocked) return;
  loadOtps({ silent: false });
  lockRefreshButton();
  startPolling();
}

/* ========== Settings Panel ========== */

function openSettings() {
  settingsPanel.hidden = false;
  refreshImessageStatus();
}

function closeSettings() {
  settingsPanel.hidden = true;
}

/* ========== iMessage Settings ========== */

async function refreshImessageStatus() {
  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "IMESSAGE_STATUS" }, resolve);
    });

    imessageToggle.checked = res.enabled;

    if (res.enabled) {
      imessageStatus.hidden = false;
      const dot = imessageStatus.querySelector(".status-dot");
      const text = imessageStatus.querySelector(".status-text");

      if (res.wsConnected) {
        dot.className = "status-dot connected";
        text.textContent = "Connected — receiving iMessage OTPs";
        imessageSetup.hidden = true;
      } else if (res.serverRunning) {
        dot.className = "status-dot connecting";
        text.textContent = "Server found, connecting…";
        imessageSetup.hidden = true;
      } else {
        dot.className = "status-dot disconnected";
        text.textContent = "Server not running";
        imessageSetup.hidden = false;
      }
    } else {
      imessageStatus.hidden = true;
      imessageSetup.hidden = true;
    }
  } catch (e) {
    console.error("Failed to get iMessage status:", e);
  }
}

async function toggleImessage(enabled) {
  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "IMESSAGE_SET_ENABLED", enabled }, resolve);
    });
    // Wait a moment for WS to connect, then refresh status
    setTimeout(refreshImessageStatus, enabled ? 1500 : 100);
  } catch (e) {
    console.error("Failed to toggle iMessage:", e);
  }
}

/* ========== Platform detection ========== */

function isMacOS() {
  return /Mac/i.test(navigator.userAgent || navigator.platform || "");
}

/* ========== Init ========== */

document.addEventListener("DOMContentLoaded", () => {
  // Attach action button handler once (event delegation)
  list.addEventListener("click", handleListClick);

  loadOtps();
  startPolling();

  // Settings panel
  settingsToggle.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);

  // iMessage toggle
  imessageToggle.addEventListener("change", (e) => {
    toggleImessage(e.target.checked);
  });

  // Retry button
  imessageRetry?.addEventListener("click", () => {
    refreshImessageStatus();
  });

  // Hide iMessage section on non-macOS
  if (!isMacOS()) {
    imessageSection.hidden = true;
  }

  // Populate the server path in setup instructions
  const serverPath = $("#server-path");
  if (serverPath) {
    serverPath.textContent = "path/to/otpz";
  }
});

refreshBtn.addEventListener("click", handleManualRefresh);

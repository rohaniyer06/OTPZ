const $ = (sel) => document.querySelector(sel);
const list = $("#list");
const empty = $("#empty");
const loading = $("#loading");
const err = $("#error");
const refreshBtn = $("#refresh");

function formatDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleString();
}

function render(otps) {
  list.innerHTML = "";
  if (!otps || otps.length === 0) {
    list.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.hidden = false;

  for (const item of otps) {
    const li = document.createElement("li");
    li.className = "li";
    li.innerHTML = `
      <div>
        <div class="code">${item.code}</div>
        <div class="meta">${item.subject || "(no subject)"} <span class="small">• ${item.from || ""}</span></div>
        <div class="small">${formatDate(item.dateMs)}</div>
      </div>
      <div>
        <button class="copy" data-code="${item.code}">Copy</button>
      </div>
    `;
    list.appendChild(li);
  }

  list.addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy");
    if (!btn) return;
    const code = btn.dataset.code;
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    } catch {
      btn.textContent = "Failed";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    }
  }, { once: true });
}

async function loadOtps() {
  loading.hidden = false;
  err.hidden = true;
  empty.hidden = true;
  list.hidden = true;

  chrome.runtime.sendMessage({ type: "GET_OTPS" }, (res) => {
    loading.hidden = true;
    if (!res?.ok) {
      err.textContent = res?.error || "Failed to fetch OTPs.";
      err.hidden = false;
      return;
    }
    render(res.otps);
  });
}

document.addEventListener("DOMContentLoaded", loadOtps);
refreshBtn.addEventListener("click", loadOtps);


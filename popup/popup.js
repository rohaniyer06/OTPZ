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
      
      // Notify the service worker that this OTP was copied
      try {
        await chrome.runtime.sendMessage({ 
          type: "OTP_COPIED", 
          code: code 
        });
      } catch (e) {
        console.error('Failed to mark OTP as copied:', e);
      }
      
      // Remove the OTP from the UI after a short delay
      setTimeout(() => {
        const item = btn.closest('.li');
        if (item) {
          item.style.opacity = '0';
          setTimeout(() => item.remove(), 300);
        }
      }, 500);
      
    } catch {
      btn.textContent = "Failed";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    }
  });
}

async function loadOtps() {
  loading.hidden = false;
  err.hidden = true;
  empty.hidden = true;
  list.hidden = true;

  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_OTPS" }, resolve);
    });
    
    loading.hidden = true;
    
    if (!res?.ok) {
      if (res?.error_code === "auth_canceled") {
        err.innerHTML = 'Sign-in was canceled. <button id="signin" class="signin-btn">Sign in</button>';
        document.getElementById('signin')?.addEventListener('click', () => {
          loadOtps(); // Retry with interactive sign-in
        });
      } else {
        err.textContent = res?.error || "Failed to fetch OTPs. Please try again.";
      }
      err.hidden = false;
      return;
    }
    
    if (res.otps && res.otps.length > 0) {
      render(res.otps);
    } else {
      empty.textContent = "No OTPs found in recent emails.";
      empty.hidden = false;
    }
  } catch (error) {
    console.error("Error in loadOtps:", error);
    err.textContent = `Error: ${error.message || 'Unknown error occurred'}`;
    err.hidden = false;
    loading.hidden = true;
  }
}

document.addEventListener("DOMContentLoaded", loadOtps);
refreshBtn.addEventListener("click", loadOtps);


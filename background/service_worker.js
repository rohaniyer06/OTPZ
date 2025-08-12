import { GOOGLE_CLIENT_ID, GMAIL_SCOPE } from "../config.js";
import { fetchOtpsFromGmail } from "../services/gmail.js";

// Store token in extension storage so it's available even if the service worker sleeps.
const TOKEN_KEY = "oauth_token";
const EXPIRY_KEY = "oauth_token_expiry";

async function getSavedToken() {
  const { [TOKEN_KEY]: token, [EXPIRY_KEY]: expiry } = await chrome.storage.local.get([TOKEN_KEY, EXPIRY_KEY]);
  if (!token || !expiry) return null;
  if (Date.now() >= expiry) return null;
  return token;
}

async function saveToken(token, expiresInSec) {
  // small buffer so we refresh a bit early
  const expiry = Date.now() + (expiresInSec - 60) * 1000;
  await chrome.storage.local.set({ [TOKEN_KEY]: token, [EXPIRY_KEY]: expiry });
}

function parseFragmentParams(redirectUrl) {
  const hash = redirectUrl.split("#")[1] || "";
  return Object.fromEntries(new URLSearchParams(hash));
}

/**
 * Authenticate the user via OAuth implicit flow using chrome.identity.launchWebAuthFlow.
 * This uses a redirect URI of https://<EXTENSION_ID>.chromiumapp.org/ (must be whitelisted in GCP).
 */
async function getAccessTokenInteractive() {
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", GMAIL_SCOPE);
  authUrl.searchParams.set("prompt", "consent"); // always show for demo clarity
  authUrl.searchParams.set("include_granted_scopes", "true");

  const redirectResponse = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true
  });

  const { access_token, expires_in, token_type, error, error_description } = parseFragmentParams(redirectResponse);
  if (error) throw new Error(`OAuth error: ${error} ${error_description || ""}`);
  if (token_type !== "Bearer") throw new Error("Unexpected token type");
  if (!access_token) throw new Error("No access token returned");
  await saveToken(access_token, Number(expires_in || 3600));
  return access_token;
}

/**
 * Get a valid access token (re-use if not expired, else pop an OAuth window).
 */
async function getAccessToken() {
  const cached = await getSavedToken();
  if (cached) return cached;
  return await getAccessTokenInteractive();
}

// Handle popup requests
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_OTPS") {
    (async () => {
      try {
        const token = await getAccessToken();
        const otps = await fetchOtpsFromGmail(token);
        sendResponse({ ok: true, otps });
      } catch (err) {
        console.error(err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true; // indicate async response
  }
});


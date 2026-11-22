/**
 * Microsoft sign-in for long-lived credentials: authorization code + PKCE in a popup, answered by the static
 * callback page (auth/microsoft-callback.html), then swapped for tokens by the broker.
 *
 * - The popup is opened in the click handler itself (about:blank), before anything is awaited, so no pop-up blocker
 *   objects; the PKCE challenge is computed afterwards and the popup is then sent to Microsoft.
 * - The PKCE verifier and the state are random, live only in this closure and are dropped when the sign-in ends.
 * - The answer is accepted only from the window this code opened and only from the site's own origin. The page also
 *   broadcasts it on a BroadcastChannel named after the state, in case the browser cut the link to the opener (a
 *   cross-origin-opener-policy switch while the window was at Microsoft); that path is checked by the state alone.
 *   Either way the state must be the one sent, and the code is useless without the verifier that never left here.
 * - Nothing in here logs.
 */
import { ConnectFlowError } from "@/account/connectErrors";
import { MICROSOFT_CLIENT_ID } from "@/config/publicClients";

export const MICROSOFT_AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
/** Must include what the broker asks Microsoft for at the token endpoint: User.Read Files.ReadWrite offline_access. */
export const MICROSOFT_BROKER_SCOPES = "User.Read Files.ReadWrite offline_access openid profile";
export const MICROSOFT_CALLBACK_PATH = "auth/microsoft-callback.html";
/** Same literals as in src/microsoftCallback.ts, which has no imports on purpose. */
export const MICROSOFT_CALLBACK_MESSAGE = "narrarium:microsoft-callback";
export const MICROSOFT_CALLBACK_CHANNEL_PREFIX = "narrarium-microsoft-callback:";
export const MICROSOFT_SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const WINDOW_NAME = "narrarium-microsoft-sign-in";
const MAX_CODE_LENGTH = 4_096;

export interface MicrosoftAuthorization {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface MicrosoftSignInSession {
  /** Resolves with the code once the callback page reports it; rejects with a ConnectFlowError. */
  result: Promise<MicrosoftAuthorization>;
  cancel(): void;
}

/** The callback page, next to the site: it follows the base path the site is published under. */
export function microsoftCallbackUrl(): string {
  return new URL(MICROSOFT_CALLBACK_PATH, new URL(import.meta.env.BASE_URL, window.location.origin)).toString();
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomUrlSafe(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** PKCE S256: the URL-safe base64 of the SHA-256 of the verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function buildMicrosoftAuthorizeUrl(input: { redirectUri: string; state: string; codeChallenge: string }): string {
  const url = new URL(MICROSOFT_AUTHORIZE_URL);
  const parameters: Record<string, string> = {
    client_id: MICROSOFT_CLIENT_ID,
    response_type: "code",
    redirect_uri: input.redirectUri,
    response_mode: "query",
    scope: MICROSOFT_BROKER_SCOPES,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
    // So that Microsoft returns client_info, from which the account identity is built exactly as MSAL builds it.
    client_info: "1",
  };
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.toString();
}

function openSignInWindow(): Window {
  const width = 500;
  const height = 700;
  const left = Math.max(0, Math.round((window.screenX || 0) + ((window.outerWidth || width) - width) / 2));
  const top = Math.max(0, Math.round((window.screenY || 0) + ((window.outerHeight || height) - height) / 2));
  let popup: Window | null = null;
  try {
    popup = window.open("about:blank", WINDOW_NAME, `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
  } catch {
    popup = null;
  }
  if (!popup) throw new ConnectFlowError("popup_blocked");
  return popup;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let activeSession: { cancel(): void } | null = null;

/**
 * Starts a sign-in. Call it straight from the click handler: it opens the window synchronously and throws a
 * ConnectFlowError ("popup_blocked", "unsupported") when it cannot. Starting a new one cancels the one that waits.
 */
export function beginMicrosoftSignIn(options: { timeoutMs?: number } = {}): MicrosoftSignInSession {
  if (typeof crypto === "undefined" || !crypto.subtle) throw new ConnectFlowError("unsupported");
  activeSession?.cancel();
  const popup = openSignInWindow();

  const redirectUri = microsoftCallbackUrl();
  const state = randomUrlSafe(24);
  let verifier: string | null = randomUrlSafe(48);
  let settled = false;
  let resolveResult!: (authorization: MicrosoftAuthorization) => void;
  let rejectResult!: (error: ConnectFlowError) => void;
  const result = new Promise<MicrosoftAuthorization>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // The caller handles the rejection; this only keeps a cancelled, unobserved sign-in from being reported as unhandled.
  result.catch(() => undefined);

  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(`${MICROSOFT_CALLBACK_CHANNEL_PREFIX}${state}`) : null;
  const timer = setTimeout(() => fail(new ConnectFlowError("timed_out")), options.timeoutMs ?? MICROSOFT_SIGN_IN_TIMEOUT_MS);
  const handle = { cancel: () => fail(new ConnectFlowError("cancelled")) };

  function finish(): boolean {
    if (settled) return false;
    settled = true;
    window.removeEventListener("message", onMessage);
    if (channel) { channel.onmessage = null; channel.close(); }
    clearTimeout(timer);
    if (activeSession === handle) activeSession = null;
    try { popup.close(); } catch { /* the window is already gone */ }
    return true;
  }

  function fail(error: ConnectFlowError): void {
    if (!finish()) return;
    verifier = null;
    rejectResult(error);
  }

  function handleAnswer(data: unknown): void {
    if (settled || !isRecord(data) || data.type !== MICROSOFT_CALLBACK_MESSAGE || typeof data.state !== "string") return;
    if (data.state !== state) return fail(new ConnectFlowError("state_mismatch"));
    if (data.error !== undefined) {
      if (data.error === "access_denied") return fail(new ConnectFlowError("access_denied"));
      const providerError = typeof data.error === "string" && /^[a-z0-9_]{1,64}$/.test(data.error) ? data.error : undefined;
      return fail(new ConnectFlowError("provider_error", undefined, { providerError }));
    }
    const { code } = data;
    if (typeof code !== "string" || code.length > MAX_CODE_LENGTH || !/^[\x21-\x7e]+$/.test(code) || verifier === null) return fail(new ConnectFlowError("invalid_response"));
    const codeVerifier = verifier;
    if (finish()) {
      verifier = null;
      resolveResult({ code, codeVerifier, redirectUri });
    }
  }

  function onMessage(event: MessageEvent): void {
    // Only the window opened for this sign-in, and only from the site's own origin.
    if (event.origin !== window.location.origin || event.source !== popup) return;
    handleAnswer(event.data);
  }

  window.addEventListener("message", onMessage);
  if (channel) channel.onmessage = (event) => handleAnswer(event.data);
  activeSession = handle;

  void (async () => {
    try {
      const challenge = await pkceChallenge(verifier ?? "");
      if (settled) return;
      popup.location.replace(buildMicrosoftAuthorizeUrl({ redirectUri, state, codeChallenge: challenge }));
    } catch {
      fail(new ConnectFlowError("cancelled"));
    }
  })();

  return { result, cancel: handle.cancel };
}

export function resetMicrosoftSignInForTests(): void {
  activeSession?.cancel();
  activeSession = null;
}

const ACCOUNT_ID_PART = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The account identity MSAL builds from the token response's client_info (base64url JSON {uid, utid}):
 * homeAccountId = "<uid>.<utid>" and localAccountId = uid, the same for personal and work or school accounts.
 * Anything unusable is refused: guessing an identity could attach a connection to the wrong account.
 */
export function microsoftIdentityFromClientInfo(clientInfo: string): { homeAccountId: string; localAccountId: string } {
  const invalid = () => new ConnectFlowError("invalid_response", "Microsoft did not return usable account identifiers.");
  if (typeof clientInfo !== "string" || clientInfo.length === 0 || clientInfo.length > 2_048) throw invalid();
  let decoded: unknown;
  try {
    let encoded = clientInfo.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    if (encoded.length % 4 === 1) throw invalid();
    encoded += "=".repeat((4 - (encoded.length % 4)) % 4);
    const binary = atob(encoded);
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0)));
  } catch {
    throw invalid();
  }
  if (!isRecord(decoded)) throw invalid();
  const { uid, utid } = decoded;
  if (typeof uid !== "string" || typeof utid !== "string" || !ACCOUNT_ID_PART.test(uid) || !ACCOUNT_ID_PART.test(utid)) throw invalid();
  return { homeAccountId: `${uid}.${utid}`, localAccountId: uid };
}

import { PublicClientApplication, type AccountInfo, type Configuration, type IPublicClientApplication, type SilentRequest } from "@azure/msal-browser";
import { MICROSOFT_CLIENT_ID } from "@/config/publicClients";

export const MICROSOFT_SCOPES = ["User.Read", "Files.ReadWrite"];
export const MICROSOFT_REMEMBER_ME_KEY = "narrarium-microsoft-remember-v1";

function redirectUri(): string {
  return new URL("msal-popup.html", new URL(import.meta.env.BASE_URL, window.location.origin)).toString();
}

export function microsoftSilentRequest(account: AccountInfo): SilentRequest {
  return {
    scopes: MICROSOFT_SCOPES,
    account,
    redirectUri: redirectUri(),
  };
}

export function findMicrosoftAccountIn(input: { homeAccountId?: string; localAccountId?: string; email?: string }, accounts: AccountInfo[]): AccountInfo | null {
  if (!input.homeAccountId?.trim() || !input.localAccountId?.trim()) return null;
  return accounts.find((account) => account.homeAccountId === input.homeAccountId && account.localAccountId === input.localAccountId) ?? null;
}

function msalConfig(cacheLocation: "sessionStorage" | "localStorage"): Configuration {
  return {
  auth: {
    clientId: MICROSOFT_CLIENT_ID,
    authority: "https://login.microsoftonline.com/common",
    redirectUri: redirectUri(),
  },
  cache: {
    cacheLocation,
  },
  };
}

export const sessionMsalInstance = new PublicClientApplication(msalConfig("sessionStorage"));
export const persistentMsalInstance = new PublicClientApplication(msalConfig("localStorage"));

export function microsoftRememberMeEnabled(): boolean {
  try { return localStorage.getItem(MICROSOFT_REMEMBER_ME_KEY) === "1"; }
  catch { return false; }
}

export function microsoftMsalInstance(rememberMe = microsoftRememberMeEnabled()): PublicClientApplication {
  return rememberMe ? persistentMsalInstance : sessionMsalInstance;
}

export function setMicrosoftRememberMe(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(MICROSOFT_REMEMBER_ME_KEY, "1");
    else localStorage.removeItem(MICROSOFT_REMEMBER_ME_KEY);
  } catch { /* Session-only Microsoft auth remains available when storage is restricted. */ }
}

/** Backward-compatible default for non-React call sites; new flows should choose explicitly. */
export const msalInstance = sessionMsalInstance;

const initializePromises = new WeakMap<IPublicClientApplication, Promise<void>>();

export function ensureMsalInitialized(instance: IPublicClientApplication = microsoftMsalInstance()): Promise<void> {
  let promise = initializePromises.get(instance);
  if (!promise) {
    promise = instance.initialize();
    initializePromises.set(instance, promise);
  }
  return promise;
}

export async function clearMicrosoftAuthCaches(): Promise<void> {
  setMicrosoftRememberMe(false);
  await Promise.all([sessionMsalInstance, persistentMsalInstance].map(async (instance) => {
    await ensureMsalInitialized(instance);
    await instance.clearCache().catch(() => undefined);
  }));
}

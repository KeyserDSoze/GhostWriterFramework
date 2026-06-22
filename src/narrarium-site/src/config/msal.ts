import { PublicClientApplication, type AccountInfo, type Configuration, type SilentRequest } from "@azure/msal-browser";

export const MICROSOFT_SCOPES = ["User.Read", "Files.ReadWrite"];

function redirectUri(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

export function microsoftSilentRequest(account: AccountInfo): SilentRequest {
  return {
    scopes: MICROSOFT_SCOPES,
    account,
    redirectUri: redirectUri(),
  };
}

export function findMicrosoftAccountByEmail(email: string | undefined): AccountInfo | null {
  const accounts = msalInstance.getAllAccounts();
  if (email) {
    const normalized = email.trim().toLowerCase();
    const match = accounts.find((account) => {
      const candidates = [account.username, account.upn, account.loginHint].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      return candidates.some((value) => value.trim().toLowerCase() === normalized);
    });
    if (match) return match;
  }
  return msalInstance.getActiveAccount() ?? (accounts.length === 1 ? accounts[0] : null);
}

const msalConfig: Configuration = {
  auth: {
    clientId: (import.meta.env.VITE_MICROSOFT_CLIENT_ID as string | undefined) ?? "",
    authority: "https://login.microsoftonline.com/common",
    redirectUri: redirectUri(),
  },
  cache: {
    cacheLocation: "localStorage",
  },
};

export const msalInstance = new PublicClientApplication(msalConfig);

let initializePromise: Promise<void> | null = null;

export function ensureMsalInitialized(): Promise<void> {
  initializePromise ??= msalInstance.initialize();
  return initializePromise;
}

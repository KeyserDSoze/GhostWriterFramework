import { credentialVaultAvailable } from "@/account/credentialVault";

/**
 * How a Google Drive or OneDrive connection stays signed in:
 * - "long-lived": it holds a refresh token that renews itself and survives closing the app (remembered, and this
 *   browser can keep it safely);
 * - "long-lived-memory": it holds a refresh token, but only for as long as this tab stays open;
 * - "session": no refresh token; the access token lasts about an hour (Google) or a day (Microsoft).
 */
export type CredentialMode = "long-lived" | "long-lived-memory" | "session";

export function credentialMode(connection: { refreshToken?: string; rememberMe: boolean }): CredentialMode {
  if (!connection.refreshToken) return "session";
  return connection.rememberMe && credentialVaultAvailable() ? "long-lived" : "long-lived-memory";
}

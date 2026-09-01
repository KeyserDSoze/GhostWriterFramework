import { findMicrosoftAccountIn, ensureMsalInitialized, microsoftMsalInstance, microsoftSilentRequest } from "@/config/msal";
import { AccountCredentialError, useConnectionStore } from "@/account/connectionStore";
import { registerCloudAccount } from "@/drive/cloudWriteBarrier";
import { useAuthStore } from "@/store/authStore";

function requiresMicrosoftInteraction(error: unknown): boolean {
  const value = error && typeof error === "object" ? error as { errorCode?: unknown; subError?: unknown; message?: unknown } : {};
  const detail = [value.errorCode, value.subError, value.message].filter((entry): entry is string => typeof entry === "string").join(" ").toLowerCase();
  return /interaction_required|login_required|consent_required|no_account/.test(detail);
}

export async function acquireMicrosoftConnectionToken(): Promise<string> {
  const connection = useConnectionStore.getState().configuration.microsoft;
  if (!connection) throw new AccountCredentialError("onedrive", "missing");
  const instance = microsoftMsalInstance(connection.rememberMe);
  await ensureMsalInitialized(instance);
  const account = findMicrosoftAccountIn(connection, instance.getAllAccounts());
  if (!account) throw new AccountCredentialError("onedrive", "expired");

  let result;
  try {
    const forceRefresh = connection.replica.errorKind === "credential-expired"
      || !connection.accessTokenExpiry
      || connection.accessTokenExpiry <= Date.now() + 60_000;
    result = await instance.acquireTokenSilent({ ...microsoftSilentRequest(account), forceRefresh });
  } catch (error) {
    if (requiresMicrosoftInteraction(error)) throw new AccountCredentialError("onedrive", "expired");
    throw error;
  }
  if (!result.account || result.account.homeAccountId !== connection.homeAccountId || result.account.localAccountId !== connection.localAccountId) {
    throw new AccountCredentialError("onedrive", "expired");
  }

  const expiresAt = result.expiresOn?.getTime() ?? Date.now() + 3_600_000;
  const bufferedExpiry = Math.max(Date.now() + 60_000, expiresAt - 60_000);
  await useConnectionStore.getState().updateAccessToken("onedrive", result.accessToken, bufferedExpiry);
  instance.setActiveAccount(result.account);
  registerCloudAccount("microsoft", result.accessToken, connection.identity.providerAccountId);

  const auth = useAuthStore.getState();
  if (auth.user?.provider === "microsoft"
    && auth.user.homeAccountId === connection.homeAccountId
    && auth.user.localAccountId === connection.localAccountId) {
    auth.setAuth(result.accessToken, auth.user, Math.max(120, Math.round((expiresAt - Date.now()) / 1_000)));
  }
  return result.accessToken;
}

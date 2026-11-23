import type { TFunction } from "i18next";
import type { AccountSyncBackendKind, AccountSyncErrorKind } from "@/account/types";

/** A sync of one service that failed, with the kind of failure the page words in the app language. */
export class AccountSyncFailure extends Error {
  constructor(readonly backend: AccountSyncBackendKind, readonly kind: AccountSyncErrorKind, message: string) {
    super(message);
    this.name = "AccountSyncFailure";
  }
}

export function accountServiceName(backend: AccountSyncBackendKind): string {
  return backend === "google-drive" ? "Google Drive" : backend === "onedrive" ? "OneDrive" : "GitHub";
}

/** What the sign-in that has to be renewed is called in the page: «Reconnect OneDrive», in the app language. */
export function reconnectLabel(backend: AccountSyncBackendKind, t: TFunction): string {
  return t("accountSync.card.reconnectService", { service: accountServiceName(backend) });
}

/** The sentence for a failed sync of one service: the renewal of a sign-in in plain words, anything else as it came. */
export function describeSyncFailure(error: unknown, t: TFunction): string {
  if (error instanceof AccountSyncFailure && (error.kind === "credential-expired" || error.kind === "credential-missing")) {
    return t("accountSync.error.credential-expired", { service: accountServiceName(error.backend) });
  }
  return String(error);
}

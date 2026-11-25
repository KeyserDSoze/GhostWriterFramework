import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en";
import italian from "@/i18n/locales/it";
import type { SyncIndicatorState } from "@/account/syncStatus";
import type { AccountSyncErrorKind, LocalReplicaState } from "@/account/types";

// Adding a member to one of these unions without listing it here is a compile error, so no state goes without a text.
const ERROR_KINDS: Record<AccountSyncErrorKind, true> = {
  offline: true, "credential-missing": true, "credential-invalid": true, "credential-expired": true, "permission-denied": true, "remote-not-found": true, "remote-deleted": true, "remote-public": true, "repository-unreachable": true,
  "rate-limited": true, "cache-revalidation": true, "remote-changed": true, network: true, "schema-incompatible": true, "remote-corrupt": true, "hash-mismatch": true, unknown: true,
};
const REPLICA_STATUSES: Record<LocalReplicaState["status"], true> = { disabled: true, idle: true, dirty: true, syncing: true, "needs-auth": true, offline: true, behind: true, ahead: true, diverged: true, error: true };
const INDICATOR_STATES: Record<SyncIndicatorState, true> = { synced: true, syncing: true, pending: true, "needs-login": true, failed: true, "remote-offline": true, "device-offline": true };
const ATTENTION: SyncIndicatorState[] = ["needs-login", "failed", "remote-offline", "device-offline"];

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => typeof value === "string" ? [[`${prefix}${key}`, value]] : Object.entries(flatten(value, `${prefix}${key}.`))));
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();

describe.each(["accountSync", "syncStatus"] as const)("%s texts", (namespace) => {
  const english = flatten((en as unknown as Record<string, Tree>)[namespace]);
  const translated = flatten((italian as unknown as Record<string, Tree>)[namespace]);

  it("exist under the same keys in English and Italian", () => {
    expect(Object.keys(translated).sort()).toEqual(Object.keys(english).sort());
  });

  it("are never empty, and keep the same placeholders in both languages", () => {
    for (const [key, text] of Object.entries(english)) {
      expect(text.trim(), `${namespace}.${key} (en)`).not.toBe("");
      expect(translated[key].trim(), `${namespace}.${key} (it)`).not.toBe("");
      expect(placeholders(translated[key]), `${namespace}.${key}`).toEqual(placeholders(text));
    }
  });
});

describe("account sync texts cover every state", () => {
  const sets = [["en", en], ["it", italian]] as const;

  it.each(sets)("explains every error kind and words every replica status in %s", (_language, locale) => {
    const error = flatten(locale.accountSync.error as unknown as Tree);
    const state = flatten(locale.accountSync.state as unknown as Tree);
    expect(Object.keys(error).sort()).toEqual(Object.keys(ERROR_KINDS).sort());
    expect(Object.keys(state).sort()).toEqual(Object.keys(REPLICA_STATUSES).sort());
  });

  it.each(sets)("gives every indicator state a short label and a tooltip, and every attention state an announcement in %s", (_language, locale) => {
    const status = locale.syncStatus;
    expect(Object.keys(status.state).sort()).toEqual(Object.keys(INDICATOR_STATES).sort());
    for (const state of Object.keys(INDICATOR_STATES)) expect((status.tooltip as Record<string, string>)[state], state).toBeTruthy();
    expect(Object.keys(status.announce).sort()).toEqual([...ATTENTION, "synced"].sort());
  });

  it("translates the sentences that explain an error instead of copying the English ones", () => {
    for (const kind of Object.keys(ERROR_KINDS)) expect((italian.accountSync.error as Record<string, string>)[kind]).not.toBe((en.accountSync.error as Record<string, string>)[kind]);
  });
});

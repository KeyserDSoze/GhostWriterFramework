import { READER_RELOAD_PARAM, decideFreshness, versionCheckUrl } from "./reader-freshness.js";
import { READER_FORMAT, isReaderVersionFile, type ReaderBundle, type ReaderVersionFile } from "./reader-protocol.js";
import { openAsset, openBundle, unwrapContentKey } from "./reader-unlock.js";

/**
 * Opening the published book in the browser, with the browser's APIs passed in (the tests run it in Node):
 *  1. the current `version.json` (no-store, a query never seen before), or the copy the shell was built with when offline;
 *  2. one reload when the shell is not the current one (see `reader-freshness.ts`);
 *  3. for a protected book, the password: the remembered one is tried against the CURRENT slots on every open; when it opens none it is
 *     forgotten and the reader is told it is no longer valid (offline, with only the shell's own copy of the slots, it is kept);
 *  4. the bundle, by its hashed name, decrypted when needed.
 */

export interface ReaderBoot {
  /** The build the shell belongs to. */
  version: string;
  bookId: string;
  /** The `version.json` of that build: what the shell reads with when `version.json` cannot be fetched. */
  fallback: ReaderVersionFile;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface ReaderSessionDeps {
  fetch: typeof fetch;
  local: StorageLike;
  session: StorageLike;
  /** The address of the page now. */
  href: string;
  /** The base the site's relative addresses resolve from (`document.baseURI`). */
  baseHref: string;
  replaceLocation(url: string): void;
  now?(): number;
}

export type PasswordReason = "first" | "wrong" | "revoked" | "unverified";

export interface PasswordAnswer {
  password: string;
  remember: boolean;
}

/** Shows the lock and resolves with what the reader typed; `reason` says what to tell them first. */
export type PasswordPrompt = (reason: PasswordReason) => Promise<PasswordAnswer>;

export interface OpenedReader {
  kind: "open";
  versionFile: ReaderVersionFile;
  bundle: ReaderBundle;
  /** False when `version.json` could not be fetched and the shell's own copy was used. */
  online: boolean;
  /** True when the HTML is older than `version.json` even after the one reload: the content is the current one all the same. */
  staleShell: boolean;
  /** The bytes of an artifact of this build (an image, the EPUB), decrypted when the book is protected. */
  loadArtifact(artifactPath: string): Promise<Uint8Array>;
  /** Forget the password this device remembers for the book. */
  forgetPassword(): void;
}

export type ReaderSessionResult = OpenedReader | { kind: "reloading"; url: string };

export class ReaderOpenError extends Error {
  constructor(readonly code: "unsupported" | "bundle-unavailable" | "bundle-invalid", message: string) {
    super(message);
    this.name = "ReaderOpenError";
  }
}

export function readerStorageKeys(bookId: string) {
  const prefix = `narrarium-reader:${bookId}:`;
  return {
    password: `${prefix}password`,
    slot: `${prefix}slot`,
    reloadedFor: `${prefix}reloaded-for`,
    prefix,
  };
}

/** The key of the old reader (an AES key derived for one build); useless with the slots, removed on sight. */
const LEGACY_KEY = "narrarium-reader-aes-key";

function safe<T>(operation: () => T, fallback: T): T {
  try {
    return operation();
  } catch {
    return fallback;
  }
}

async function fetchCurrentVersion(boot: ReaderBoot, deps: ReaderSessionDeps): Promise<{ file: ReaderVersionFile; online: boolean }> {
  try {
    const response = await deps.fetch(versionCheckUrl(deps.baseHref, deps.now?.() ?? Date.now()), { cache: "no-store" });
    if (response.ok) {
      const file: unknown = await response.json();
      if (isReaderVersionFile(file)) return { file, online: true };
    }
  } catch {
    // Offline, or the host is down: the shell's own copy is what there is.
  }
  return { file: boot.fallback, online: false };
}

async function fetchBytes(deps: ReaderSessionDeps, artifactPath: string): Promise<Uint8Array> {
  const response = await deps.fetch(new URL(artifactPath, deps.baseHref).toString());
  if (!response.ok) throw new ReaderOpenError("bundle-unavailable", `The book could not be downloaded (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function openReaderSession(boot: ReaderBoot, deps: ReaderSessionDeps, prompt: PasswordPrompt): Promise<ReaderSessionResult> {
  safe(() => deps.local.removeItem(LEGACY_KEY), undefined);
  const keys = readerStorageKeys(boot.bookId);
  const { file: versionFile, online } = await fetchCurrentVersion(boot, deps);

  if (versionFile.format !== READER_FORMAT) {
    throw new ReaderOpenError("unsupported", "This book was published by a newer reader: reload the page.");
  }

  const reloadedFor = safe(() => deps.session.getItem(keys.reloadedFor), null);
  const freshness = decideFreshness({ shellVersion: boot.version, latestVersion: versionFile.version, reloadedFor, href: deps.href });
  if (freshness.action === "reload") {
    safe(() => deps.session.setItem(keys.reloadedFor, versionFile.version), undefined);
    deps.replaceLocation(freshness.url);
    return { kind: "reloading", url: freshness.url };
  }

  let key: CryptoKey | undefined;
  if (versionFile.protected && versionFile.protection) {
    const protection = versionFile.protection;
    const hint = Number(safe(() => deps.local.getItem(keys.slot), null) ?? "");
    const preferred = Number.isInteger(hint) ? hint : undefined;
    const remembered = safe(() => deps.local.getItem(keys.password), null);
    let reason: PasswordReason = "first";
    if (remembered) {
      const unlocked = await unwrapContentKey(remembered, protection, preferred);
      if (unlocked) {
        key = unlocked.key;
        safe(() => deps.local.setItem(keys.slot, String(unlocked.slot)), undefined);
      } else if (online) {
        // The slots are the published ones: this password is not in the list any more.
        safe(() => deps.local.removeItem(keys.password), undefined);
        safe(() => deps.local.removeItem(keys.slot), undefined);
        reason = "revoked";
      } else {
        // Only the shell's own copy of the slots: a password that it does not open may still be a current one.
        reason = "unverified";
      }
    }
    while (!key) {
      const answer = await prompt(reason);
      const unlocked = await unwrapContentKey(answer.password, protection, preferred);
      if (!unlocked) {
        reason = "wrong";
        continue;
      }
      key = unlocked.key;
      if (answer.remember) {
        safe(() => deps.local.setItem(keys.password, answer.password), undefined);
        safe(() => deps.local.setItem(keys.slot, String(unlocked.slot)), undefined);
      } else {
        safe(() => deps.local.removeItem(keys.password), undefined);
        safe(() => deps.local.removeItem(keys.slot), undefined);
      }
    }
  }

  const raw = await fetchBytes(deps, versionFile.bundle.path);
  let bundle: ReaderBundle;
  try {
    const text = key ? await openBundle(key, raw) : new TextDecoder().decode(raw);
    bundle = JSON.parse(text) as ReaderBundle;
  } catch {
    throw new ReaderOpenError("bundle-invalid", "The book could not be opened: its file is damaged or from another build. Reload the page.");
  }
  if (!bundle || bundle.format !== READER_FORMAT || !Array.isArray(bundle.chapters)) {
    throw new ReaderOpenError("bundle-invalid", "The book could not be opened: its file is not one this reader knows.");
  }

  const contentKey = key;
  return {
    kind: "open",
    versionFile,
    bundle,
    online,
    staleShell: freshness.action === "stale-shell",
    async loadArtifact(artifactPath: string) {
      const bytes = await fetchBytes(deps, artifactPath);
      return contentKey ? openAsset(contentKey, bytes) : bytes;
    },
    forgetPassword() {
      safe(() => deps.local.removeItem(keys.password), undefined);
      safe(() => deps.local.removeItem(keys.slot), undefined);
    },
  };
}

export { READER_RELOAD_PARAM };

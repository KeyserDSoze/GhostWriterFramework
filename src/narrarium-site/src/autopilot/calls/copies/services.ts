import type { AiCallStore } from "narrarium-engine";
import { CallsCopier } from "./copier";
import { LocalStorageCopyLedger, MemoryCopyLedger, MemoryCopyOutbox } from "./stores";
import { CopyError, type CopyLedger, type CopyOutbox, type CopyTarget, type CopyTargetKind } from "./types";
import { bookStorageMode, resolveGitHubRemoteToken } from "@/types/settings";
import { useSettingsStore } from "@/store/settingsStore";
import { useConnectionStore } from "@/account/connectionStore";
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";

/**
 * What the copies need from the rest of the app, in one place. A host fills in what it owns: the browser's `AiCallStore` (the records on this
 * device) and its persistent `outbox`, after the merge; until then the outbox is in memory and the store is absent (the page then says nothing of
 * the size on this device, and nothing is copied). Everything else is the site's own: the connections, their tokens and the book's GitHub token.
 */
export interface CopyServices {
  store: () => AiCallStore | null;
  outbox: CopyOutbox;
  ledger: CopyLedger;
  /** Deletes a book's records on this device, and on the personal server when the book runs there (the two go together). */
  deleteRecords?: (bookId: string, host: "browser" | "server") => Promise<void>;
  /** The target of a book's copies; the site's own by default (`openSiteTarget`). */
  openTarget?: (bookId: string, kind: CopyTargetKind) => Promise<CopyTarget>;
  scope?: () => string | null;
  online?: () => boolean;
}

let configured: Partial<CopyServices> = {};
let copier: CallsCopier | null = null;
let defaults: Pick<CopyServices, "outbox" | "ledger"> | null = null;
const listeners = new Set<(bookId: string, kind: CopyTargetKind) => void>();

/** Gives the copier what the host owns (call when the browser's records are opened). The copier reads it at each call, so one made before is not stale. */
export function configureCopyServices(services: Partial<CopyServices>): void {
  configured = { ...configured, ...services };
}

export function resetCopyServicesForTests(): void {
  configured = {};
  copier = null;
  defaults = null;
  listeners.clear();
}

/** Calls `listener` when the outbox or the ledger of a book changed. Returns what stops it. */
export function onCopyChange(listener: (bookId: string, kind: CopyTargetKind) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function localDefaults(): Pick<CopyServices, "outbox" | "ledger"> {
  defaults ??= {
    outbox: new MemoryCopyOutbox(),
    ledger: typeof window !== "undefined" && window.localStorage ? new LocalStorageCopyLedger() : new MemoryCopyLedger(),
  };
  return defaults;
}

export function copyServices(): CopyServices {
  const base = localDefaults();
  return { store: () => null, outbox: base.outbox, ledger: base.ledger, ...configured };
}

/** The target of a book on one of the three services, with the connection the author already has. A missing or lapsed sign-in is `reconnect`. */
export async function openSiteTarget(bookId: string, kind: CopyTargetKind): Promise<CopyTarget> {
  if (kind === "github") {
    const settings = useSettingsStore.getState().settings;
    const book = settings.books.find((entry) => entry.id === bookId);
    if (!book || bookStorageMode(book) !== "github" || !book.owner || !book.repo) throw new CopyError("unavailable", "This book has no GitHub repository.");
    const token = resolveGitHubRemoteToken(book, settings);
    if (!token) throw new CopyError("reconnect", "There is no GitHub token for this book.");
    const [{ GitHubCopyTarget }, { OctokitGitHubApi }] = await Promise.all([import("./targets/github"), import("./targets/githubOctokit")]);
    return new GitHubCopyTarget(new OctokitGitHubApi(token, book.owner, book.repo));
  }
  const configuration = useConnectionStore.getState().configuration;
  if (kind === "google-drive") {
    const connection = configuration.google;
    if (!connection) throw new CopyError("reconnect", "Google Drive is not connected.");
    const { acquireGoogleConnectionToken } = await import("@/account/googleConnectionToken");
    const [token, { DriveCopyTarget }, { GoogleDriveFetchApi }] = await Promise.all([acquireGoogleConnectionToken(), import("./targets/drive"), import("./targets/googleFetch")]);
    return new DriveCopyTarget(new GoogleDriveFetchApi(token, connection.identity.providerAccountId), bookId);
  }
  const connection = configuration.microsoft;
  if (!connection) throw new CopyError("reconnect", "OneDrive is not connected.");
  const { acquireMicrosoftConnectionToken } = await import("@/account/microsoftConnectionToken");
  const [token, { OneDriveCopyTarget }, { GraphFetchApi }] = await Promise.all([acquireMicrosoftConnectionToken(), import("./targets/onedrive"), import("./targets/graphFetch")]);
  return new OneDriveCopyTarget(new GraphFetchApi(token, connection.identity.providerAccountId), bookId);
}

/** The one copier of the page. It reads `copyServices()` at each call, so a host that configures the services after the page started is still heard. */
export function callsCopier(): CallsCopier {
  if (copier) return copier;
  copier = new CallsCopier({
    store: () => copyServices().store(),
    get outbox() { return copyServices().outbox; },
    get ledger() { return copyServices().ledger; },
    scope: () => (copyServices().scope ?? currentRepositoryScopeIdentity)(),
    openTarget: (bookId, kind) => (copyServices().openTarget ?? openSiteTarget)(bookId, kind),
    online: () => (copyServices().online ?? (() => typeof navigator === "undefined" || navigator.onLine !== false))(),
    onChange: (bookId, kind) => { for (const listener of [...listeners]) listener(bookId, kind); },
  });
  return copier;
}

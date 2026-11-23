import type { GithubConflict, ServerBookSync } from "narrarium-engine";
import { seedRun, type RunSeed } from "./autopilotBand";
import { FakeBookServer } from "./fakeBookServer";
import { GITHUB_BOOK, T0 } from "./quickCommands";
import type { BookEntry } from "@/types/settings";

/** A GitHub book that the personal server runs: what the autopilot page, the error panel and «Where it runs» show for it. */
export const CONFLICT_BOOK: BookEntry = { ...GITHUB_BOOK, autopilotHost: "server", activeBranch: "main", bookToken: "ghp_book_token" };

export const conflictOf = (path: string, patch: Partial<GithubConflict> = {}): GithubConflict => ({ path, server: "modified", github: "modified", serverBytes: 1_200, githubBytes: 2_048, resolvable: true, ...patch });

/** `count` files of one folder, in the order of their paths (the order the server lists them in). */
export const conflictsOf = (count: number, folder = "chapters"): GithubConflict[] =>
  Array.from({ length: count }, (_, index) => conflictOf(`${folder}/${String(index + 1).padStart(4, "0")}-the-key.md`));

/** The words of the real server's error for a run that stopped on a conflict with GitHub. */
export const conflictMessage = (count: number): string =>
  `The book changed on GitHub in a way that conflicts with the server's work (${count} ${count === 1 ? "file" : "files"}). Resolve it in the app (Where it runs, or the error panel), then resume.`;

/** A personal server that announces the conflicts with GitHub and has `count` of them. */
export function conflictedServer(count = 3, patch: Partial<FakeBookServer> = {}): FakeBookServer {
  const server = new FakeBookServer();
  server.githubConflicts = true;
  server.conflicts = conflictsOf(count);
  return Object.assign(server, patch);
}

export interface ConflictedBook extends Omit<RunSeed, "book" | "server"> {
  /** How many files the run says it stopped on (default: the server's). */
  files?: number;
  /** `lastSync` of the book on the server. */
  lastSync?: ServerBookSync | null;
  server?: RunSeed["server"];
}

/**
 * What the page reads for a book that the server runs and that stopped on a conflict with GitHub: the stopped run (`status: "error"`, the typed error the engine leaves in
 * `lastError`), the server online with the features the fake announces, and the summary of the book on the server. Seeded in the stores: nothing is drawn.
 */
export function seedConflictedBook(server: FakeBookServer, seed: ConflictedBook = {}) {
  const { files = server.conflicts.length, lastSync, server: serverState = "online", status = "error", statePatch, ...rest } = seed;
  const stopped = status === "error";
  return seedRun({
    book: CONFLICT_BOOK,
    server: serverState,
    serverInfo: server.info(),
    serverHoldsToken: true,
    serverLastSync: lastSync === undefined ? (stopped ? { at: T0, ok: false, message: conflictMessage(files), conflicts: files } : null) : lastSync,
    status,
    statePatch: stopped ? { lastError: { message: conflictMessage(files), at: T0, errorKind: "conflict", errorDetail: { githubConflicts: files } }, ...statePatch } : statePatch,
    ...rest,
  });
}

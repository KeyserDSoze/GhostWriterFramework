import { GITHUB_CONFLICT_CODE, ServerRequestError, serverSupportsGithubConflicts, type ServerInfo } from "narrarium-engine";
import { useAutopilotStore } from "@/autopilot/store";

/**
 * What the runtime knows of the conflicts of a book on the personal server with GitHub, apart from the two calls that list and resolve them: whether the server can do it at
 * all, and the answer of a sync that stopped on one, which the server keeps in the summary of the book (`lastSync.conflicts`) and the app keeps as the server does.
 */

/** The words of the refusal of a server that does not announce the feature (the engine's own client says the same, after it has asked the server's info). */
const OLD_SERVER = "This personal server cannot resolve the conflicts with GitHub (it does not announce the feature github-conflicts): update the server.";

/** A server that predates the conflicts with GitHub answers 404 to their routes: it is refused here, before anything is sent, as the engine's client refuses it. */
export function assertGithubConflicts(info: Pick<ServerInfo, "features"> | null | undefined): void {
  if (!serverSupportsGithubConflicts(info)) throw new ServerRequestError(OLD_SERVER, 501, "feature_unavailable");
}

/** Whether a failure is the server's answer to a sync that met a conflict with GitHub (`409 github_conflict`). */
export function isGithubConflict(error: unknown): error is ServerRequestError {
  return error instanceof ServerRequestError && error.code === GITHUB_CONFLICT_CODE;
}

/** How many files the server says conflict, in its answer: a whole number from one, or `null` when it says none. */
export function githubConflictFiles(error: unknown): number | null {
  if (!isGithubConflict(error)) return null;
  const files = error.details.conflicts;
  return typeof files === "number" && Number.isInteger(files) && files >= 1 ? files : null;
}

/**
 * A sync that the server answered with a conflict is kept in the summary of the book on the server, as the server keeps it in its own (`lastSync` says it failed, with how
 * many files): «Where it runs» reads it there, so it shows the way to settle it at once, without waiting for the stream to bring the server's summary. A conflict that says no
 * number is not kept: its words are all there is.
 */
export function noteGithubConflict(bookId: string, error: unknown): void {
  const conflicts = githubConflictFiles(error);
  if (conflicts === null) return;
  const store = useAutopilotStore.getState();
  const server = store.views[bookId]?.server;
  if (!server) return;
  store.patchView(bookId, { server: { ...server, lastSync: { at: new Date().toISOString(), ok: false, message: (error as ServerRequestError).message, conflicts } } });
}

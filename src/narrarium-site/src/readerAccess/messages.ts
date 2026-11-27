import type { ReaderFailure } from "@/readerAccess/errors";
import { permissionLabel } from "@/readerAccess/errors";
import type { ReaderOperationResult, ReaderOperationStep } from "@/readerAccess/operations";
import type { GitHubTokenKind } from "@/github/bookRepository";

/**
 * The words for what happened, as i18n keys and their parameters (the texts are `readerAccess.*`). Pure, so that every case can be checked without a screen.
 * A message names the step, what is already done and what the published reader is doing now, and never carries GitHub's own text or any password.
 */
export interface ReaderText { key: string; params?: Record<string, unknown> }

export type ReaderOperationKind = "add" | "remove" | "resume" | "republish" | "enable-pages" | "disable-pages" | "refresh";

/** Why a call failed, in one sentence. `tokenKind` decides where the owner is told to add a missing permission. */
export function describeReaderFailure(failure: ReaderFailure, tokenKind: GitHubTokenKind = "unknown"): ReaderText {
  switch (failure.kind) {
    case "permission":
      return { key: `readerAccess.failure.permission.${tokenKind === "app" || tokenKind === "fine-grained" || tokenKind === "classic" ? tokenKind : "unknown"}`, params: { permission: failure.permissions.map(permissionLabel).join(", "), count: failure.permissions.length } };
    case "not-found":
      return { key: "readerAccess.failure.notFound", params: { permission: failure.permissions.map(permissionLabel).join(", "), count: failure.permissions.length } };
    case "rate-limit":
      return { key: failure.resetAt ? "readerAccess.failure.rateLimitAt" : "readerAccess.failure.rateLimit", params: { time: failure.resetAt } };
    case "no-dispatch": return { key: "readerAccess.failure.noDispatch" };
    case "plan": return { key: "readerAccess.failure.plan" };
    case "sso": return { key: "readerAccess.failure.sso" };
    case "credential": return { key: "readerAccess.failure.credential" };
    case "conflict": return { key: "readerAccess.failure.conflict" };
    case "network": return { key: "readerAccess.failure.network" };
    default: return { key: "readerAccess.failure.other", params: { status: failure.status ?? "" } };
  }
}

/** How a step is called in a sentence about what is already done («saved in Narrarium», «secret written», …). */
const DONE_KEY: Partial<Record<ReaderOperationStep, string>> = {
  save: "readerAccess.done.save",
  secret: "readerAccess.done.secret",
  variable: "readerAccess.done.variable",
  "secret-delete": "readerAccess.done.secretDelete",
  forget: "readerAccess.done.forget",
  pages: "readerAccess.done.pages",
  dispatch: "readerAccess.done.dispatch",
};

export function describeDoneSteps(done: readonly ReaderOperationStep[], kind: ReaderOperationKind): ReaderText[] {
  const seen = new Set<string>();
  const result: ReaderText[] = [];
  for (const step of done) {
    // «save» appears twice in an add (kept, then marked as published): the first is what the owner needs to know.
    const key = kind === "remove" && step === "save" ? "readerAccess.done.markRemoving" : DONE_KEY[step];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ key });
  }
  return result;
}

/** What the published reader is doing now, given where an operation stopped: the thing the owner most wants to know when something failed. */
export function describePublishedEffect(kind: ReaderOperationKind, result: ReaderOperationResult): ReaderText {
  const step = result.failed?.step;
  const done = result.done;
  if (kind === "add" || kind === "resume") {
    if (step === "dispatch") return { key: "readerAccess.effect.addNotPublished" };
    if (step === "save" && done.includes("variable")) return { key: "readerAccess.effect.addRecord" };
    return { key: "readerAccess.effect.addUnchanged" };
  }
  if (kind === "remove") {
    if (step === "dispatch") return { key: "readerAccess.effect.removeNotPublished" };
    if (step === "secret-delete") return { key: "readerAccess.effect.removeSecretLeft" };
    if (step === "forget") return { key: "readerAccess.effect.removeRecordLeft" };
    return { key: "readerAccess.effect.unchanged" };
  }
  if (kind === "disable-pages" && step && step !== "pages") return { key: "readerAccess.effect.pagesOffCleanup" };
  return { key: "readerAccess.effect.unchanged" };
}

export interface ReaderResultText {
  tone: "success" | "warning" | "error";
  headline: ReaderText;
  done: ReaderText[];
  reason?: ReaderText;
  effect?: ReaderText;
  /** Whether trying the same thing again is what to offer. */
  retry: boolean;
}

export function describeReaderResult(kind: ReaderOperationKind, result: ReaderOperationResult, tokenKind: GitHubTokenKind = "unknown"): ReaderResultText {
  if (result.ok) {
    const headline = result.deferred ? (kind === "remove" ? "readerAccess.result.removedDeferred" : "readerAccess.result.preparedDeferred")
      : kind === "disable-pages" ? "readerAccess.result.pagesOff"
      : kind === "enable-pages" ? (result.dispatched ? "readerAccess.result.pagesOnPublishing" : "readerAccess.result.pagesOn")
        : result.dispatched ? "readerAccess.result.publishing" : "readerAccess.result.done";
    return { tone: "success", headline: { key: headline }, done: [], retry: false };
  }
  const failure = result.failed!.failure;
  const retriable = failure.kind !== "plan" && failure.kind !== "no-dispatch";
  return {
    tone: "error",
    headline: { key: `readerAccess.result.failed.${kind}` },
    done: describeDoneSteps(result.done, kind),
    reason: describeReaderFailure(failure, tokenKind),
    effect: describePublishedEffect(kind, result),
    retry: retriable,
  };
}

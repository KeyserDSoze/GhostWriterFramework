import type { RunFailureRead } from "@/readerAccess/api";

/**
 * What a failed run of the publishing workflow says went wrong, in the terms the owner can act on. A job that never started (no steps) is explained only by
 * its annotation; GitHub's words are matched, never guessed: a failure that matches nothing is shown with GitHub's own message, and one whose annotations
 * could not be read says so.
 */
export type RunFailureCause = "budget" | "actions-disabled" | "permission" | "other" | "unreadable";

export interface RunFailureInfo {
  runId: number;
  cause: RunFailureCause;
  /** GitHub's message that decided it (trimmed), when there is one. */
  message?: string;
  /** The job never started: it has no steps. */
  neverStarted: boolean;
}

const BUDGET = /actions budget|spending limit|payments? (?:have )?failed|billing|usage limit|minutes? (?:has|have|are) (?:been )?(?:used|exhausted|depleted)|no (?:remaining )?minutes/i;
const DISABLED = /actions (?:is|are|has been) disabled|disabled (?:for|on) this (?:repository|organization|account)|workflows? (?:is|are|has been) disabled|actions (?:is|are) not (?:enabled|allowed)/i;
const PERMISSION = /resource not accessible|not authorized|insufficient permission|permission(?:s)? (?:denied|required|are not)|forbidden|requires? (?:the )?(?:permission|scope)/i;
const MAX_MESSAGE = 300;

export function classifyRunFailure(read: RunFailureRead): RunFailureInfo {
  const messages = read.jobs.flatMap((job) => job.annotations);
  const neverStarted = read.jobs.length > 0 && read.jobs.every((job) => job.steps === 0);
  const pick = (pattern: RegExp) => messages.find((message) => pattern.test(message));
  const trim = (message: string) => message.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);
  const budget = pick(BUDGET);
  if (budget) return { runId: read.runId, cause: "budget", message: trim(budget), neverStarted };
  const disabled = pick(DISABLED);
  if (disabled) return { runId: read.runId, cause: "actions-disabled", message: trim(disabled), neverStarted };
  const permission = pick(PERMISSION);
  if (permission) return { runId: read.runId, cause: "permission", message: trim(permission), neverStarted };
  if (read.annotationsUnreadable && messages.length === 0) return { runId: read.runId, cause: "unreadable", neverStarted };
  const first = messages.find((message) => !/^process completed with exit code/i.test(message)) ?? messages[0];
  return first ? { runId: read.runId, cause: "other", message: trim(first), neverStarted } : { runId: read.runId, cause: "unreadable", neverStarted };
}

/** Where the owner of the repository looks at the billing of GitHub Actions: a user's own settings, or the organization's. */
export function billingUrl(owner: { login: string; type: "User" | "Organization" }): string {
  return owner.type === "Organization" ? `https://github.com/organizations/${encodeURIComponent(owner.login)}/settings/billing` : "https://github.com/settings/billing";
}

/** Where Actions is turned on or off for a repository. */
export function actionsSettingsUrl(owner: string, repo: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/actions`;
}

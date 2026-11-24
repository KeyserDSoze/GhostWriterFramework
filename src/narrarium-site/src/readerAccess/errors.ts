/**
 * What went wrong on a call to GitHub, in the terms the owner can act on. Nothing here keeps GitHub's own message or any request: a failure is a kind, a status
 * and, for a refusal, the permission that is missing, so that no password and no token can end up in a message or a log.
 */
export type ReaderStep =
  | "repository" | "public-key" | "secret-write" | "secret-delete" | "secrets-list"
  | "variable-read" | "variable-write" | "variable-delete"
  | "dispatch" | "runs" | "workflow-read" | "pages-read" | "pages-enable" | "pages-disable";

export type ReaderFailure =
  | { kind: "permission"; status: number; permissions: string[]; fromHeader: boolean }
  | { kind: "not-found"; status: number; permissions: string[] }
  | { kind: "no-dispatch"; status: number }
  | { kind: "plan"; status: number }
  | { kind: "sso"; status: number }
  | { kind: "credential"; status: number }
  | { kind: "rate-limit"; status: number; resetAt?: string }
  | { kind: "conflict"; status: number }
  | { kind: "network" }
  | { kind: "other"; status?: number };

/** The permission a step needs when GitHub does not say which one it wanted (the header is not always sent): what the endpoint is documented to need. */
const STEP_PERMISSION: Record<ReaderStep, string[]> = {
  repository: ["metadata"],
  "public-key": ["secrets"], "secret-write": ["secrets"], "secret-delete": ["secrets"], "secrets-list": ["secrets"],
  "variable-read": ["actions_variables"], "variable-write": ["actions_variables"], "variable-delete": ["actions_variables"],
  dispatch: ["actions"], runs: ["actions"],
  "workflow-read": ["contents"],
  "pages-read": ["pages"], "pages-enable": ["pages"], "pages-disable": ["pages"],
};

/** How GitHub's permission keys are called in the screens where an owner gives them (the app's permissions, a fine-grained token). */
const PERMISSION_LABEL: Record<string, string> = {
  secrets: "Secrets", actions_variables: "Variables", variables: "Variables", actions: "Actions", pages: "Pages", contents: "Contents", workflows: "Workflows",
  administration: "Administration", metadata: "Metadata",
};

export function permissionLabel(key: string): string {
  return PERMISSION_LABEL[key] ?? key;
}

interface ErrorLike {
  status?: unknown;
  message?: unknown;
  response?: { headers?: Record<string, unknown>; data?: unknown };
}

function header(error: ErrorLike, name: string): string | undefined {
  const value = error.response?.headers?.[name];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

/** `X-Accepted-GitHub-Permissions`: the permissions the endpoint accepts, like `secrets=write` or `actions=write; contents=write`. Only the names are used. */
export function acceptedPermissions(value: string | undefined): string[] {
  if (!value) return [];
  const names = value.split(/[;,]/).map((part) => part.trim().split("=")[0]?.trim()).filter((name): name is string => Boolean(name) && /^[a-z_]+$/.test(name!));
  return [...new Set(names)];
}

export function classifyReaderFailure(error: unknown, step: ReaderStep): ReaderFailure {
  const value = (error && typeof error === "object" ? error : {}) as ErrorLike;
  const status = typeof value.status === "number" ? value.status : undefined;
  const message = typeof value.message === "string" ? value.message : "";
  if (status === undefined) return error instanceof TypeError || /network|fetch|failed to/i.test(message) ? { kind: "network" } : { kind: "other" };
  const limited = status === 429 || (status === 403 && (header(value, "x-ratelimit-remaining") === "0" || /rate limit|abuse|secondary/i.test(message)));
  if (limited) {
    const reset = Number(header(value, "x-ratelimit-reset"));
    return { kind: "rate-limit", status, ...(Number.isFinite(reset) && reset > 0 ? { resetAt: new Date(reset * 1000).toISOString() } : {}) };
  }
  if (status === 401) return { kind: "credential", status };
  const accepted = acceptedPermissions(header(value, "x-accepted-github-permissions"));
  if (status === 403) {
    if (header(value, "x-github-sso")) return { kind: "sso", status };
    if (step === "pages-enable" && /plan|upgrade|private/i.test(message)) return { kind: "plan", status };
    return { kind: "permission", status, permissions: accepted.length ? accepted : STEP_PERMISSION[step], fromHeader: accepted.length > 0 };
  }
  if (status === 404) return { kind: "not-found", status, permissions: accepted.length ? accepted : STEP_PERMISSION[step] };
  if (status === 422 && step === "dispatch" && /workflow_dispatch/i.test(message)) return { kind: "no-dispatch", status };
  if (status === 422 && step === "pages-enable" && /plan|upgrade|private/i.test(message)) return { kind: "plan", status };
  if (status === 409) return { kind: "conflict", status };
  return { kind: "other", status };
}

/** A step that did not go through. Its message is fixed: the cause is the classified failure, never GitHub's text. */
export class ReaderFlowError extends Error {
  constructor(readonly step: ReaderStep, readonly failure: ReaderFailure) {
    super(`Reader access: ${step} failed (${failure.kind}${"status" in failure && failure.status ? ` ${failure.status}` : ""}).`);
    this.name = "ReaderFlowError";
  }
}

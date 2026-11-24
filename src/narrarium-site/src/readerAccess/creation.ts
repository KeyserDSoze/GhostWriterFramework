import type { Octokit } from "@octokit/rest";
import { useSettingsStore } from "@/store/settingsStore";
import type { ReaderPasswordRecord } from "@/types/settings";
import { commitFilesToBranch, type BookRepositoryFile } from "@/github/bookRepository";
import { ReaderFlowError, classifyReaderFailure, type ReaderFailure } from "@/readerAccess/errors";
import { readerRecordsOf, withReaderRecords } from "@/readerAccess/model";
import { resumeReaderPassword, setFirstReaderPassword, type ReaderOperationDeps, type ReaderOperationResult } from "@/readerAccess/operations";

/**
 * A protected reader from the start: the first password of a book that is being created. The order is the one of the card (see `operations`): the password is
 * kept in Narrarium, its secret is written, the variable lists it, and only then the workflow lands, so that its first publication already asks for it. If any of
 * that fails the workflow is held back (`createCompleteBookRepository` does not commit it), so a failure never leaves a public reader that the owner thinks is
 * protected; the retry finishes the same password and then lands the workflow.
 */
export interface FirstReaderPassword { label: string; value: string }

/** Where the passwords of one repository are kept: the account data (through the settings), saved with the rest of the settings. */
function recordsPort(owner: string, repo: string, save: () => Promise<unknown>): ReaderOperationDeps["records"] {
  return {
    get: () => readerRecordsOf(useSettingsStore.getState().settings, owner, repo),
    set: async (next: ReaderPasswordRecord[]) => {
      const state = useSettingsStore.getState();
      state.patchSettings({ readerAccess: withReaderRecords(state.settings.readerAccess, owner, repo, next) });
      await save();
    },
  };
}

const sealLazily: ReaderOperationDeps["seal"] = async (value, publicKey) => (await import("@/readerAccess/sealedBox")).sealSecret(value, publicKey);

/** The step that runs before the workflow lands. It throws a `ReaderProtectionFailed` (the result of what was done, and why it stopped) when the password could not be put in place. */
export class ReaderProtectionFailed extends Error {
  constructor(readonly result: ReaderOperationResult) {
    super("Reader protection: the password could not be put in place.");
    this.name = "ReaderProtectionFailed";
  }
}

export function protectionStep(password: FirstReaderPassword, save: () => Promise<unknown>, onSecretName?: (name: string) => void): (context: { octokit: Octokit; owner: string; repo: string; branch: string }) => Promise<void> {
  return async ({ octokit, owner, repo, branch }) => {
    const result = await setFirstReaderPassword({ octokit, repo: { owner, repo }, branch, records: recordsPort(owner, repo, save), seal: sealLazily }, password);
    if (result.secretName) onSecretName?.(result.secretName);
    if (!result.ok) throw new ReaderProtectionFailed(result);
  };
}

/** The failure that explains a held workflow: what the protection step reported, or an unknown failure for anything else. */
export function protectionFailureOf(error: unknown): ReaderFailure {
  if (error instanceof ReaderProtectionFailed) return error.result.failed?.failure ?? { kind: "other" };
  if (error instanceof ReaderFlowError) return error.failure;
  return classifyReaderFailure(error, "repository");
}

export interface RetryProtectedReaderInput {
  octokit: Octokit;
  owner: string;
  repo: string;
  branch: string;
  password: FirstReaderPassword;
  /** The name of the secret the first attempt picked, when it got that far. Without it a new password is made. */
  secretName?: string;
  /** The workflow files that were held back. */
  files: BookRepositoryFile[];
  save: () => Promise<unknown>;
}

export type RetryProtectedReaderResult =
  | { ok: true; secretName: string }
  | { ok: false; stage: "password" | "workflow"; failure: ReaderFailure; secretName?: string };

/** Finishes what a held workflow was waiting for: the same password is put in place (kept, secret, variable), then the workflow lands. */
export async function retryProtectedReader(input: RetryProtectedReaderInput): Promise<RetryProtectedReaderResult> {
  const deps: ReaderOperationDeps = { octokit: input.octokit, repo: { owner: input.owner, repo: input.repo }, branch: input.branch, records: recordsPort(input.owner, input.repo, input.save), seal: sealLazily };
  const existing = input.secretName ? deps.records.get().find((record) => record.secretName === input.secretName) : undefined;
  const result = existing ? await resumeReaderPassword(deps, existing.secretName, { dispatch: false }) : await setFirstReaderPassword(deps, input.password);
  if (!result.ok) return { ok: false, stage: "password", failure: result.failed?.failure ?? { kind: "other" }, ...(result.secretName ? { secretName: result.secretName } : {}) };
  try {
    await commitFilesToBranch({ octokit: input.octokit, owner: input.owner, repo: input.repo, branch: input.branch, files: input.files, message: "Add the GitHub Pages workflow" });
  } catch (error) {
    return { ok: false, stage: "workflow", failure: classifyWorkflowFailure(error), secretName: result.secretName };
  }
  return { ok: true, secretName: result.secretName! };
}

/** A refusal to write a workflow is a missing permission (Workflows), told as such; anything else is classified as for any call. */
export function classifyWorkflowFailure(error: unknown): ReaderFailure {
  const failure = classifyReaderFailure(error, "workflow-read");
  const message = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : "";
  if ((failure.kind === "permission" || failure.kind === "not-found" || failure.kind === "other") && /workflow/i.test(message)) return { kind: "permission", status: "status" in failure && failure.status ? failure.status : 403, permissions: ["workflows"], fromHeader: false };
  return failure;
}

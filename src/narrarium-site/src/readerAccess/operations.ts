import type { Octokit } from "@octokit/rest";
import type { ReaderPasswordRecord } from "@/types/settings";
import { LEGACY_READER_SECRET, allocateReaderSecretName, isReaderSecretName } from "@/readerAccess/contract";
import { deleteSecret, disablePages, dispatchWorkflow, enablePages, getPublicKey, listSecretNames, putSecret, readPasswordVariable, writePasswordVariable, type RepositoryRef } from "@/readerAccess/api";
import { ReaderFlowError, classifyReaderFailure, type ReaderFailure } from "@/readerAccess/errors";
import { takenReaderNames } from "@/readerAccess/model";

/**
 * Every change of the reader's access, step by step and in the order that never leaves the published site pointing at a secret that is not there:
 *
 *  - ADD: check what exists and pick a free name → keep the password in Narrarium (so it cannot be lost) → write the secret → add it to the variable →
 *    start the workflow. Until the variable lists the name nothing published changes, so a failure before that leaves the site as it was.
 *  - REMOVE: mark it as being removed → take it off the variable → delete the secret → forget it in Narrarium → start the workflow. The site stops listing the
 *    secret before the secret goes.
 *
 * Each operation says what it did when it stopped (`done`), which step failed and why, and can simply be called again: every step is safe to repeat. Nothing
 * here writes a password anywhere but into the sealed value that goes to GitHub and into the records the caller keeps.
 */
export type ReaderOperationStep = "check" | "save" | "secret" | "variable" | "secret-delete" | "forget" | "dispatch" | "pages" | "cleanup";

export interface ReaderOperationDeps {
  octokit: Octokit;
  repo: RepositoryRef;
  /** The branch the workflow is started on. */
  branch: string;
  /** The passwords Narrarium keeps for this repository: read when needed, replaced as a whole. `set` resolves once the change is kept (saved and queued for sync). */
  records: { get(): ReaderPasswordRecord[]; set(next: ReaderPasswordRecord[]): Promise<void> };
  /** Seals a secret's text for GitHub's public key. It is the lazy chunk of the sealed box, passed in so that tests need not load it. */
  seal(value: string, publicKey: string): string | Promise<string>;
  now?: () => Date;
  newId?: () => string;
  onStep?: (step: ReaderOperationStep) => void;
}

export interface ReaderOperationResult {
  ok: boolean;
  /** The steps that went through, in order. */
  done: ReaderOperationStep[];
  /** When `ok` is false: the step that stopped and why. */
  failed?: { step: ReaderOperationStep; failure: ReaderFailure };
  /** True when the workflow was started (so a run exists to follow). */
  dispatched: boolean;
  /** The secret that the operation was about. */
  secretName?: string;
}

class Run {
  readonly done: ReaderOperationStep[] = [];
  dispatched = false;
  constructor(private readonly deps: ReaderOperationDeps) {}
  async step<T>(name: ReaderOperationStep, work: () => Promise<T>): Promise<T> {
    this.deps.onStep?.(name);
    const result = await work();
    this.done.push(name);
    return result;
  }
  fail(name: ReaderOperationStep, error: unknown, secretName?: string): ReaderOperationResult {
    // Only a classified failure of a call to GitHub is explained; anything else (a save that did not work) is «something else» and says nothing of its cause.
    const failure: ReaderFailure = error instanceof ReaderFlowError ? error.failure : { kind: "other" };
    return { ok: false, done: this.done, failed: { step: name, failure }, dispatched: this.dispatched, ...(secretName ? { secretName } : {}) };
  }
  ok(secretName?: string): ReaderOperationResult {
    return { ok: true, done: this.done, dispatched: this.dispatched, ...(secretName ? { secretName } : {}) };
  }
}

function replaceRecord(list: ReaderPasswordRecord[], record: ReaderPasswordRecord): ReaderPasswordRecord[] {
  return list.some((entry) => entry.id === record.id) ? list.map((entry) => (entry.id === record.id ? record : entry)) : [...list, record];
}

async function listedNow(deps: ReaderOperationDeps) {
  return readPasswordVariable(deps.octokit, deps.repo);
}

/** Puts a record's secret on GitHub, lists it in the variable and starts the workflow: what an add does after the check, and what finishes an interrupted add. */
async function publish(deps: ReaderOperationDeps, run: Run, record: ReaderPasswordRecord): Promise<ReaderOperationResult | null> {
  let step: ReaderOperationStep = "secret";
  try {
    await run.step("secret", async () => {
      const key = await getPublicKey(deps.octokit, deps.repo);
      await putSecret(deps.octokit, deps.repo, record.secretName, await deps.seal(record.value, key.key), key.keyId);
    });
    step = "variable";
    await run.step("variable", async () => {
      const variable = await listedNow(deps);
      if (variable.names.includes(record.secretName)) return;
      await writePasswordVariable(deps.octokit, deps.repo, [...variable.names, record.secretName]);
    });
    step = "save";
    await run.step("save", () => deps.records.set(replaceRecord(deps.records.get(), { ...record, status: "active" })));
  } catch (error) {
    return run.fail(step, error, record.secretName);
  }
  return null;
}

async function startWorkflow(deps: ReaderOperationDeps, run: Run, secretName?: string): Promise<ReaderOperationResult> {
  try {
    await run.step("dispatch", () => dispatchWorkflow(deps.octokit, deps.repo, deps.branch));
    run.dispatched = true;
  } catch (error) {
    return run.fail("dispatch", error, secretName);
  }
  return run.ok(secretName);
}

/** Adds a password: `label` and `value` are what the owner chose. The name of its secret is picked here, outside everything that is taken. */
export async function addReaderPassword(deps: ReaderOperationDeps, input: { label: string; value: string }): Promise<ReaderOperationResult> {
  const run = new Run(deps);
  let record: ReaderPasswordRecord;
  try {
    record = await run.step("check", async () => {
      const [secrets, variable] = await Promise.all([listSecretNames(deps.octokit, deps.repo), listedNow(deps)]);
      const secretName = allocateReaderSecretName(takenReaderNames(deps.records.get(), { secrets, listed: variable.names }));
      return { id: deps.newId?.() ?? crypto.randomUUID(), label: input.label, value: input.value, createdAt: (deps.now?.() ?? new Date()).toISOString(), secretName, status: "pending" as const };
    });
    await run.step("save", () => deps.records.set([...deps.records.get(), record]));
  } catch (error) {
    return run.fail(run.done.includes("check") ? "save" : "check", error);
  }
  const stopped = await publish(deps, run, record);
  return stopped ?? startWorkflow(deps, run, record.secretName);
}

/**
 * Finishes an add that stopped (a `pending` record), or publishes again a record that GitHub no longer has (out of sync). `dispatch: false` leaves the
 * workflow alone (a repository whose workflow has not been committed yet has nothing to start).
 */
export async function resumeReaderPassword(deps: ReaderOperationDeps, secretName: string, options: { dispatch?: boolean } = {}): Promise<ReaderOperationResult> {
  const run = new Run(deps);
  const record = deps.records.get().find((entry) => entry.secretName === secretName && entry.status !== "removing");
  if (!record) return run.fail("check", new ReaderFlowError("repository", { kind: "other" }), secretName);
  const stopped = await publish(deps, run, record);
  if (stopped) return stopped;
  return options.dispatch === false ? run.ok(secretName) : startWorkflow(deps, run, secretName);
}

/**
 * The first password of a repository that has just been made: nothing exists there, so nothing is read first. It is kept in Narrarium, its secret is
 * written and the variable lists it; the workflow is not started (it is not committed yet, and its commit is the first publication).
 */
export async function setFirstReaderPassword(deps: ReaderOperationDeps, input: { label: string; value: string }): Promise<ReaderOperationResult> {
  const run = new Run(deps);
  const record: ReaderPasswordRecord = { id: deps.newId?.() ?? crypto.randomUUID(), label: input.label, value: input.value, createdAt: (deps.now?.() ?? new Date()).toISOString(), secretName: allocateReaderSecretName(takenReaderNames(deps.records.get(), { secrets: [], listed: [] })), status: "pending" };
  try { await run.step("save", () => deps.records.set([...deps.records.get(), record])); }
  catch (error) { return run.fail("save", error); }
  const stopped = await publish(deps, run, record);
  return stopped ?? run.ok(record.secretName);
}

/**
 * Removes a password. It works for a stored one, for one that exists on GitHub with no value kept here, for one that is only listed, and for the older
 * single secret. The variable stops listing the name before the secret is deleted; an empty list deletes the variable.
 */
export async function removeReaderPassword(deps: ReaderOperationDeps, secretName: string): Promise<ReaderOperationResult> {
  const run = new Run(deps);
  const legacy = secretName === LEGACY_READER_SECRET;
  if (!legacy && !isReaderSecretName(secretName)) return run.fail("check", new ReaderFlowError("repository", { kind: "other" }), secretName);
  const record = deps.records.get().find((entry) => entry.secretName === secretName);
  let step: ReaderOperationStep = "save";
  try {
    if (record && record.status !== "removing") await run.step("save", () => deps.records.set(replaceRecord(deps.records.get(), { ...record, status: "removing" })));
    if (!legacy) {
      step = "variable";
      await run.step("variable", async () => {
        const variable = await listedNow(deps);
        if (!variable.names.includes(secretName)) return;
        await writePasswordVariable(deps.octokit, deps.repo, variable.names.filter((name) => name !== secretName));
      });
    }
    step = "secret-delete";
    await run.step("secret-delete", () => deleteSecret(deps.octokit, deps.repo, secretName));
    step = "forget";
    if (record) await run.step("forget", () => deps.records.set(deps.records.get().filter((entry) => entry.secretName !== secretName)));
  } catch (error) {
    return run.fail(step, error, secretName);
  }
  return startWorkflow(deps, run, secretName);
}

/** Starts the publishing workflow again (after a failed run, or when the start itself failed). */
export async function republishReader(deps: ReaderOperationDeps): Promise<ReaderOperationResult> {
  return startWorkflow(deps, new Run(deps));
}

/** Turns Pages on for an existing book (the package resumes the workflow if it was paused) and, when the repository has the workflow, publishes at once. */
export async function enableReaderPages(deps: ReaderOperationDeps): Promise<ReaderOperationResult> {
  const run = new Run(deps);
  let workflow: "resumed" | "active" | "missing";
  try { workflow = (await run.step("pages", () => enablePages(deps.octokit, deps.repo))).workflow; }
  catch (error) { return run.fail("pages", error); }
  return workflow !== "missing" ? startWorkflow(deps, run) : run.ok();
}

export interface DisablePagesOptions {
  /** Also delete the password secrets and the variable on GitHub. Without it the workflow and every secret stay, so that turning Pages on again restores the same passwords. */
  deleteSecrets: boolean;
  /** Also forget the stored passwords in Narrarium (the owner confirmed it separately). Only has an effect together with `deleteSecrets`. */
  forgetStored: boolean;
}

/**
 * Turns Pages off, through the reader package (the workflow is paused so that a push does not build a site that is not there). The cleanup, when asked, takes
 * the variable off first and then the secrets; a reader secret that the variable did not list is deleted after it, and the stored passwords last.
 */
export async function disableReaderPages(deps: ReaderOperationDeps, options: DisablePagesOptions): Promise<ReaderOperationResult> {
  const run = new Run(deps);
  let result;
  try { result = await run.step("pages", () => disablePages(deps.octokit, deps.repo, { removePasswords: options.deleteSecrets })); }
  catch (error) { return run.fail("pages", error); }
  if (!options.deleteSecrets) return run.ok();
  let step: ReaderOperationStep = "variable";
  try {
    // What the package could not delete (a refusal of the variable or of a secret) is the cleanup that stopped; a refusal to pause the workflow is not.
    const refused = result.failures.find((failure) => failure.status !== undefined && !/pause/i.test(failure.step));
    if (refused) {
      step = /variable/i.test(refused.step) ? "variable" : "secret-delete";
      const readerStep = step === "variable" ? "variable-delete" : "secret-delete";
      throw new ReaderFlowError(readerStep, classifyReaderFailure({ status: refused.status }, readerStep));
    }
    step = "secret-delete";
    const secrets = await listSecretNames(deps.octokit, deps.repo);
    await run.step("secret-delete", async () => { for (const name of secrets.filter((name) => isReaderSecretName(name) || name === LEGACY_READER_SECRET)) await deleteSecret(deps.octokit, deps.repo, name); });
    if (options.forgetStored) {
      step = "forget";
      await run.step("forget", () => deps.records.set([]));
    }
  } catch (error) {
    return run.fail(step, error);
  }
  return run.ok();
}

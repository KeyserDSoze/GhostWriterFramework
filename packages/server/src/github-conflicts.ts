import { createHash, randomBytes } from "node:crypto";
import { copyFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AUTOPILOT_ACTIVITY_FILE,
  AUTOPILOT_PLAN_FILE,
  AUTOPILOT_STATE_FILE,
  GITHUB_CONFLICT_CHOICES,
  GITHUB_CONFLICT_CODE,
  GITHUB_CONFLICTS_MAX_PAGE_LIMIT,
  GITHUB_CONFLICTS_PAGE_LIMIT,
  isSafeBookPath,
  type GithubConflict,
  type GithubConflictChange,
  type GithubConflictChoice,
  type GithubConflictsResponse,
  type ResolveGithubConflictsRequest,
  type ResolveGithubConflictsResponse,
} from "narrarium-engine";
import { HttpError, badRequest } from "./errors.js";

// The conflicts of a GitHub book with GitHub: what changed on both sides since the two parted, found by a merge that writes nothing (git's
// `merge-tree`, or, with a git older than 2.38, a merge in the working copy that is always undone), and resolved by one merge commit in which every
// file that conflicts is the version the author chose. Git runs as `git.ts` runs it: in a private home, with no hook, no helper and no configuration
// of the computer, so that nothing a repository holds is ever run. Paths travel as bytes (`latin1`), so that a name that is not UTF-8 is still the
// file it names; what a file holds is never read, logged or answered, but the state of the autopilot, whose time decides who keeps it.

/** The autopilot's own files: one record (its state, its log, its plan), never asked about. */
export const AUTOPILOT_FILES: readonly string[] = [AUTOPILOT_STATE_FILE, AUTOPILOT_ACTIVITY_FILE, AUTOPILOT_PLAN_FILE];

/** The mark the server leaves in `.git` while git changes the working copy in a way that must be undone if the process stops in the middle. */
export const GIT_OPERATION_MARKER = "narrarium-operation";
/** Temporary indexes of a resolution, in `.git`: removed when it ends, and by the recovery if the process stopped. */
const TEMPORARY_INDEX_PREFIX = "narrarium-index-";

/** Files an answer lists by name at most (the counts say how many there are in all). */
const LISTED_IN_ANSWER = 100;
/** Choices one resolution may name: a large one is a default with a few exceptions. */
const MAX_CHOICES = 5000;
const MAX_CHOICE_PATH = 1024;
const MAX_MESSAGE = 300;
/** The largest state of the autopilot read to know when it was saved: a state is at most a few MiB. */
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_DISPLAY = 300;

/** A conflict with GitHub: the run stops with it, a sync answers it (`409 github_conflict`), and the engine classifies it (`code`, `total`). */
export class GithubConflictError extends Error {
  readonly code = GITHUB_CONFLICT_CODE;
  /** Repeating the step cannot settle it: the author chooses. */
  readonly retryable = false;

  constructor(readonly total: number) {
    super(githubConflictMessage(total));
    this.name = "GithubConflictError";
  }
}

export function githubConflictMessage(total: number): string {
  return `The book changed on GitHub in a way that conflicts with the server's work (${total} ${total === 1 ? "file" : "files"}). Resolve it in the app (Where it runs, or the error panel), then resume.`;
}

export interface GitRun {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitExecOptions {
  /** A command that talks to GitHub: it gets the token. */
  network?: boolean;
  /** Commit as the autopilot does. */
  author?: boolean;
  env?: Record<string, string>;
  input?: string | Buffer;
  /** Exit codes that are answers, not failures (`merge-tree` says a conflict with 1). */
  okCodes?: readonly number[];
  /** `latin1` reads every byte as one character: paths come back as git wrote them, whatever their encoding. */
  encoding?: "utf8" | "latin1";
}

/** What this needs of a working copy: run git in it, as `GitRepository` runs it. */
export interface GitRunner {
  readonly dir: string;
  exec(args: string[], options?: GitExecOptions): Promise<GitRun>;
}

interface Stage {
  mode: string;
  oid: string;
}

/** One path that git could not merge, as the index of a merge says it: its version in the common ancestor, on the server and on GitHub. */
interface StagedPath {
  /** The path as bytes (`latin1`). */
  raw: string;
  base?: Stage;
  server?: Stage;
  github?: Stage;
}

/** A conflict as the server keeps it while it lists or resolves: the path as bytes, and as the author reads it. */
export interface Conflict {
  raw: string;
  /** The path in UTF-8, cleaned of control characters when it is not resolvable: what the list says. */
  path: string;
  server: GithubConflictChange;
  github: GithubConflictChange;
  serverStage?: Stage;
  githubStage?: Stage;
  resolvable: boolean;
  reason?: GithubConflict["reason"];
  /** A file on one side where the other has a folder: the paths git moved aside to make room. */
  moved?: string[];
}

/** What a merge of the server's work and GitHub's would be, without writing anything. */
export interface TrialMerge {
  server: string;
  github: string;
  /** The tree of the merge, with a placeholder (or git's conflict markers) for every path that conflicts; absent when one side holds the other. */
  tree?: string;
  /** The conflicts the author decides about, in the order of their paths (the autopilot's files are not among them). */
  conflicts: Conflict[];
  /** Both sides changed the autopilot's files: they are taken whole from one side (`autopilotSide`). */
  autopilotBoth: boolean;
  ahead: number;
  behind: number;
}

const ZERO_OID = (length: number) => "0".repeat(length);
const FILE_MODES = new Set(["100644", "100755"]);
const bytesOf = (raw: string) => Buffer.from(raw, "latin1");
/** The path in UTF-8, and whether it was valid UTF-8 at all. */
function decode(raw: string): { text: string; valid: boolean } {
  const text = bytesOf(raw).toString("utf8");
  return { text, valid: Buffer.from(text, "utf8").equals(bytesOf(raw)) };
}
/** A name to show: no control character, no lone surrogate (a name that was not UTF-8 says where its bytes were), and not too long. */
function displayName(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\ufffd");
  return clean.length > MAX_DISPLAY ? `${clean.slice(0, MAX_DISPLAY - 1)}…` : clean;
}

/** `"mode oid stage\tpath"` records (of `merge-tree` or `ls-files -u`), grouped by path. */
function parseStages(records: string[]): Map<string, StagedPath> {
  const paths = new Map<string, StagedPath>();
  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    const raw = record.slice(tab + 1);
    const entry = paths.get(raw) ?? { raw };
    const value = { mode, oid };
    if (stage === "1") entry.base = value;
    else if (stage === "2") entry.server = value;
    else if (stage === "3") entry.github = value;
    paths.set(raw, entry);
  }
  return paths;
}

const changeOf = (base: unknown, side: unknown): GithubConflictChange => (side ? (base ? "modified" : "added") : "deleted");

/** Paths git cannot write in a working copy, whatever the system: an empty, `.` or `..` part, or the repository's own folder under any spelling. */
const IGNORED_BY_FILE_SYSTEMS = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;
function unwritable(raw: string): boolean {
  return decode(raw).text.split("/").some((segment) => {
    if (!segment || segment === "." || segment === "..") return true;
    const name = segment.normalize("NFKC").replace(IGNORED_BY_FILE_SYSTEMS, "").replace(/[. ]+$/, "").toLowerCase();
    return name === ".git" || name === "git~1";
  });
}

/** Split arguments so that no command line grows too long (Windows command lines are short). */
function batches(paths: string[], limit = 8000): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const file of paths) {
    if (current.length && length + file.length + 1 > limit) {
      groups.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += file.length + 1;
  }
  if (current.length) groups.push(current);
  return groups;
}

/** The entries (not folders) at or under `raw` in a revision: `mode`, `oid` and the path as bytes. */
async function treeEntries(runner: GitRunner, revision: string, raw: string): Promise<Array<{ mode: string; oid: string; raw: string }>> {
  const { stdout } = await runner.exec(["ls-tree", "-r", "-z", "--full-tree", revision, "--", raw], { encoding: "latin1" });
  return stdout.split("\0").filter(Boolean).flatMap((record) => {
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    const file = record.slice(tab + 1);
    return type === "tree" || (file !== raw && !file.startsWith(`${raw}/`)) ? [] : [{ mode, oid, raw: file }];
  });
}

/** Which of these paths are files of a revision. */
async function presentIn(runner: GitRunner, revision: string, raws: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const group of batches(raws)) {
    const { stdout } = await runner.exec(["ls-tree", "-r", "-z", "--name-only", "--full-tree", revision, "--", ...group], { encoding: "latin1" });
    for (const file of stdout.split("\0")) if (file) found.add(file);
  }
  return found;
}

/** Whether a path is a file (not a folder) in a revision. */
async function isFileIn(runner: GitRunner, revision: string | undefined, raw: string): Promise<boolean> {
  if (!revision) return false;
  return (await treeEntries(runner, revision, raw)).some((entry) => entry.raw === raw);
}

async function mark(runner: GitRunner, operation: string): Promise<void> {
  await writeFile(path.join(runner.dir, ".git", GIT_OPERATION_MARKER), `${operation}\n`);
}

async function unmark(runner: GitRunner): Promise<void> {
  await rm(path.join(runner.dir, ".git", GIT_OPERATION_MARKER), { force: true });
}

/** Undo a merge in the working copy: `merge --abort`, or a reset of what the merge touched when that cannot. */
async function abortMerge(runner: GitRunner): Promise<void> {
  try {
    await runner.exec(["merge", "--abort"]);
  } catch {
    await runner.exec(["reset", "--merge"]);
  }
}

/** The merge as git's `merge-tree` writes it: objects only, the working copy and the index untouched. */
async function mergeTreeTrial(runner: GitRunner, server: string, github: string): Promise<{ tree: string; stages: Map<string, StagedPath> }> {
  const result = await runner.exec(["merge-tree", "--write-tree", "-z", "--no-messages", "-X", "no-renames", server, github], { okCodes: [1], encoding: "latin1" });
  const parts = result.stdout.split("\0");
  const tree = parts[0].trim();
  // A failure that is no conflict (a revision git cannot read) also ends with 1, without a tree.
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(`git merge-tree failed: ${result.stderr.trim().split("\n").slice(-2).join(" ")}`);
  const records: string[] = [];
  if (result.code === 1) for (let index = 1; index < parts.length && parts[index] !== ""; index += 1) records.push(parts[index]);
  return { tree, stages: parseStages(records) };
}

/**
 * The same with a git that has no `merge-tree --write-tree`: a merge in the working copy, read, and always undone. A mark in `.git` says it is going on,
 * so that a process that stops in the middle finds it at its next start (`recoverOperation`).
 */
async function worktreeTrial(runner: GitRunner, github: string): Promise<{ tree: string; stages: Map<string, StagedPath> }> {
  await mark(runner, "trial-merge");
  const copy = temporaryIndex(runner);
  try {
    await runner.exec(["merge", "--no-commit", "--no-ff", "--quiet", "-X", "no-renames", github], { author: true, okCodes: [1] });
    const unmerged = await runner.exec(["ls-files", "-u", "-z"], { encoding: "latin1" });
    const stages = parseStages(unmerged.stdout.split("\0").filter(Boolean));
    // The tree of the merge is written from a copy of the index, with one entry per path that conflicts (a placeholder, which a resolution replaces):
    // the index of the merge stays as git left it, so that git can undo the merge.
    await copyFile(path.join(runner.dir, ".git", "index"), copy);
    const env = { GIT_INDEX_FILE: copy };
    const records = [...stages.values()].map((entry) => {
      const stage = (entry.server ?? entry.github ?? entry.base)!;
      return `${stage.mode} ${stage.oid}\t${entry.raw}`;
    });
    if (records.length) await runner.exec(["update-index", "-z", "--index-info"], { env, input: bytesOf(`${records.join("\0")}\0`) });
    const tree = (await runner.exec(["write-tree"], { env })).stdout.trim();
    return { tree, stages };
  } finally {
    await rm(copy, { force: true });
    await abortMerge(runner);
    await unmark(runner);
  }
}

/** A temporary index in `.git`, removed when its work ends, and by the recovery if the process stopped. */
function temporaryIndex(runner: GitRunner): string {
  return path.join(runner.dir, ".git", `${TEMPORARY_INDEX_PREFIX}${randomBytes(6).toString("hex")}`);
}

/** The commit both sides started from; `undefined` for histories with nothing in common. */
async function mergeBase(runner: GitRunner, server: string, github: string): Promise<string | undefined> {
  const result = await runner.exec(["merge-base", server, github], { okCodes: [1] });
  return result.stdout.trim() || undefined;
}

/** The autopilot's files that changed between two revisions. */
async function autopilotChanged(runner: GitRunner, from: string, to: string): Promise<Set<string>> {
  const { stdout } = await runner.exec(["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", from, to, "--", ...AUTOPILOT_FILES], { encoding: "latin1" });
  return new Set(stdout.split("\0").filter(Boolean));
}

/**
 * What a merge of `github` into `server` would be, writing nothing to the working copy: the conflicts, the counts of commits on each side, and whether
 * both sides changed the autopilot's files. `mergeTree: false` is for a git older than 2.38 (see `worktreeTrial`).
 */
export async function trialMerge(runner: GitRunner, server: string, github: string, options: { mergeTree: boolean }): Promise<TrialMerge> {
  const counted = (await runner.exec(["rev-list", "--left-right", "--count", `${server}...${github}`])).stdout.trim().split(/\s+/).map(Number);
  const [ahead, behind] = [counted[0] || 0, counted[1] || 0];
  // One side holds the other: a fast-forward, or nothing to bring in.
  if (!ahead || !behind) return { server, github, conflicts: [], autopilotBoth: false, ahead, behind };
  const base = await mergeBase(runner, server, github);
  if (!base) throw new HttpError(409, "unrelated_histories", "The book on GitHub and the server's copy have no history in common: they cannot be merged. Register the book again from GitHub.");
  const { tree, stages } = options.mergeTree ? await mergeTreeTrial(runner, server, github) : await worktreeTrial(runner, github);
  const conflicts: Conflict[] = [];
  let autopilotConflict = false;
  // A file on one side where the other has a folder: git moves the file aside, to `path~side`, a name neither side has.
  const suspects = [...stages.keys()].filter((raw) => raw.includes("~"));
  const real = new Set<string>();
  if (suspects.length) for (const revision of [base, server, github]) for (const raw of await presentIn(runner, revision, suspects)) real.add(raw);
  const folders = new Map<string, string[]>();
  for (const staged of stages.values()) {
    const { raw } = staged;
    if (AUTOPILOT_FILES.includes(raw)) {
      autopilotConflict = true;
      continue;
    }
    if (raw.includes("~") && !real.has(raw)) {
      const original = raw.slice(0, raw.lastIndexOf("~"));
      folders.set(original, [...(folders.get(original) ?? []), raw]);
      continue;
    }
    const { text, valid } = decode(raw);
    const special = [staged.base, staged.server, staged.github].some((stage) => stage && !FILE_MODES.has(stage.mode));
    const unsafe = !valid || !isSafeBookPath(text);
    conflicts.push({
      raw,
      path: unsafe ? displayName(text) : text,
      server: changeOf(staged.base, staged.server),
      github: changeOf(staged.base, staged.github),
      ...(staged.server ? { serverStage: staged.server } : {}),
      ...(staged.github ? { githubStage: staged.github } : {}),
      resolvable: !unsafe && !special,
      ...(unsafe ? { reason: "unsafe-path" as const } : special ? { reason: "not-a-file" as const } : {}),
    });
  }
  for (const [original, moved] of folders) {
    const [inBase, inServer, inGithub] = await Promise.all([isFileIn(runner, base, original), isFileIn(runner, server, original), isFileIn(runner, github, original)]);
    // The file of the side that has one; the other has a folder there. Its own version, for the fingerprint.
    const stage = stages.get(moved[0]);
    conflicts.push({
      raw: original,
      path: displayName(decode(original).text),
      server: inServer ? (inBase ? "modified" : "added") : inBase ? "deleted" : "added",
      github: inGithub ? (inBase ? "modified" : "added") : inBase ? "deleted" : "added",
      ...(stage?.server ? { serverStage: stage.server } : {}),
      ...(stage?.github ? { githubStage: stage.github } : {}),
      resolvable: false,
      reason: "file-directory",
      moved,
    });
  }
  conflicts.sort((left, right) => (left.raw < right.raw ? -1 : left.raw > right.raw ? 1 : 0));
  let autopilotBoth = autopilotConflict;
  if (!autopilotBoth) {
    const [mine, theirs] = await Promise.all([autopilotChanged(runner, base, server), autopilotChanged(runner, base, github)]);
    autopilotBoth = [...mine].some((file) => theirs.has(file));
  }
  return { server, github, tree, conflicts, autopilotBoth, ahead, behind };
}

/** What the conflicts are, version by version: the same conflicts give the same fingerprint, a change of any of them another. */
export function fingerprintOf(trial: TrialMerge): string {
  const hash = createHash("sha256");
  for (const conflict of trial.conflicts) hash.update(`${conflict.raw}\0${conflict.serverStage?.oid ?? "-"}\0${conflict.githubStage?.oid ?? "-"}\n`, "latin1");
  return hash.digest("hex").slice(0, 32);
}

/** The time a state of the autopilot was saved (`updatedAt`), or `undefined` when there is none to read. */
async function stateTime(runner: GitRunner, revision: string): Promise<number | undefined> {
  const spec = `${revision}:${AUTOPILOT_STATE_FILE}`;
  const checked = (await runner.exec(["cat-file", "--batch-check=%(objecttype) %(objectsize)"], { input: `${spec}\n` })).stdout.trim().split(" ");
  if (checked[0] !== "blob" || !(Number(checked[1]) <= MAX_STATE_BYTES)) return undefined;
  const text = (await runner.exec(["cat-file", "blob", `${revision}:${AUTOPILOT_STATE_FILE}`])).stdout;
  try {
    const saved = (JSON.parse(text) as { updatedAt?: unknown } | null)?.updatedAt;
    if (typeof saved !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(saved)) return undefined;
    const time = Date.parse(saved);
    return Number.isFinite(time) ? time : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who keeps the autopilot's files when both sides changed them. While a run of the server is active, the server: the run owns them, and they cannot
 * change under it. Otherwise the side whose state was saved last (`updatedAt`): the host that ran the autopilot most recently (the browser, when the
 * book moved there). A state that cannot be read loses to one that can; when neither can, or the two times are the same, the server keeps its own.
 */
export async function autopilotSide(runner: GitRunner, server: string, github: string, runActive: boolean): Promise<GithubConflictChoice> {
  if (runActive) return "server";
  const [mine, theirs] = await Promise.all([stateTime(runner, server), stateTime(runner, github)]);
  return theirs !== undefined && (mine === undefined || theirs > mine) ? "github" : "server";
}

/**
 * The tree of a resolution: the merge, with every conflict the version chosen (`decide`; the server's for one that is not resolvable, and the server's
 * whole folder or file for a file that met a folder) and the autopilot's three files from `autopilotFrom` when both sides changed them. Built in a
 * temporary index: the working copy and its index are not touched.
 */
export async function resolutionTree(runner: GitRunner, trial: TrialMerge, decide: (conflict: Conflict) => GithubConflictChoice, autopilotFrom?: GithubConflictChoice): Promise<string> {
  if (!trial.tree) throw new Error("There is no merge to resolve.");
  // A name git cannot write would stop the merge half-way: it is refused before anything is built.
  await assertWritableTree(runner, trial.tree);
  const index = temporaryIndex(runner);
  const env = { GIT_INDEX_FILE: index };
  const zero = ZERO_OID(trial.tree.length);
  const records: string[] = [];
  const set = (mode: string, oid: string, raw: string) => records.push(`${mode} ${oid}\t${raw}`);
  const drop = (raw: string) => records.push(`0 ${zero}\t${raw}`);
  try {
    await runner.exec(["read-tree", trial.tree], { env });
    for (const conflict of trial.conflicts) {
      if (conflict.moved) {
        // What git moved aside goes, and the path holds what the server has there: its file, or its folder.
        for (const raw of conflict.moved) drop(raw);
        const listed = await runner.exec(["ls-files", "-z", "--", conflict.raw], { env, encoding: "latin1" });
        for (const raw of listed.stdout.split("\0")) if (raw && (raw === conflict.raw || raw.startsWith(`${conflict.raw}/`))) drop(raw);
        for (const entry of await treeEntries(runner, trial.server, conflict.raw)) set(entry.mode, entry.oid, entry.raw);
        continue;
      }
      const stage = (conflict.resolvable ? decide(conflict) : "server") === "server" ? conflict.serverStage : conflict.githubStage;
      if (stage) set(stage.mode, stage.oid, conflict.raw);
      else drop(conflict.raw);
    }
    if (autopilotFrom) {
      const revision = autopilotFrom === "server" ? trial.server : trial.github;
      for (const file of AUTOPILOT_FILES) {
        const entry = (await treeEntries(runner, revision, file)).find((candidate) => candidate.raw === file);
        if (entry) set(entry.mode, entry.oid, file);
        else drop(file);
      }
    }
    if (records.length) await runner.exec(["update-index", "-z", "--replace", "--index-info"], { env, input: bytesOf(`${records.join("\0")}\0`) });
    return (await runner.exec(["write-tree"], { env })).stdout.trim();
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

/** Refuse a tree that holds a name git cannot write (GitHub refuses such trees itself: only a broken or hostile remote has one). Nothing is written. */
export async function assertWritableTree(runner: GitRunner, tree: string): Promise<void> {
  const { stdout } = await runner.exec(["ls-tree", "-r", "-z", "--name-only", "--full-tree", tree], { encoding: "latin1" });
  const bad = stdout.split("\0").filter((raw) => raw && unwritable(raw));
  if (!bad.length) return;
  const names = bad.slice(0, 5).map((raw) => displayName(decode(raw).text)).join(", ");
  throw new HttpError(422, "invalid_github_path", `GitHub holds ${bad.length === 1 ? "a file whose name" : `${bad.length} files whose names`} cannot be written in a working copy (${names}): nothing was merged. Remove ${bad.length === 1 ? "it" : "them"} from the repository on GitHub, then try again.`);
}

/** The merge commit: the server's work and GitHub's as its two parents, so that the history of both stays as it is. */
export async function commitMerge(runner: GitRunner, tree: string, trial: TrialMerge, subject: string, body: string): Promise<string> {
  const { stdout } = await runner.exec(["commit-tree", "--no-gpg-sign", tree, "-p", trial.server, "-p", trial.github, "-m", subject, ...(body ? ["-m", body] : [])], { author: true });
  return stdout.trim();
}

/** Bytes of the objects, in order: `undefined` for one that cannot be read. */
async function objectSizes(runner: GitRunner, oids: string[]): Promise<Array<number | undefined>> {
  if (!oids.length) return [];
  const { stdout } = await runner.exec(["cat-file", "--batch-check=%(objectsize)"], { input: `${oids.join("\n")}\n` });
  const lines = stdout.split("\n");
  return oids.map((_oid, index) => {
    const size = Number(lines[index]);
    return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
  });
}

/** One page of the list, as the API answers it: the sizes are read for the conflicts of the page only. */
export async function conflictPage(runner: GitRunner, trial: TrialMerge, page: { offset: number; limit: number }, branch: string, autopilotFiles?: GithubConflictChoice): Promise<GithubConflictsResponse> {
  const slice = trial.conflicts.slice(page.offset, page.offset + page.limit);
  const sizes = await objectSizes(runner, slice.flatMap((conflict) => [conflict.serverStage?.oid ?? "", conflict.githubStage?.oid ?? ""]).filter(Boolean));
  let next = 0;
  const conflicts: GithubConflict[] = slice.map((conflict) => {
    const serverBytes = conflict.serverStage ? sizes[next++] : undefined;
    const githubBytes = conflict.githubStage ? sizes[next++] : undefined;
    return {
      path: conflict.path,
      server: conflict.server,
      github: conflict.github,
      ...(serverBytes !== undefined ? { serverBytes } : {}),
      ...(githubBytes !== undefined ? { githubBytes } : {}),
      resolvable: conflict.resolvable,
      ...(conflict.reason ? { reason: conflict.reason } : {}),
    };
  });
  return {
    conflicts,
    total: trial.conflicts.length,
    offset: page.offset,
    limit: page.limit,
    ahead: trial.ahead,
    behind: trial.behind,
    branch,
    head: trial.server,
    ...(trial.github ? { githubHead: trial.github } : {}),
    fingerprint: fingerprintOf(trial),
    ...(autopilotFiles ? { autopilotFiles } : {}),
  };
}

/** What a resolution decided, before anything is written: the version of every conflict, and what was left aside. */
export interface ResolutionPlan {
  decide: (conflict: Conflict) => GithubConflictChoice;
  answer: Pick<ResolveGithubConflictsResponse, "resolved" | "ignored" | "unresolvable" | "counts">;
}

/** The choices applied to the conflicts: a file without one and no default is refused (`400 choice_missing`, with the paths), never chosen at random. */
export function planResolution(trial: TrialMerge, request: ResolveGithubConflictsRequest): ResolutionPlan {
  const choices = request.choices ?? {};
  const resolvable = trial.conflicts.filter((conflict) => conflict.resolvable);
  const asked = new Set(resolvable.map((conflict) => conflict.path));
  const missing = resolvable.filter((conflict) => !Object.hasOwn(choices, conflict.path) && !request.default).map((conflict) => conflict.path);
  if (missing.length) {
    throw new HttpError(400, "choice_missing", `Choose the version to keep of ${missing.length} ${missing.length === 1 ? "file" : "files"} (the server's or GitHub's), or give a default for the files you do not name: nothing was written.`, {}, { paths: missing.slice(0, LISTED_IN_ANSWER), missing: missing.length });
  }
  const decide = (conflict: Conflict): GithubConflictChoice => (Object.hasOwn(choices, conflict.path) ? choices[conflict.path] : request.default) as GithubConflictChoice;
  const ignored = Object.keys(choices).filter((file) => !asked.has(file)).sort();
  const decided = resolvable.map((conflict) => ({ path: conflict.path, choice: decide(conflict) }));
  const unresolvable = trial.conflicts.filter((conflict) => !conflict.resolvable).map((conflict) => conflict.path);
  return {
    decide,
    answer: {
      resolved: decided.slice(0, LISTED_IN_ANSWER),
      ignored: ignored.slice(0, LISTED_IN_ANSWER),
      unresolvable: unresolvable.slice(0, LISTED_IN_ANSWER),
      counts: {
        total: trial.conflicts.length,
        server: decided.filter((entry) => entry.choice === "server").length,
        github: decided.filter((entry) => entry.choice === "github").length,
        ignored: ignored.length,
        unresolvable: unresolvable.length,
      },
    },
  };
}

/** The words of the merge commit of a resolution: the author's subject or one of its own, and the counts (never a file's content, nor its name). */
export function resolutionMessage(request: ResolveGithubConflictsRequest, plan: ResolutionPlan, autopilotFiles?: GithubConflictChoice): { subject: string; body: string } {
  const { counts } = plan.answer;
  const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;
  const subject = request.message?.replace(/\s+/g, " ").trim() || `Resolve the conflicts with GitHub (${files(counts.total)})`;
  const body = [
    `Kept from the server: ${files(counts.server)}. Taken from GitHub: ${files(counts.github)}.`,
    counts.unresolvable ? `Kept from the server, because the server cannot choose for them: ${files(counts.unresolvable)}.` : "",
    autopilotFiles ? `The autopilot's files: ${autopilotFiles === "server" ? "the server's" : "GitHub's"}.` : "",
  ].filter(Boolean).join("\n");
  return { subject, body };
}

/** The conflicts are not the ones the author chose from: nothing is written, and the answer is the first page of the list as it is now. */
export async function conflictsChanged(runner: GitRunner, trial: TrialMerge, branch: string, autopilotFiles?: GithubConflictChoice): Promise<HttpError> {
  const listing = await conflictPage(runner, trial, { offset: 0, limit: GITHUB_CONFLICTS_PAGE_LIMIT }, branch, autopilotFiles);
  return new HttpError(409, "conflicts_changed", "The conflicts with GitHub changed since they were listed (GitHub moved again): nothing was written. Choose again from the list.", {}, { ...listing });
}

/**
 * Leave the working copy as git expects it after a process that stopped in the middle of a change of it: a lock git left behind goes, and a merge or a
 * rebase of the server that the mark says was going on is undone. The caller makes sure that no git of this server works on the copy meanwhile.
 * Answers whether there was anything to undo.
 */
export async function recoverOperation(runner: GitRunner): Promise<boolean> {
  const git = path.join(runner.dir, ".git");
  const exists = (name: string) => stat(path.join(git, name)).then(() => true, () => false);
  if (!(await exists("."))) return false;
  let recovered = false;
  if (await exists("index.lock")) {
    await rm(path.join(git, "index.lock"), { force: true });
    recovered = true;
  }
  for (const entry of await readdir(git)) {
    if (entry.startsWith(TEMPORARY_INDEX_PREFIX)) await rm(path.join(git, entry), { force: true });
  }
  if (!(await exists(GIT_OPERATION_MARKER))) return recovered;
  if (await exists("MERGE_HEAD")) await abortMerge(runner);
  if ((await exists("rebase-merge")) || (await exists("rebase-apply"))) await runner.exec(["rebase", "--abort"]).catch(() => undefined);
  await unmark(runner);
  return true;
}

export { mark as markOperation, unmark as unmarkOperation };

/** `?offset=&limit=` of the list: whole numbers, the limit from 1 to `GITHUB_CONFLICTS_MAX_PAGE_LIMIT`. */
export function asConflictPage(url: URL): { offset: number; limit: number } {
  const read = (name: string, fallback: number, min: number, max: number): number => {
    const value = url.searchParams.get(name);
    if (value === null) return fallback;
    const number = /^(?:0|[1-9][0-9]{0,8})$/.test(value) ? Number(value) : Number.NaN;
    if (!(number >= min && number <= max)) throw badRequest(`\`${name}\` must be a whole number from ${min} to ${max}.`);
    return number;
  };
  return { offset: read("offset", 0, 0, 999_999_999), limit: read("limit", GITHUB_CONFLICTS_PAGE_LIMIT, 1, GITHUB_CONFLICTS_MAX_PAGE_LIMIT) };
}

const isChoice = (value: unknown): value is GithubConflictChoice => typeof value === "string" && (GITHUB_CONFLICT_CHOICES as readonly string[]).includes(value);

/** The body of a resolution: `choices`, `default`, `message` and `fingerprint`, each of its type, and nothing else. */
export function asResolveRequest(body: Record<string, unknown>): ResolveGithubConflictsRequest {
  const known = new Set(["choices", "default", "message", "fingerprint"]);
  const unknown = Object.keys(body).filter((key) => !known.has(key));
  if (unknown.length) throw badRequest(`A resolution takes choices, default, message and fingerprint, not ${unknown.slice(0, 3).map((key) => key.slice(0, 40)).join(", ")}.`);
  const request: ResolveGithubConflictsRequest = {};
  if (body.choices !== undefined) {
    const choices = body.choices;
    if (!choices || typeof choices !== "object" || Array.isArray(choices)) throw badRequest("`choices` must be an object: { \"<path>\": \"server\" | \"github\" }.");
    const entries = Object.entries(choices as Record<string, unknown>);
    if (entries.length > MAX_CHOICES) throw badRequest(`A resolution names at most ${MAX_CHOICES} files: give a \`default\` for the others.`);
    for (const [file, choice] of entries) {
      if (!file || file.length > MAX_CHOICE_PATH) throw badRequest("Every path of `choices` is a path of the list, at most 1024 characters long.");
      if (!isChoice(choice)) throw badRequest(`The choice for a file is "server" or "github", not ${JSON.stringify(choice)?.slice(0, 40)}.`);
    }
    request.choices = Object.fromEntries(entries) as Record<string, GithubConflictChoice>;
  }
  if (body.default !== undefined) {
    if (!isChoice(body.default)) throw badRequest("`default` is \"server\" or \"github\".");
    request.default = body.default;
  }
  if (body.message !== undefined) {
    if (typeof body.message !== "string" || body.message.length > MAX_MESSAGE) throw badRequest(`\`message\` is a text of at most ${MAX_MESSAGE} characters.`);
    request.message = body.message;
  }
  if (body.fingerprint !== undefined) {
    if (typeof body.fingerprint !== "string" || !/^[0-9a-f]{1,128}$/.test(body.fingerprint)) throw badRequest("`fingerprint` is the one the list gave.");
    request.fingerprint = body.fingerprint;
  }
  return request;
}

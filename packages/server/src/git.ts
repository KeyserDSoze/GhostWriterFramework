import { execFile, type ExecFileException } from "node:child_process";
import { rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GithubConflictsResponse, ResolveGithubConflictsRequest, ResolveGithubConflictsResponse } from "narrarium-engine";
import { HttpError } from "./errors.js";
import {
  GithubConflictError,
  autopilotSide,
  commitMerge,
  conflictPage,
  conflictsChanged,
  fingerprintOf,
  markOperation,
  planResolution,
  recoverOperation,
  resolutionMessage,
  resolutionTree,
  trialMerge,
  unmarkOperation,
  type GitExecOptions,
  type GitRun,
  type GitRunner,
  type TrialMerge,
} from "./github-conflicts.js";

export interface GitResult {
  stdout: string;
  stderr: string;
  /** The exit code: 0, or one the caller said is an answer (`okCodes`). */
  code?: number;
}

/** How one git process runs: where, with which token (only for GitHub), how long, and what it reads and writes besides its arguments. */
interface GitProcessOptions {
  cwd?: string;
  token?: string;
  timeoutMs?: number;
  /** Variables added to the private environment (a temporary index). */
  env?: Record<string, string>;
  input?: string | Buffer;
  okCodes?: readonly number[];
  encoding?: "utf8" | "latin1";
}

export class GitError extends Error {
  /** A network failure or a timeout: the autopilot retries the step once (see the engine's retry rule). */
  readonly retryable: boolean;

  constructor(message: string, readonly stderr = "", retryable = false) {
    super(message);
    this.name = "GitError";
    this.retryable = retryable;
  }
}

/** Failures of the connection to GitHub, not of the repository: worth one more try. */
const TRANSIENT_GIT_FAILURE = /could not resolve host|temporary failure in name resolution|failed to connect|connection (?:timed out|refused|reset)|operation timed out|network is unreachable|early eof|remote end hung up|rpc failed|returned error: 5\d\d|internal server error|bad gateway|service unavailable|gnutls|ssl_connect|tls handshake/i;

const AUTHOR = ["-c", "user.name=Narrarium Autopilot", "-c", "user.email=autopilot@narrarium.invalid"];

/** Characters of paths handed to one git invocation: Windows command lines are short. */
const MAX_ARGUMENT_CHARACTERS = 8000;

/** What git may see of the owner's computer: an empty home, an empty global configuration, an empty hooks folder. */
interface GitSandbox {
  home: string;
  config: string;
  hooks: string;
}

const sandboxes = new Map<string, Promise<GitSandbox>>();

/** Create (once per process) the private folder git runs in. Nothing in it is ever read from the owner's own files. */
function prepareSandbox(home: string): Promise<GitSandbox> {
  const key = path.resolve(home);
  let ready = sandboxes.get(key);
  if (!ready) {
    ready = (async () => {
      await mkdir(key, { recursive: true, mode: 0o700 });
      const hooks = path.join(key, "hooks");
      await mkdir(hooks, { recursive: true, mode: 0o700 });
      const config = path.join(key, "gitconfig");
      await writeFile(config, "", { mode: 0o600 });
      return { home: key, config, hooks };
    })();
    sandboxes.set(key, ready);
    ready.catch(() => sandboxes.delete(key));
  }
  return ready;
}

let temporaryHome: Promise<string> | undefined;

/** The private folder for callers that name none: one per process, removed when the process ends. */
function defaultHome(): Promise<string> {
  temporaryHome ??= mkdtemp(path.join(os.tmpdir(), "narrarium-git-")).then((directory) => {
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    return directory;
  });
  return temporaryHome;
}

/** Environment for git children: no prompts, no user or system configuration, the token only as an HTTP header. */
function gitEnvironment(sandbox: GitSandbox, token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    XDG_CONFIG_HOME: sandbox.home,
    SYSTEMROOT: process.env.SYSTEMROOT,
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: sandbox.config,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  };
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) if (process.env[key]) env[key] = process.env[key];
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return env;
}

/** Settings given to every invocation: whatever a repository's own configuration says, nothing runs and nothing is linked. */
function hardening(sandbox: GitSandbox): string[] {
  return [
    "-c", `core.hooksPath=${sandbox.hooks}`,
    "-c", "core.fsmonitor=false",
    "-c", "core.symlinks=false",
    "-c", "credential.helper=",
    "-c", "core.askPass=",
    "-c", "submodule.recurse=false",
    "-c", "fetch.recurseSubmodules=false",
    "-c", "protocol.ext.allow=never",
  ];
}

function redact(text: string, token?: string): string {
  return token ? text.split(token).join("***") : text;
}

/** The git command of an argument list, past the `-c key=value` pairs that may precede it. */
function subcommand(args: string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-c") index += 1;
    else return args[index];
  }
  return "";
}

function execGit(args: string[], env: NodeJS.ProcessEnv, options: GitProcessOptions): Promise<GitResult & { code: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd: options.cwd, env, timeout: options.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: options.encoding ?? "utf8" }, (error: ExecFileException | null, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      if (error && (error.killed === true || !options.okCodes?.includes(code))) {
        const detail = redact(String(stderr || error.message).trim(), options.token);
        const timedOut = error.killed === true;
        reject(new GitError(`git ${subcommand(args)} failed: ${detail.split("\n").slice(-3).join(" ")}`, detail, timedOut || TRANSIENT_GIT_FAILURE.test(detail)));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
    if (options.input !== undefined) {
      // A git that stops reading early (an error) closes the pipe: that is its answer, not a failure of the server.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
  });
}

/**
 * Run git in a private environment: `home` (or a private folder of this process) replaces the owner's home,
 * so their global configuration, hooks, URL rewrites and credential helpers never apply.
 */
export async function runGit(args: string[], options: GitProcessOptions & { home?: string } = {}): Promise<GitResult & { code: number }> {
  const sandbox = await prepareSandbox(options.home ?? await defaultHome());
  return execGit([...hardening(sandbox), ...args], { ...gitEnvironment(sandbox, options.token), ...options.env }, options);
}

let mergeTreeSupport: Promise<boolean> | undefined;

/** Whether this git has `merge-tree --write-tree` (git 2.38 and later): a merge that writes objects only. Asked once per process. */
function mergeTreeSupported(): Promise<boolean> {
  mergeTreeSupport ??= gitVersion().then((version) => {
    const match = /(\d+)\.(\d+)/.exec(version ?? "");
    return Boolean(match) && (Number(match![1]) > 2 || (Number(match![1]) === 2 && Number(match![2]) >= 38));
  });
  return mergeTreeSupport;
}

/** What a push that GitHub refused because it moved meanwhile says. */
const REJECTED_PUSH = /rejected|fetch first|non-fast-forward/i;
/** Characters of a failed push that an answer repeats. */
const PUSH_ERROR_CHARACTERS = 500;

export async function gitVersion(): Promise<string | null> {
  try {
    // `--version` reads no configuration: it needs no private home.
    const { stdout } = await execGit(["--version"], { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, LANG: "C" }, { timeoutMs: 10_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Split paths into groups whose total length stays under the limit. */
function batches(paths: string[], limit = MAX_ARGUMENT_CHARACTERS): string[][] {
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

/** The longest a revision is believed without looking again, whatever the files say (a file system with coarse time stamps may hide a change). */
const HEAD_CACHE_MAX_AGE_MS = 30_000;

/** What decides who keeps the autopilot's own files when both sides changed them (see `autopilotSide`): whether a run of the server is active. */
export interface GithubPolicy {
  runActive?: boolean;
}

/** A working tree used by the server: commits every autopilot step, optionally synced with GitHub. */
export class GitRepository implements GitRunner {
  /** `git rev-parse HEAD`, kept while the files it is read from have not changed (see `headKey`). */
  private headCache: { key: string; head: string | undefined; at: number } | undefined;

  /**
   * `mergeTree` says whether git's `merge-tree --write-tree` is used to find the conflicts with GitHub (by default: when git has it, from 2.38); without
   * it a merge in the working copy is made and always undone.
   */
  constructor(
    readonly dir: string,
    private readonly remote?: { owner: string; repo: string; branch: string; token: () => string | undefined; url?: string },
    private readonly options: { home?: string; mergeTree?: boolean } = {},
  ) {}

  get remoteUrl(): string | undefined {
    return this.remote ? this.remote.url ?? `https://github.com/${this.remote.owner}/${this.remote.repo}.git` : undefined;
  }

  private run(args: string[], options: GitProcessOptions = {}): Promise<GitResult & { code: number }> {
    return runGit(args, { ...options, home: this.options.home });
  }

  /** Git in the working tree, for the code that finds and resolves the conflicts with GitHub (`GitRunner`). The token goes only to a command that talks to GitHub. */
  exec(args: string[], options: GitExecOptions = {}): Promise<GitRun> {
    return this.run([...(options.author ? AUTHOR : []), ...args], {
      cwd: this.dir,
      token: options.network ? this.remote?.token() : undefined,
      env: options.env,
      input: options.input,
      okCodes: options.okCodes,
      encoding: options.encoding,
    });
  }

  /** Run in the working tree. The GitHub token goes only to the commands that talk to GitHub. */
  private git(args: string[], network = false, timeoutMs?: number): Promise<GitResult> {
    return this.run(args, { cwd: this.dir, token: network ? this.remote?.token() : undefined, timeoutMs });
  }

  async init(): Promise<void> {
    this.headCache = undefined;
    await this.run(["init", "--quiet", this.dir]);
    await this.git(["config", "--replace-all", "core.symlinks", "false"]);
  }

  /** Clone the book branch; when the branch does not exist yet it is created from the default branch. */
  async clone(): Promise<void> {
    this.headCache = undefined;
    if (!this.remote) throw new GitError("This book has no GitHub repository.");
    const token = this.remote.token();
    const { branch } = this.remote;
    const settings = ["--quiet", "--config", "core.symlinks=false"];
    try {
      await this.run(["clone", ...settings, "--branch", branch, "--single-branch", "--", this.remoteUrl!, this.dir], { token });
    } catch {
      await this.run(["clone", ...settings, "--", this.remoteUrl!, this.dir], { token });
      await this.git(["checkout", "--quiet", "-B", branch]);
    }
    await this.git(["config", "--replace-all", "core.symlinks", "false"]);
  }

  /**
   * What the revision depends on, as a fingerprint that costs a few reads instead of a process: the `HEAD` file, the file of the branch it
   * points to and the packed references. `undefined` when the layout is not one this understands (then nothing is kept).
   */
  private async headKey(): Promise<string | undefined> {
    const gitDirectory = path.join(this.dir, ".git");
    try {
      const head = (await readFile(path.join(gitDirectory, "HEAD"), "utf8")).trim();
      const mark = async (file: string) => stat(file).then((info) => `${info.ino}:${info.size}:${info.mtimeMs}`, () => "-");
      const branch = /^ref: (refs\/[A-Za-z0-9._/@+-]+)$/.exec(head)?.[1];
      if (branch) {
        // The newer reference storage keeps its references elsewhere: its files say nothing about them.
        if (await lstat(path.join(gitDirectory, "reftable")).then(() => true, () => false)) return undefined;
        return [head, await mark(path.join(gitDirectory, "HEAD")), await mark(path.join(gitDirectory, ...branch.split("/"))), await mark(path.join(gitDirectory, "packed-refs"))].join("|");
      }
      return /^[0-9a-f]{40,64}$/.test(head) ? head : undefined;
    } catch {
      return undefined;
    }
  }

  async head(): Promise<string | undefined> {
    const key = await this.headKey();
    if (key !== undefined && this.headCache?.key === key && Date.now() - this.headCache.at < HEAD_CACHE_MAX_AGE_MS) return this.headCache.head;
    let head: string | undefined;
    try {
      head = (await this.git(["rev-parse", "HEAD"])).stdout.trim() || undefined;
    } catch {
      head = undefined;
    }
    this.headCache = key === undefined ? undefined : { key, head, at: Date.now() };
    return head;
  }

  /** Stage and commit these paths (relative, `/`-separated, normalized by the caller). A failure leaves nothing staged. */
  async commit(paths: string[], message: string): Promise<string | undefined> {
    try {
      const present: string[] = [];
      const absent: string[] = [];
      for (const file of paths) ((await lstat(path.join(this.dir, file)).then(() => true, () => false)) ? present : absent).push(file);
      for (const batch of batches(present)) await this.git(["add", "--all", "--", ...batch]);
      for (const batch of batches(absent)) await this.git(["rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...batch]);
      if (!(await this.git(["diff", "--cached", "--name-only"])).stdout.trim()) return this.head();
      await this.git([...AUTHOR, "commit", "--quiet", "--no-verify", "-m", message]);
    } catch (error) {
      await this.unstage(paths);
      throw error;
    }
    this.headCache = undefined;
    return this.head();
  }

  /** After a failed commit the index goes back to HEAD for these paths, so the next commit does not carry them. */
  private async unstage(paths: string[]): Promise<void> {
    for (const batch of batches(paths)) await this.git(["reset", "--quiet", "--", ...batch]).catch(() => undefined);
  }

  /**
   * Undo what a process that stopped in the middle of a change of the copy left behind: git's lock, a temporary index, and a merge or a rebase that the
   * server's mark says was going on. Called when the server starts, and before every change of the copy with GitHub (the caller holds the book, so no
   * git of this server works on it meanwhile). Answers whether there was anything to undo.
   */
  async recover(): Promise<boolean> {
    const recovered = await recoverOperation(this);
    if (recovered) this.headCache = undefined;
    return recovered;
  }

  /** GitHub's branch, fetched now: its commit, or `undefined` when the branch is not on GitHub yet. */
  private async fetchBranch(): Promise<string | undefined> {
    const remote = this.remote!;
    try {
      await this.git(["fetch", "--quiet", "--", "origin", remote.branch], true);
    } catch (error) {
      if (error instanceof GitError && /couldn't find remote ref/i.test(error.stderr)) return undefined;
      throw error;
    }
    return (await this.git(["rev-parse", "FETCH_HEAD"])).stdout.trim();
  }

  private async revision(name: string): Promise<string> {
    return (await this.git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`])).stdout.trim();
  }

  private async mergeTree(): Promise<boolean> {
    return this.options.mergeTree ?? mergeTreeSupported();
  }

  /** Put local commits on top of GitHub's, as the server always did; `false` (and nothing changed) when git cannot. A mark says it is going on. */
  private async rebaseOnto(github: string): Promise<boolean> {
    await markOperation(this, "rebase");
    try {
      await this.git([...AUTHOR, "rebase", "--quiet", github]);
      return true;
    } catch {
      await this.git(["rebase", "--abort"]).catch(() => undefined);
      return false;
    } finally {
      await unmarkOperation(this);
      this.headCache = undefined;
    }
  }

  /** Move the branch and the working copy to a commit that descends from where they are. */
  private async fastForward(commit: string): Promise<void> {
    try {
      await this.git(["merge", "--ff-only", "--quiet", commit]);
    } finally {
      this.headCache = undefined;
    }
  }

  /** Push one commit to GitHub's branch (a resolution is pushed before the copy moves to it). */
  async pushCommit(commit: string): Promise<void> {
    await this.git(["push", "--quiet", "origin", `${commit}:refs/heads/${this.remote!.branch}`], true);
  }

  /**
   * Bring in the author's changes: fast-forward when possible; otherwise put the local commits on top of GitHub's, as the server always did, when the
   * two sides changed different files. When they changed the same ones it throws `GithubConflictError` and changes nothing: the author chooses
   * (`githubConflicts`, `resolveGithubConflicts`). The autopilot's own files are never asked about: when both sides changed them, the two sides are merged
   * (one merge commit) with those three files taken whole from one side (`autopilotSide`), and so they are also when git could not put the commits on
   * top of GitHub's although no file conflicts as a whole.
   */
  async pull(policy: GithubPolicy = {}): Promise<{ changed: boolean }> {
    if (!this.remote) return { changed: false };
    await this.recover();
    const before = await this.head();
    const github = await this.fetchBranch();
    if (!github) return { changed: false };
    try {
      await this.git(["merge", "--ff-only", "--quiet", github]);
    } catch (refused) {
      const server = before ?? await this.revision("HEAD");
      const trial = await trialMerge(this, server, github, { mergeTree: await this.mergeTree() });
      // One side holds the other, and still git could not move: what it said is the answer (a name it cannot write, a file in the way).
      if (!trial.tree) throw refused;
      if (trial.conflicts.length) throw new GithubConflictError(trial.conflicts.length);
      if (trial.autopilotBoth || !(await this.rebaseOnto(github))) {
        const side = trial.autopilotBoth ? await autopilotSide(this, server, github, policy.runActive === true) : undefined;
        const tree = await resolutionTree(this, trial, () => "server", side);
        const body = side ? `The autopilot's files changed on both sides: ${side === "server" ? "the server's" : "GitHub's"} are kept.` : "";
        await this.fastForward(await commitMerge(this, tree, trial, "Merge GitHub into the server's work", body));
      }
    }
    this.headCache = undefined;
    return { changed: (await this.head()) !== before };
  }

  async push(policy: GithubPolicy = {}): Promise<void> {
    if (!this.remote) return;
    try {
      await this.git(["push", "--quiet", "origin", `HEAD:refs/heads/${this.remote.branch}`], true);
    } catch (error) {
      if (!(error instanceof GitError) || !REJECTED_PUSH.test(error.stderr)) throw error;
      await this.pull(policy);
      await this.git(["push", "--quiet", "origin", `HEAD:refs/heads/${this.remote.branch}`], true);
    }
  }

  private requireRemote(): NonNullable<GitRepository["remote"]> {
    if (!this.remote) throw new HttpError(409, "no_remote", "This book is not on GitHub: it has no conflicts with GitHub to resolve.");
    return this.remote;
  }

  /** What GitHub's branch and the server's copy are now: the trial merge of the two, after a fetch (`github` is empty when the branch is not on GitHub yet). */
  private async compare(): Promise<TrialMerge> {
    const server = await this.revision("HEAD");
    const github = await this.fetchBranch();
    if (!github) {
      const ahead = Number((await this.git(["rev-list", "--count", server])).stdout.trim()) || 0;
      return { server, github: "", conflicts: [], autopilotBoth: false, ahead, behind: 0 };
    }
    return trialMerge(this, server, github, { mergeTree: await this.mergeTree() });
  }

  /**
   * The files that changed on both sides since the server's copy and GitHub parted, a page at a time: fetched now, compared by a merge that writes
   * nothing, in the order of their paths. The autopilot's own files are not among them (`autopilotFiles` says who would keep them).
   */
  async githubConflicts(page: { offset: number; limit: number }, policy: GithubPolicy = {}): Promise<GithubConflictsResponse> {
    const remote = this.requireRemote();
    await this.recover();
    const trial = await this.compare();
    const side = trial.autopilotBoth ? await autopilotSide(this, trial.server, trial.github, policy.runActive === true) : undefined;
    return conflictPage(this, trial, page, remote.branch, side);
  }

  /**
   * Resolve the conflicts with GitHub: one merge commit of the server's work and GitHub's, in which every file that conflicts is the version chosen,
   * built without touching the working copy, pushed (`policy.push`), and only then the copy moves to it. Refused, with nothing written: nothing to
   * resolve (`409 not_conflicted`), conflicts that are not the ones the author chose from (`409 conflicts_changed`, with the list as it is now; also
   * when GitHub moves onto them while the resolution is pushed), a file without a choice (`400 choice_missing`), a name git cannot write
   * (`422 invalid_github_path`). A push that GitHub refuses because it moved elsewhere is made once more on the new GitHub; one that fails for another
   * reason leaves the resolution on the server, and says why.
   */
  async resolveGithubConflicts(request: ResolveGithubConflictsRequest, policy: GithubPolicy & { push: boolean }): Promise<ResolveGithubConflictsResponse> {
    const remote = this.requireRemote();
    await this.recover();
    let trial = await this.compare();
    if (!trial.github || !trial.conflicts.length) throw new HttpError(409, "not_conflicted", "Nothing conflicts with GitHub: there is nothing to resolve. A sync brings the two together.");
    const sideOf = (current: TrialMerge) => (current.autopilotBoth ? autopilotSide(this, current.server, current.github, policy.runActive === true) : Promise.resolve(undefined));
    let side = await sideOf(trial);
    const fingerprint = fingerprintOf(trial);
    if (request.fingerprint !== fingerprint) throw await conflictsChanged(this, trial, remote.branch, side);
    const plan = planResolution(trial, request);
    const merge = async (current: TrialMerge, kept: typeof side) => {
      const tree = await resolutionTree(this, current, plan.decide, kept);
      const { subject, body } = resolutionMessage(request, plan, kept);
      return commitMerge(this, tree, current, subject, body);
    };
    let commit = await merge(trial, side);
    let pushed = false;
    let pushError: string | undefined;
    const failed = (error: unknown) => {
      const token = remote.token();
      const text = error instanceof Error ? error.message : String(error);
      return (token ? text.split(token).join("***") : text).slice(0, PUSH_ERROR_CHARACTERS);
    };
    if (policy.push) {
      try {
        await this.pushCommit(commit);
        pushed = true;
      } catch (error) {
        const stderr = error instanceof GitError ? error.stderr : error instanceof Error ? error.message : "";
        if (!REJECTED_PUSH.test(stderr)) pushError = failed(error);
        else {
          // GitHub moved while the resolution was on its way: once more on GitHub as it is now, if the conflicts are still the ones the author chose for.
          const again = await this.compare();
          if (!again.github || fingerprintOf(again) !== fingerprint) throw await conflictsChanged(this, again, remote.branch, again.github ? await sideOf(again) : undefined);
          trial = again;
          side = await sideOf(trial);
          commit = await merge(trial, side);
          try {
            await this.pushCommit(commit);
            pushed = true;
          } catch (retry) {
            pushError = failed(retry);
          }
        }
      }
    }
    await this.fastForward(commit);
    return { head: commit, pushed, ...(pushError ? { pushError } : {}), ...plan.answer, ...(side ? { autopilotFiles: side } : {}) };
  }
}

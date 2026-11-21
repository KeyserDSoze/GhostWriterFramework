import { execFile, type ExecFileException } from "node:child_process";
import { rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface GitResult {
  stdout: string;
  stderr: string;
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

function execGit(args: string[], env: NodeJS.ProcessEnv, options: { cwd?: string; token?: string; timeoutMs?: number }): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: options.cwd, env, timeout: options.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error: ExecFileException | null, stdout, stderr) => {
      if (error) {
        const detail = redact(String(stderr || error.message).trim(), options.token);
        const timedOut = error.killed === true;
        reject(new GitError(`git ${subcommand(args)} failed: ${detail.split("\n").slice(-3).join(" ")}`, detail, timedOut || TRANSIENT_GIT_FAILURE.test(detail)));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Run git in a private environment: `home` (or a private folder of this process) replaces the owner's home,
 * so their global configuration, hooks, URL rewrites and credential helpers never apply.
 */
export async function runGit(args: string[], options: { cwd?: string; token?: string; timeoutMs?: number; home?: string } = {}): Promise<GitResult> {
  const sandbox = await prepareSandbox(options.home ?? await defaultHome());
  return execGit([...hardening(sandbox), ...args], gitEnvironment(sandbox, options.token), options);
}

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

/** A working tree used by the server: commits every autopilot step, optionally synced with GitHub. */
export class GitRepository {
  /** `git rev-parse HEAD`, kept while the files it is read from have not changed (see `headKey`). */
  private headCache: { key: string; head: string | undefined; at: number } | undefined;

  constructor(
    readonly dir: string,
    private readonly remote?: { owner: string; repo: string; branch: string; token: () => string | undefined; url?: string },
    private readonly options: { home?: string } = {},
  ) {}

  get remoteUrl(): string | undefined {
    return this.remote ? this.remote.url ?? `https://github.com/${this.remote.owner}/${this.remote.repo}.git` : undefined;
  }

  private run(args: string[], options: { cwd?: string; token?: string; timeoutMs?: number } = {}): Promise<GitResult> {
    return runGit(args, { ...options, home: this.options.home });
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

  /** Bring in the author's changes: fast-forward when possible, otherwise rebase local commits. */
  async pull(): Promise<{ changed: boolean }> {
    if (!this.remote) return { changed: false };
    const before = await this.head();
    try {
      await this.git(["fetch", "--quiet", "--", "origin", this.remote.branch], true);
    } catch (error) {
      if (error instanceof GitError && /couldn't find remote ref/i.test(error.stderr)) return { changed: false };
      throw error;
    }
    try {
      await this.git(["merge", "--ff-only", "--quiet", "FETCH_HEAD"]);
    } catch {
      try {
        await this.git([...AUTHOR, "rebase", "--quiet", "FETCH_HEAD"]);
      } catch (error) {
        await this.git(["rebase", "--abort"]).catch(() => undefined);
        throw new GitError("The book changed on GitHub in a way that conflicts with the server's work. Resolve it from the web app, then resume.", error instanceof GitError ? error.stderr : "");
      }
    }
    this.headCache = undefined;
    return { changed: (await this.head()) !== before };
  }

  async push(): Promise<void> {
    if (!this.remote) return;
    try {
      await this.git(["push", "--quiet", "origin", `HEAD:refs/heads/${this.remote.branch}`], true);
    } catch (error) {
      if (!(error instanceof GitError) || !/rejected|fetch first|non-fast-forward/i.test(error.stderr)) throw error;
      await this.pull();
      await this.git(["push", "--quiet", "origin", `HEAD:refs/heads/${this.remote.branch}`], true);
    }
  }
}

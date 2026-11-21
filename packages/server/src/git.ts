import { execFile } from "node:child_process";

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

/** Environment for git children: no prompts, no system config, the token only as an HTTP header. */
function gitEnvironment(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? process.env.USERPROFILE,
    USERPROFILE: process.env.USERPROFILE,
    SYSTEMROOT: process.env.SYSTEMROOT,
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
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

function redact(text: string, token?: string): string {
  return token ? text.split(token).join("***") : text;
}

export function runGit(args: string[], options: { cwd?: string; token?: string; timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: options.cwd, env: gitEnvironment(options.token), timeout: options.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = redact(String(stderr || error.message).trim(), options.token);
        const timedOut = (error as { killed?: boolean }).killed === true;
        reject(new GitError(`git ${args[0]} failed: ${detail.split("\n").slice(-3).join(" ")}`, detail, timedOut || TRANSIENT_GIT_FAILURE.test(detail)));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function gitVersion(): Promise<string | null> {
  try {
    const { stdout } = await runGit(["--version"], { timeoutMs: 10_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** A working tree used by the server: commits every autopilot step, optionally synced with GitHub. */
export class GitRepository {
  constructor(readonly dir: string, private readonly remote?: { owner: string; repo: string; branch: string; token: () => string | undefined; url?: string }) {}

  get remoteUrl(): string | undefined {
    return this.remote ? this.remote.url ?? `https://github.com/${this.remote.owner}/${this.remote.repo}.git` : undefined;
  }

  private git(args: string[], timeoutMs?: number): Promise<GitResult> {
    return runGit(args, { cwd: this.dir, token: this.remote?.token(), timeoutMs });
  }

  async init(): Promise<void> {
    await runGit(["init", "--quiet", this.dir]);
  }

  /** Clone the book branch; when the branch does not exist yet it is created from the default branch. */
  async clone(): Promise<void> {
    if (!this.remote) throw new GitError("This book has no GitHub repository.");
    const token = this.remote.token();
    try {
      await runGit(["clone", "--quiet", "--branch", this.remote.branch, "--single-branch", this.remoteUrl!, this.dir], { token });
    } catch {
      await runGit(["clone", "--quiet", this.remoteUrl!, this.dir], { token });
      await this.git(["checkout", "--quiet", "-B", this.remote.branch]);
    }
  }

  async head(): Promise<string | undefined> {
    try {
      return (await this.git(["rev-parse", "HEAD"])).stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async commit(paths: string[], message: string): Promise<string | undefined> {
    if (paths.length) await this.git(["add", "--all", "--", ...paths]);
    const status = (await this.git(["status", "--porcelain"])).stdout.trim();
    if (!status) return this.head();
    await this.git([...AUTHOR, "commit", "--quiet", "--no-verify", "-m", message]);
    return this.head();
  }

  /** Bring in the author's changes: fast-forward when possible, otherwise rebase local commits. */
  async pull(): Promise<{ changed: boolean }> {
    if (!this.remote) return { changed: false };
    const before = await this.head();
    try {
      await this.git(["fetch", "--quiet", "origin", this.remote.branch]);
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
    return { changed: (await this.head()) !== before };
  }

  async push(): Promise<void> {
    if (!this.remote) return;
    try {
      await this.git(["push", "--quiet", "origin", `HEAD:refs/heads/${this.remote.branch}`]);
    } catch (error) {
      if (!(error instanceof GitError) || !/rejected|fetch first|non-fast-forward/i.test(error.stderr)) throw error;
      await this.pull();
      await this.git(["push", "--quiet", "origin", `HEAD:refs/heads/${this.remote.branch}`]);
    }
  }
}

import type { Octokit } from "@octokit/rest";
import { gitBlobSha } from "@/readerUpdate/publishingBranch";

export interface FakeBranchCommit { sha: string; parents: string[]; message: string; files: Map<string, string> }

export interface FakeBranchGitHub {
  octokit: Octokit;
  commits: Map<string, FakeBranchCommit>;
  refs: Map<string, string>;
  /** Branches that refuse a push with the message of a protected branch. */
  protectedBranches: Set<string>;
  pullRequests: Array<{ head: string; base: string; title: string; body: string; number: number }>;
  calls: Array<{ method: string; args: Record<string, unknown> }>;
  /** Makes a commit on a branch, as someone else would (the head moves under the card). */
  commit(branch: string, files: Record<string, string>, message?: string): string;
  filesOf(branch: string): Map<string, string>;
}

function failure(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** An in-memory repository for the Git data API only (refs, commits, trees, blobs), enough for the update of the reader on a branch that is not checked out. */
export function createFakeBranchGitHub(initial: { branch: string; files: Record<string, string> }): FakeBranchGitHub {
  const commits = new Map<string, FakeBranchCommit>();
  const trees = new Map<string, Map<string, string>>();
  const refs = new Map<string, string>();
  const calls: FakeBranchGitHub["calls"] = [];
  const pullRequests: FakeBranchGitHub["pullRequests"] = [];
  const protectedBranches = new Set<string>();
  let counter = 0;
  const next = (prefix: string) => `${prefix}${String(++counter).padStart(4, "0")}`;

  const makeCommit = (parents: string[], files: Map<string, string>, message: string): string => {
    const sha = next("c");
    const treeSha = next("t");
    trees.set(treeSha, files);
    commits.set(sha, { sha, parents, message, files });
    treeOfCommit.set(sha, treeSha);
    return sha;
  };
  const treeOfCommit = new Map<string, string>();
  const head = makeCommit([], new Map(Object.entries(initial.files)), "Initial");
  refs.set(initial.branch, head);

  const record = (method: string, args: Record<string, unknown>) => calls.push({ method, args });
  const branchOf = (ref: string) => ref.replace(/^refs\//, "").replace(/^heads\//, "");

  const entries = async (treeSha: string, files: Map<string, string>, prefix: string, recursive: boolean) => {
    const out: Array<{ path: string; type: "blob" | "tree"; sha: string }> = [];
    const dirs = new Set<string>();
    for (const [path, content] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0 || recursive) out.push({ path: rest, type: "blob", sha: await gitBlobSha(content) });
      else if (!dirs.has(rest.slice(0, slash))) { dirs.add(rest.slice(0, slash)); out.push({ path: rest.slice(0, slash), type: "tree", sha: `dir:${treeSha}:${prefix}${rest.slice(0, slash)}/` }); }
    }
    return out;
  };

  const git = {
    getRef: async (args: { ref: string }) => {
      record("getRef", args);
      const sha = refs.get(branchOf(args.ref));
      if (!sha) throw failure(404, "Not Found");
      return { data: { object: { sha } } };
    },
    getCommit: async (args: { commit_sha: string }) => {
      record("getCommit", args);
      const treeSha = treeOfCommit.get(args.commit_sha);
      if (!treeSha) throw failure(404, "Not Found");
      return { data: { tree: { sha: treeSha } } };
    },
    getTree: async (args: { tree_sha: string; recursive?: string }) => {
      record("getTree", args);
      const sha = args.tree_sha;
      if (sha.startsWith("dir:")) {
        const [, treeSha, prefix] = /^dir:([^:]+):(.*)$/.exec(sha) ?? [];
        return { data: { truncated: false, tree: await entries(treeSha, trees.get(treeSha)!, prefix, args.recursive === "1") } };
      }
      return { data: { truncated: false, tree: await entries(sha, trees.get(sha)!, "", false) } };
    },
    getBlob: async (args: { file_sha: string }) => {
      record("getBlob", args);
      for (const commit of commits.values()) for (const content of commit.files.values()) if (await gitBlobSha(content) === args.file_sha) return { data: { content: btoa(String.fromCharCode(...new TextEncoder().encode(content))), encoding: "base64" } };
      throw failure(404, "Not Found");
    },
    createTree: async (args: { base_tree?: string; tree: Array<{ path: string; content?: string; sha?: null }> }) => {
      record("createTree", args);
      const files = new Map(args.base_tree ? trees.get(args.base_tree)! : []);
      for (const entry of args.tree) { if (entry.sha === null) files.delete(entry.path); else files.set(entry.path, entry.content ?? ""); }
      const sha = next("t");
      trees.set(sha, files);
      return { data: { sha } };
    },
    createCommit: async (args: { message: string; tree: string; parents: string[] }) => {
      record("createCommit", args);
      const sha = next("c");
      const files = trees.get(args.tree)!;
      commits.set(sha, { sha, parents: args.parents, message: args.message, files });
      treeOfCommit.set(sha, args.tree);
      return { data: { sha } };
    },
    updateRef: async (args: { ref: string; sha: string; force?: boolean }) => {
      record("updateRef", args);
      const branch = branchOf(args.ref);
      if (protectedBranches.has(branch)) throw failure(422, `Protected branch update failed for refs/heads/${branch}. Changes must be made through a pull request.`);
      const current = refs.get(branch);
      if (!current) throw failure(422, "Reference does not exist");
      if (!args.force && !commits.get(args.sha)?.parents.includes(current)) throw failure(422, "Update is not a fast forward");
      refs.set(branch, args.sha);
      return { data: {} };
    },
    createRef: async (args: { ref: string; sha: string }) => {
      record("createRef", args);
      const branch = branchOf(args.ref);
      if (refs.has(branch)) throw failure(422, "Reference already exists");
      refs.set(branch, args.sha);
      return { data: {} };
    },
  };
  const repos = {
    getContent: async (args: { path: string; ref?: string }) => {
      record("getContent", args);
      const commit = commits.get(args.ref ?? "") ?? commits.get(refs.get(args.ref ?? "") ?? "");
      const content = commit?.files.get(args.path);
      if (content === undefined) throw failure(404, "Not Found");
      return { data: { type: "file", content: btoa(String.fromCharCode(...new TextEncoder().encode(content))) } };
    },
  };
  const pulls = {
    create: async (args: { head: string; base: string; title: string; body: string }) => {
      record("pulls.create", args);
      const number = pullRequests.length + 1;
      pullRequests.push({ ...args, number });
      return { data: { html_url: `https://github.com/o/r/pull/${number}`, number } };
    },
  };
  return {
    octokit: { rest: { git, repos, pulls } } as unknown as Octokit,
    commits, refs, protectedBranches, pullRequests, calls,
    commit(branch, files, message = "Someone else") {
      const current = refs.get(branch)!;
      const merged = new Map(commits.get(current)!.files);
      for (const [path, content] of Object.entries(files)) merged.set(path, content);
      const sha = makeCommit([current], merged, message);
      refs.set(branch, sha);
      return sha;
    },
    filesOf: (branch) => commits.get(refs.get(branch)!)!.files,
  };
}

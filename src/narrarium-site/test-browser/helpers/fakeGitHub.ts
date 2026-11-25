import type { Octokit } from "@octokit/rest";

/**
 * A small GitHub that answers the calls the creation of a book repository makes (`@/github/bookRepository`): repositories, the Git Data API on trees
 * with `base_tree`, commits, references, the contents API, Pages. It keeps the files of every commit, so a test can read what landed; and it fails
 * on demand, the way GitHub does (a status, a message, the headers of a rate limit), so a test can say what the token or the account cannot do.
 * Nothing here talks to the network and no token is read: the whole of the tests of the creation run against this.
 */

export interface FakeCall { name: string; params: Record<string, unknown> }

export interface FakeFault {
  /** The call, as `git.createRef`, `repos.createForAuthenticatedUser`... */
  call: string;
  /** Fails only when this holds for the parameters of the call. */
  when?: (params: Record<string, any>, state: FakeRepo | undefined) => boolean;
  status: number;
  message: string;
  headers?: Record<string, string>;
  errors?: unknown[];
  /** How many times it fails (default: every time). */
  times?: number;
}

export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  commits: Map<string, { tree: string; parents: string[]; message: string }>;
  /** Every tree as the flat list of its files: path → blob sha. */
  trees: Map<string, Map<string, string>>;
  blobs: Map<string, { encoding: string; size: number }>;
  pages: boolean;
  deleted?: boolean;
}

export interface FakeGitHubOptions {
  login?: string;
  orgs?: string[];
  /** The header of a classic token; leave out for a fine-grained token. */
  scopes?: string;
  /** Repositories that exist already (`owner/name`), empty unless they say otherwise. */
  existing?: Array<{ owner: string; name: string; private?: boolean; branch?: string; withBranch?: boolean }>;
  /** How GitHub treats the Git Data API on an empty repository: accept it (`ok`), refuse the tree (`tree`), or accept the objects and refuse the reference (`ref`). */
  emptyRepository?: "ok" | "tree" | "ref";
  /** The answer when a commit puts a workflow file on the branch (the token cannot write workflows): omit for a token that can. */
  workflowRefusal?: { status: number; message: string };
  faults?: FakeFault[];
  defaultBranch?: string;
}

export function requestError(status: number, message: string, headers: Record<string, string> = {}, errors?: unknown[]): Error {
  return Object.assign(new Error(message), { name: "HttpError", status, response: { status, headers, data: { message, ...(errors ? { errors } : {}) } } });
}

export function createFakeGitHub(options: FakeGitHubOptions = {}) {
  const login = options.login ?? "ada";
  const repos = new Map<string, FakeRepo>();
  const calls: FakeCall[] = [];
  const faults = (options.faults ?? []).map((fault) => ({ ...fault, remaining: fault.times ?? Infinity }));
  let counter = 0;
  const sha = () => (++counter).toString(16).padStart(40, "0");
  let ids = 100;

  const key = (owner: string, name: string) => `${owner.toLowerCase()}/${name.toLowerCase()}`;
  const repoOf = (owner: string, name: string): FakeRepo | undefined => {
    const repo = repos.get(key(owner, name));
    return repo && !repo.deleted ? repo : undefined;
  };
  const addRepo = (owner: string, name: string, isPrivate: boolean, branch = options.defaultBranch ?? "main"): FakeRepo => {
    const repo: FakeRepo = { id: ++ids, owner, name, private: isPrivate, defaultBranch: branch, refs: new Map(), commits: new Map(), trees: new Map(), blobs: new Map(), pages: false };
    repos.set(key(owner, name), repo);
    return repo;
  };
  for (const entry of options.existing ?? []) {
    const repo = addRepo(entry.owner, entry.name, entry.private ?? true, entry.branch);
    if (entry.withBranch) {
      const tree = sha();
      repo.trees.set(tree, new Map([["old.md", sha()]]));
      const commit = sha();
      repo.commits.set(commit, { tree, parents: [], message: "Someone's work" });
      repo.refs.set(`heads/${repo.defaultBranch}`, commit);
    }
  }

  function enter(name: string, params: Record<string, any>) {
    calls.push({ name, params });
    const repo = params.owner && params.repo ? repoOf(params.owner, params.repo) : undefined;
    for (const fault of faults) {
      if (fault.call !== name || fault.remaining <= 0) continue;
      if (fault.when && !fault.when(params, repo)) continue;
      fault.remaining -= 1;
      throw requestError(fault.status, fault.message, fault.headers, fault.errors);
    }
    return repo;
  }
  const needRepo = (repo: FakeRepo | undefined): FakeRepo => {
    if (!repo) throw requestError(404, "Not Found");
    return repo;
  };
  const isEmpty = (repo: FakeRepo) => repo.refs.size === 0;
  const refKey = (ref: string) => ref.replace(/^refs\//, "");

  const git = {
    async getRef(params: any) {
      const repo = needRepo(enter("git.getRef", params));
      const target = repo.refs.get(refKey(params.ref));
      if (!target) throw isEmpty(repo) ? requestError(409, "Git Repository is empty.") : requestError(404, "Not Found");
      return { data: { object: { sha: target } } };
    },
    async getCommit(params: any) {
      const repo = needRepo(enter("git.getCommit", params));
      const commit = repo.commits.get(params.commit_sha);
      if (!commit) throw requestError(404, "Not Found");
      return { data: { sha: params.commit_sha, message: commit.message, parents: commit.parents.map((parent) => ({ sha: parent })), tree: { sha: commit.tree } } };
    },
    async createBlob(params: any) {
      const repo = needRepo(enter("git.createBlob", params));
      if (isEmpty(repo) && options.emptyRepository === "tree") throw requestError(409, "Git Repository is empty.");
      const id = sha();
      repo.blobs.set(id, { encoding: params.encoding, size: params.content.length });
      return { data: { sha: id } };
    },
    async createTree(params: any) {
      const repo = needRepo(enter("git.createTree", params));
      if (isEmpty(repo) && options.emptyRepository === "tree") throw requestError(409, "Git Repository is empty.");
      const files = new Map<string, string>(params.base_tree ? repo.trees.get(params.base_tree) ?? [] : []);
      if (params.base_tree && !repo.trees.has(params.base_tree)) throw requestError(422, "The tree base_tree does not exist");
      for (const entry of params.tree as Array<{ path: string; content?: string; sha?: string }>) {
        if (entry.sha && !repo.blobs.has(entry.sha)) throw requestError(422, `Invalid tree: blob ${entry.sha} does not exist`);
        files.set(entry.path, entry.sha ?? `inline:${entry.content}`);
      }
      const id = sha();
      repo.trees.set(id, files);
      return { data: { sha: id, tree: [] } };
    },
    async createCommit(params: any) {
      const repo = needRepo(enter("git.createCommit", params));
      if (isEmpty(repo) && options.emptyRepository === "tree") throw requestError(409, "Git Repository is empty.");
      if (!repo.trees.has(params.tree)) throw requestError(422, "Tree does not exist");
      const id = sha();
      repo.commits.set(id, { tree: params.tree, parents: params.parents, message: params.message });
      return { data: { sha: id } };
    },
    async createRef(params: any) {
      const repo = needRepo(enter("git.createRef", params));
      if (isEmpty(repo) && options.emptyRepository !== "ok" && options.emptyRepository !== undefined) throw requestError(422, "Reference update failed");
      if (repo.refs.has(refKey(params.ref))) throw requestError(422, "Reference already exists");
      if (!repo.commits.has(params.sha)) throw requestError(422, "Object does not exist");
      repo.refs.set(refKey(params.ref), params.sha);
      return { data: { ref: params.ref, object: { sha: params.sha } } };
    },
    async deleteRef(params: any) {
      const repo = needRepo(enter("git.deleteRef", params));
      if (!repo.refs.delete(refKey(params.ref))) throw requestError(422, "Reference does not exist");
      return { data: undefined };
    },
    async updateRef(params: any) {
      const repo = needRepo(enter("git.updateRef", params));
      const name = refKey(params.ref);
      const current = repo.refs.get(name);
      if (!current) throw requestError(422, "Reference does not exist");
      const commit = repo.commits.get(params.sha);
      if (!commit) throw requestError(422, "Object does not exist");
      if (!params.force && params.sha !== current) {
        let cursor: string | undefined = params.sha;
        let ahead = false;
        while (cursor) {
          if (cursor === current) { ahead = true; break; }
          cursor = repo.commits.get(cursor)?.parents[0];
        }
        if (!ahead) throw requestError(422, "Update is not a fast forward");
      }
      if (options.workflowRefusal) {
        const before = new Set(repo.trees.get(repo.commits.get(current)!.tree)?.keys());
        const added = [...(repo.trees.get(commit.tree)?.keys() ?? [])].find((path) => /(^|\/)\.github\/workflows\//.test(path) && !before.has(path));
        if (added) throw requestError(options.workflowRefusal.status, options.workflowRefusal.message);
      }
      repo.refs.set(name, params.sha);
      return { data: { ref: params.ref, object: { sha: params.sha } } };
    },
  };

  const rest = {
    users: {
      async getAuthenticated(params: any = {}) {
        enter("users.getAuthenticated", params);
        return { data: { login }, headers: options.scopes === undefined ? {} : { "x-oauth-scopes": options.scopes } };
      },
    },
    orgs: {
      async listForAuthenticatedUser(params: any = {}) {
        enter("orgs.listForAuthenticatedUser", params);
        return { data: (options.orgs ?? []).map((org) => ({ login: org })) };
      },
    },
    repos: {
      async get(params: any) {
        const repo = enter("repos.get", params);
        if (!repo) throw requestError(404, "Not Found");
        return { data: describe(repo) };
      },
      async createForAuthenticatedUser(params: any) {
        enter("repos.createForAuthenticatedUser", params);
        if (repoOf(login, params.name)) throw requestError(422, "Repository creation failed.", {}, [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }]);
        return { data: describe(addRepo(login, params.name, params.private)) };
      },
      async createInOrg(params: any) {
        enter("repos.createInOrg", params);
        if (!(options.orgs ?? []).includes(params.org)) throw requestError(404, "Not Found");
        if (repoOf(params.org, params.name)) throw requestError(422, "Repository creation failed.", {}, [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }]);
        return { data: describe(addRepo(params.org, params.name, params.private)) };
      },
      async createOrUpdateFileContents(params: any) {
        const repo = needRepo(enter("repos.createOrUpdateFileContents", params));
        const tree = sha();
        repo.trees.set(tree, new Map([[params.path, `inline:${params.content}`]]));
        const commit = sha();
        repo.commits.set(commit, { tree, parents: [], message: params.message });
        repo.refs.set(`heads/${repo.defaultBranch}`, commit);
        return { data: { commit: { sha: commit } } };
      },
      async createPagesSite(params: any) {
        const repo = needRepo(enter("repos.createPagesSite", params));
        if (repo.pages) throw requestError(409, "A GitHub Pages site already exists for this repository.");
        repo.pages = true;
        return { data: { build_type: params.build_type } };
      },
      async update(params: any) {
        const repo = needRepo(enter("repos.update", params));
        if (params.default_branch !== undefined) {
          if (!repo.refs.has(`heads/${params.default_branch}`)) throw requestError(422, "Validation Failed");
          repo.defaultBranch = params.default_branch;
        }
        return { data: describe(repo) };
      },
      async delete(params: any) {
        const repo = needRepo(enter("repos.delete", params));
        repo.deleted = true;
        return { data: undefined };
      },
    },
    git,
  };

  function describe(repo: FakeRepo) {
    return { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, default_branch: repo.defaultBranch, html_url: `https://github.com/${repo.owner}/${repo.name}` };
  }

  /** The files at the tip of a branch, as `path → text` (inline) or `path → blob sha`. */
  function filesAt(owner: string, name: string, branch = "main"): Map<string, string> | null {
    const repo = repoOf(owner, name);
    const head = repo?.refs.get(`heads/${branch}`);
    const commit = head ? repo?.commits.get(head) : undefined;
    return commit ? repo?.trees.get(commit.tree) ?? null : null;
  }
  function history(owner: string, name: string, branch = "main"): Array<{ sha: string; message: string; parents: string[] }> {
    const repo = repoOf(owner, name);
    const out: Array<{ sha: string; message: string; parents: string[] }> = [];
    let cursor = repo?.refs.get(`heads/${branch}`);
    while (cursor && repo) {
      const commit = repo.commits.get(cursor)!;
      out.push({ sha: cursor, message: commit.message, parents: commit.parents });
      cursor = commit.parents[0];
    }
    return out;
  }

  return {
    octokit: { rest } as unknown as Octokit,
    calls,
    repos,
    repo: (owner: string, name: string) => repoOf(owner, name),
    filesAt,
    history,
    count: (name: string) => calls.filter((call) => call.name === name).length,
    names: () => calls.map((call) => call.name),
  };
}

export type FakeGitHub = ReturnType<typeof createFakeGitHub>;

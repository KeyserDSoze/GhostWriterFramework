/**
 * A GitHub repository with branches, for the tests of the automatic sync: the Git Data API the working copies use (references, commits, trees, blobs, with
 * GitHub's refusal of an update that is not a fast forward), the list of branches with its ETag (a 304 to a request that sends the ETag of an unchanged list)
 * and the rate-limit headers, and the raw blobs the clones and pulls download with `fetch`. Another device or person changes it with `commitOn`.
 * Every call is recorded; nothing reaches the network.
 */

export interface GitServerCall { name: string; params: Record<string, unknown> }

export function gitRequestError(status: number, message: string, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(message), { name: "HttpError", status, response: { status, headers, data: { message } } });
}

function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

let servers = 0;

export function createFakeGitServer(options: { owner?: string; repo?: string; defaultBranch?: string; files?: Record<string, string> } = {}) {
  const owner = options.owner ?? "writer";
  const repo = options.repo ?? "novel";
  const defaultBranch = options.defaultBranch ?? "main";
  const blobs = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const refs = new Map<string, string>();
  const calls: GitServerCall[] = [];
  const rate = { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 };
  let counter = 0;
  const instance = (++servers).toString(16).padStart(7, "0");

  const enter = (name: string, params: Record<string, unknown> = {}) => { calls.push({ name, params }); };
  const charge = () => { rate.remaining = Math.max(0, rate.remaining - 1); };
  const rateHeaders = () => ({ "x-ratelimit-limit": String(rate.limit), "x-ratelimit-remaining": String(rate.remaining), "x-ratelimit-reset": String(rate.reset) });

  const blob = (content: string): string => {
    const sha = `blob${hashOf(content)}${content.length.toString(16)}`;
    blobs.set(sha, content);
    return sha;
  };
  // Trees are named by their content, as GitHub's are: the same files are the same tree.
  const tree = (entries: Map<string, string>): string => {
    const sha = `tree${hashOf(JSON.stringify([...entries].sort(([left], [right]) => left.localeCompare(right))))}`;
    trees.set(sha, new Map(entries));
    return sha;
  };
  const commit = (treeSha: string, parents: string[], message: string): string => {
    const sha = `c${instance}${(++counter).toString(16).padStart(32, "0")}`;
    commits.set(sha, { tree: treeSha, parents, message });
    return sha;
  };
  const filesOf = (branch: string): Map<string, string> => {
    const head = refs.get(branch);
    const entries = head ? trees.get(commits.get(head)!.tree)! : new Map<string, string>();
    return new Map([...entries].map(([path, sha]) => [path, blobs.get(sha)!]));
  };
  /** Another device, or another person, changes a branch on GitHub (`null` deletes a file). */
  const commitOn = (branch: string, changes: Record<string, string | null>, message = "Change from elsewhere"): string => {
    const parent = refs.get(branch);
    const entries = new Map(parent ? trees.get(commits.get(parent)!.tree)! : []);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) entries.delete(path);
      else entries.set(path, blob(content));
    }
    const sha = commit(tree(entries), parent ? [parent] : [], message);
    refs.set(branch, sha);
    return sha;
  };
  commitOn(defaultBranch, options.files ?? { "book.md": "---\ntype: book\ntitle: Novel\n---\n" }, "Initial commit");

  const listEtag = () => `W/"${hashOf(JSON.stringify([...refs].sort()))}"`;
  const requireRef = (ref: string): string => {
    const name = ref.replace(/^refs\//, "").replace(/^heads\//, "");
    const head = refs.get(name);
    if (!head) throw gitRequestError(404, "Not Found");
    return head;
  };
  const isAncestor = (ancestor: string, descendant: string): boolean => {
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const next = queue.shift()!;
      if (next === ancestor) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(commits.get(next)?.parents ?? []));
    }
    return false;
  };

  const git = {
    async getRef(params: { ref: string }) {
      enter("git.getRef", params); charge();
      const sha = requireRef(params.ref);
      return { data: { ref: `refs/${params.ref}`, object: { sha, type: "commit" } }, headers: rateHeaders() };
    },
    async getCommit(params: { commit_sha: string }) {
      enter("git.getCommit", params); charge();
      const found = commits.get(params.commit_sha);
      if (!found) throw gitRequestError(404, "Not Found");
      return { data: { sha: params.commit_sha, message: found.message, tree: { sha: found.tree }, parents: found.parents.map((sha) => ({ sha })) } };
    },
    async getTree(params: { tree_sha: string }) {
      enter("git.getTree", params); charge();
      // GitHub takes a commit for a tree, as the clone asks.
      const found = trees.get(params.tree_sha) ?? trees.get(commits.get(params.tree_sha)?.tree ?? "");
      if (!found) throw gitRequestError(404, "Not Found");
      return { data: { sha: params.tree_sha, truncated: false, tree: [...found].map(([path, sha]) => ({ path, mode: "100644", type: "blob", sha, size: new TextEncoder().encode(blobs.get(sha) ?? "").byteLength })) } };
    },
    async createBlob(params: { content: string; encoding?: string }) {
      enter("git.createBlob", { encoding: params.encoding }); charge();
      const text = params.encoding === "base64" ? new TextDecoder().decode(Uint8Array.from(atob(params.content), (char) => char.charCodeAt(0))) : params.content;
      return { data: { sha: blob(text) } };
    },
    async createTree(params: { base_tree?: string; tree: Array<{ path: string; sha: string | null; content?: string }> }) {
      enter("git.createTree", params); charge();
      const entries = new Map(params.base_tree ? trees.get(params.base_tree) ?? [] : []);
      for (const entry of params.tree) {
        if (entry.sha === null) entries.delete(entry.path);
        else if (entry.content !== undefined) entries.set(entry.path, blob(entry.content));
        else entries.set(entry.path, entry.sha);
      }
      return { data: { sha: tree(entries) } };
    },
    async createCommit(params: { message: string; tree: string; parents: string[] }) {
      enter("git.createCommit", params); charge();
      return { data: { sha: commit(params.tree, params.parents, params.message) } };
    },
    async createRef(params: { ref: string; sha: string }) {
      enter("git.createRef", params); charge();
      const name = params.ref.replace(/^refs\/heads\//, "");
      if (refs.has(name)) throw gitRequestError(422, "Reference already exists");
      if (!commits.has(params.sha)) throw gitRequestError(422, "Object does not exist");
      refs.set(name, params.sha);
      return { data: { ref: params.ref, object: { sha: params.sha } } };
    },
    async updateRef(params: { ref: string; sha: string; force?: boolean }) {
      enter("git.updateRef", params); charge();
      const name = params.ref.replace(/^heads\//, "");
      const current = refs.get(name);
      if (!current) throw gitRequestError(422, "Reference does not exist");
      if (!params.force && !isAncestor(current, params.sha)) throw gitRequestError(422, "Update is not a fast forward");
      refs.set(name, params.sha);
      return { data: { ref: `refs/heads/${name}`, object: { sha: params.sha } } };
    },
  };

  const rest = {
    git,
    repos: {
      async get(params: Record<string, unknown>) {
        enter("repos.get", params); charge();
        return { data: { name: repo, full_name: `${owner}/${repo}`, owner: { login: owner }, default_branch: defaultBranch, private: true } };
      },
    },
  };

  async function request(route: string, params: { page?: number; per_page?: number; headers?: Record<string, string> } = {}) {
    if (route !== "GET /repos/{owner}/{repo}/branches") throw gitRequestError(404, `Unexpected route ${route}`);
    enter("branches.list", { page: params.page ?? 1, headers: params.headers ?? {} });
    const etag = listEtag();
    if (params.headers?.["if-none-match"] === etag) throw gitRequestError(304, "Not modified", { ...rateHeaders(), etag });
    charge();
    const all = [...refs].sort(([left], [right]) => left.localeCompare(right)).map(([name, sha]) => ({ name, commit: { sha }, protected: false }));
    const perPage = params.per_page ?? 30;
    const page = params.page ?? 1;
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const more = all.length > page * perPage;
    return { status: 200, data: slice, headers: { ...rateHeaders(), etag, ...(more ? { link: `<https://api.github.com/repositories/1/branches?page=${page + 1}>; rel="next"` } : {}) } };
  }

  /** What `fetch` gets for the raw blobs (the clones and the pulls). */
  async function fetchBlob(input: RequestInfo | URL): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = /\/git\/blobs\/([^/?]+)/.exec(url);
    if (!match) throw new TypeError(`Unexpected request ${url}`);
    enter("blob.download", { sha: match[1] }); charge();
    const content = blobs.get(match[1]);
    if (content === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(content, { status: 200, headers: { "content-type": "application/octet-stream" } });
  }

  return {
    owner,
    repo,
    rest,
    request,
    fetch: fetchBlob,
    calls,
    rate,
    refs,
    commitOn,
    filesOf,
    head: (branch: string) => refs.get(branch),
    deleteBranch: (branch: string) => refs.delete(branch),
    createBranch: (branch: string, from = defaultBranch) => { refs.set(branch, refs.get(from)!); },
    history: (branch: string) => {
      const out: string[] = [];
      let cursor = refs.get(branch);
      while (cursor) { out.push(commits.get(cursor)!.message); cursor = commits.get(cursor)!.parents[0]; }
      return out;
    },
    count: (name: string) => calls.filter((call) => call.name === name).length,
    reset: () => { calls.length = 0; },
  };
}

export type FakeGitServer = ReturnType<typeof createFakeGitServer>;

import type {
  BookCommitRequest,
  BookPushResult,
  GitHubBookConnectionProfile,
  NarrariumBookSnapshot,
  NarrariumBookWorkspace,
  NarrariumRemoteProvider,
  NarrariumRemoteProviderCommitArgs,
  NarrariumRemoteProviderLoadArgs,
} from "./book-manager.js";
import { buildNarrariumBookSnapshot, serializeNarrariumDocument } from "./book-snapshot.js";

type FetchLike = typeof fetch;

interface GitHubRefResponse {
  ref: string;
  object: {
    sha: string;
  };
}

interface GitHubCommitResponse {
  sha: string;
  tree: {
    sha: string;
  };
}

interface GitHubTreeResponse {
  sha: string;
  truncated?: boolean;
  tree: Array<{
    path: string;
    mode: string;
    type: string;
    sha: string | null;
    size?: number;
  }>;
}

interface GitHubBlobResponse {
  sha: string;
  encoding?: string;
  content?: string;
}

interface GitHubCreateTreeResponse {
  sha: string;
}

interface GitHubCreateCommitResponse {
  sha: string;
}

interface GitHubUpdateRefResponse {
  ref: string;
  object: {
    sha: string;
  };
}

export interface GitHubRemoteProviderOptions {
  fetch?: FetchLike;
  apiBaseUrl?: string;
  userAgent?: string;
  concurrency?: number;
}

export class GitHubRemoteProvider implements NarrariumRemoteProvider {
  readonly kind = "github" as const;

  private readonly fetchImpl: FetchLike;
  private readonly apiBaseUrl: string;
  private readonly userAgent: string;
  private readonly concurrency: number;

  constructor(options: GitHubRemoteProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.userAgent = options.userAgent ?? "narrarium-core";
    this.concurrency = Math.max(1, options.concurrency ?? 8);
  }

  async loadBookSnapshot(args: NarrariumRemoteProviderLoadArgs): Promise<NarrariumBookSnapshot> {
    const profile = asGitHubProfile(args.profile);
    const ref = buildGitHubRef(profile);
    const refData = await this.requestJson<GitHubRefResponse>(profile, `/repos/${encodeURIComponent(profile.owner)}/${encodeURIComponent(profile.repository)}/git/ref/${encodeURIComponent(ref)}`);
    const commit = await this.requestJson<GitHubCommitResponse>(profile, `/repos/${encodeURIComponent(profile.owner)}/${encodeURIComponent(profile.repository)}/git/commits/${encodeURIComponent(refData.object.sha)}`);
    const tree = await this.requestJson<GitHubTreeResponse>(profile, `/repos/${encodeURIComponent(profile.owner)}/${encodeURIComponent(profile.repository)}/git/trees/${encodeURIComponent(commit.tree.sha)}?recursive=1`);

    if (tree.truncated) {
      throw new Error(`GitHub tree response was truncated for ${profile.owner}/${profile.repository} at ${profile.branch}`);
    }

    const markdownEntries = tree.tree.filter((entry) => entry.type === "blob" && typeof entry.sha === "string" && entry.path.toLowerCase().endsWith(".md"));
    const documents = await mapWithConcurrency(markdownEntries, this.concurrency, async (entry) => {
      const blob = await this.requestJson<GitHubBlobResponse>(profile, `/repos/${encodeURIComponent(profile.owner)}/${encodeURIComponent(profile.repository)}/git/blobs/${encodeURIComponent(entry.sha as string)}`);
      return {
        path: entry.path,
        rawMarkdown: decodeGitHubBlob(blob),
      };
    });

    return buildNarrariumBookSnapshot({
      profileId: profile.id,
      provider: profile.provider,
      branch: profile.branch,
      ref: normalizeFullGitHubRef(refData.ref),
      commitSha: refData.object.sha,
      loadedAt: new Date(),
      documents,
    });
  }

  async commitAndPush(args: NarrariumRemoteProviderCommitArgs): Promise<BookPushResult> {
    const profile = asGitHubProfile(args.profile);
    const workspace = args.workspace as NarrariumBookWorkspace;
    const snapshot = args.snapshot;

    if (!workspace.hasChanges()) {
      throw new Error("No workspace changes to commit.");
    }

    const ref = buildGitHubRef(profile);
    const refData = await this.requestJson<GitHubRefResponse>(profile, `/repos/${encodeURIComponent(profile.owner)}/${encodeURIComponent(profile.repository)}/git/ref/${encodeURIComponent(ref)}`);

    if (refData.object.sha !== snapshot.commitSha) {
      throw new Error(
        `GitHub branch ${profile.branch} moved from ${snapshot.commitSha} to ${refData.object.sha}. Reload the book before pushing.`,
      );
    }

    const currentCommit = await this.requestJson<GitHubCommitResponse>(profile, `/repos/${encodeURIComponent(profile.owner)}/${encodeURIComponent(profile.repository)}/git/commits/${encodeURIComponent(refData.object.sha)}`);
    const treePayload = {
      base_tree: currentCommit.tree.sha,
      tree: workspace.listChanges().map((change) => {
        if (change.kind === "delete") {
          return {
            path: change.path,
            mode: "100644",
            type: "blob",
            sha: null,
          };
        }

        const content = change.rawMarkdown ?? (change.document ? serializeNarrariumDocument(change.document) : null);
        if (typeof content !== "string") {
          throw new Error(`Missing markdown content for changed path ${change.path}`);
        }

        return {
          path: change.path,
          mode: "100644",
          type: "blob",
          content,
        };
      }),
    };

    const nextTree = await this.requestJson<GitHubCreateTreeResponse>(
      profile,
      `/repos/${encodeURIComponent(profile.owner)}/${encodeURIComponent(profile.repository)}/git/trees`,
      {
        method: "POST",
        body: JSON.stringify(treePayload),
      },
    );

    const author = buildGitHubAuthor(args.request);
    const commitPayload = {
      message: args.request.message,
      tree: nextTree.sha,
      parents: [refData.object.sha],
      ...(author ? { author, committer: author } : {}),
    };

    const nextCommit = await this.requestJson<GitHubCreateCommitResponse>(
      profile,
      `/repos/${encodeURIComponent(profile.owner)}/${encodeURIComponent(profile.repository)}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify(commitPayload),
      },
    );

    const updatedRef = await this.requestJson<GitHubUpdateRefResponse>(
      profile,
      `/repos/${encodeURIComponent(profile.owner)}/${encodeURIComponent(profile.repository)}/git/refs/${encodeURIComponent(ref)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          sha: nextCommit.sha,
          force: false,
        }),
      },
    );

    return {
      profileId: profile.id,
      provider: profile.provider,
      branch: profile.branch,
      previousCommitSha: snapshot.commitSha,
      commitSha: updatedRef.object.sha,
      pushedAt: new Date().toISOString(),
      changedPaths: workspace.listChangedPaths(),
      message: args.request.message,
    };
  }

  private async requestJson<TResponse>(
    profile: GitHubBookConnectionProfile,
    requestPath: string,
    init: RequestInit = {},
  ): Promise<TResponse> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${requestPath}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${profile.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": this.userAgent,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API request failed (${response.status} ${response.statusText}) for ${requestPath}: ${text}`);
    }

    return (await response.json()) as TResponse;
  }
}

function asGitHubProfile(profile: NarrariumRemoteProviderLoadArgs["profile"]): GitHubBookConnectionProfile {
  if (profile.provider !== "github") {
    throw new Error(`GitHubRemoteProvider cannot handle provider ${profile.provider}`);
  }

  return profile;
}

function buildGitHubRef(profile: GitHubBookConnectionProfile): string {
  const candidate = (profile.ref && profile.ref.trim()) || profile.branch;
  const withoutPrefix = candidate.replace(/^refs\//, "");
  if (withoutPrefix.startsWith("heads/")) {
    return withoutPrefix;
  }

  return `heads/${withoutPrefix.replace(/^heads\//, "")}`;
}

function normalizeFullGitHubRef(ref: string): string {
  return ref.startsWith("refs/") ? ref : `refs/${ref}`;
}

function decodeGitHubBlob(blob: GitHubBlobResponse): string {
  if (!blob.content) {
    return "";
  }

  const encoding = (blob.encoding ?? "utf-8").toLowerCase();
  if (encoding === "base64") {
    return decodeBase64(blob.content.replace(/\n/g, ""));
  }

  return blob.content;
}

function decodeBase64(value: string): string {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  return Buffer.from(value, "base64").toString("utf8");
}

function buildGitHubAuthor(request: BookCommitRequest): { name: string; email: string; date: string } | undefined {
  if (!request.authorName || !request.authorEmail) {
    return undefined;
  }

  return {
    name: request.authorName,
    email: request.authorEmail,
    date: new Date().toISOString(),
  };
}

async function mapWithConcurrency<TInput, TOutput>(
  values: TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = new Array<TOutput>(values.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) {
        return;
      }

      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

import type {
  AzureDevOpsBookConnectionProfile,
  BookCommitRequest,
  BookPushResult,
  NarrariumBookSnapshot,
  NarrariumBookWorkspace,
  NarrariumRemoteProvider,
  NarrariumRemoteProviderCommitArgs,
  NarrariumRemoteProviderLoadArgs,
} from "./book-manager.js";
import { buildNarrariumBookSnapshot, serializeNarrariumDocument } from "./book-snapshot.js";

type FetchLike = typeof fetch;

interface AzureDevOpsRefsResponse {
  count?: number;
  value?: Array<{
    name: string;
    objectId: string;
  }>;
}

interface AzureDevOpsItemsListResponse {
  count?: number;
  value?: Array<{
    path: string;
    gitObjectType?: string;
    isFolder?: boolean;
    objectId?: string;
    commitId?: string;
  }>;
}

interface AzureDevOpsItemResponse {
  path?: string;
  content?: string;
  value?: Array<{
    path?: string;
    content?: string;
  }>;
}

interface AzureDevOpsPushResponse {
  commits?: Array<{
    commitId: string;
  }>;
  refUpdates?: Array<{
    name: string;
    oldObjectId: string;
    newObjectId: string;
  }>;
  date?: string;
}

export interface AzureDevOpsRemoteProviderOptions {
  fetch?: FetchLike;
  apiBaseUrl?: string;
  apiVersion?: string;
  concurrency?: number;
}

export class AzureDevOpsRemoteProvider implements NarrariumRemoteProvider {
  readonly kind = "azure-devops" as const;

  private readonly fetchImpl: FetchLike;
  private readonly apiBaseUrl: string;
  private readonly apiVersion: string;
  private readonly concurrency: number;

  constructor(options: AzureDevOpsRemoteProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://dev.azure.com").replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? "7.1";
    this.concurrency = Math.max(1, options.concurrency ?? 8);
  }

  async loadBookSnapshot(args: NarrariumRemoteProviderLoadArgs): Promise<NarrariumBookSnapshot> {
    const profile = asAzureDevOpsProfile(args.profile);
    const refName = buildAzureDevOpsRef(profile);
    const refFilter = refName.replace(/^refs\//, "");
    const refs = await this.requestJson<AzureDevOpsRefsResponse>(
      profile,
      "/refs",
      {
        filter: refFilter,
      },
    );
    const ref = refs.value?.find((entry) => entry.name === refName);

    if (!ref) {
      throw new Error(
        `Azure DevOps branch ${profile.branch} was not found in ${profile.organization}/${profile.project}/${profile.repository}`,
      );
    }

    const items = await this.requestJson<AzureDevOpsItemsListResponse>(
      profile,
      "/items",
      {
        scopePath: "/",
        recursionLevel: "Full",
        includeContentMetadata: "true",
        "versionDescriptor.version": ref.objectId,
        "versionDescriptor.versionType": "commit",
      },
    );

    const markdownEntries = (items.value ?? []).filter(
      (entry) => !entry.isFolder && entry.gitObjectType === "blob" && typeof entry.path === "string" && entry.path.toLowerCase().endsWith(".md"),
    );

    const documents = await mapWithConcurrency(markdownEntries, this.concurrency, async (entry) => {
      const item = await this.requestJson<AzureDevOpsItemResponse>(
        profile,
        "/items",
        {
          path: entry.path,
          includeContent: "true",
          $format: "json",
          "versionDescriptor.version": ref.objectId,
          "versionDescriptor.versionType": "commit",
        },
      );

      return {
        path: normalizeAzureItemPath(entry.path),
        rawMarkdown: readAzureItemContent(item),
      };
    });

    return buildNarrariumBookSnapshot({
      profileId: profile.id,
      provider: profile.provider,
      branch: profile.branch,
      ref: ref.name,
      commitSha: ref.objectId,
      loadedAt: new Date(),
      documents,
    });
  }

  async commitAndPush(args: NarrariumRemoteProviderCommitArgs): Promise<BookPushResult> {
    const profile = asAzureDevOpsProfile(args.profile);
    const workspace = args.workspace as NarrariumBookWorkspace;
    const snapshot = args.snapshot;

    if (!workspace.hasChanges()) {
      throw new Error("No workspace changes to commit.");
    }

    const refName = buildAzureDevOpsRef(profile);
    const refFilter = refName.replace(/^refs\//, "");
    const refs = await this.requestJson<AzureDevOpsRefsResponse>(
      profile,
      "/refs",
      {
        filter: refFilter,
      },
    );
    const ref = refs.value?.find((entry) => entry.name === refName);

    if (!ref) {
      throw new Error(
        `Azure DevOps branch ${profile.branch} was not found in ${profile.organization}/${profile.project}/${profile.repository}`,
      );
    }

    if (ref.objectId !== snapshot.commitSha) {
      throw new Error(
        `Azure DevOps branch ${profile.branch} moved from ${snapshot.commitSha} to ${ref.objectId}. Reload the book before pushing.`,
      );
    }

    const author = buildAzureCommitAuthor(args.request);
    const pushBody = {
      refUpdates: [
        {
          name: refName,
          oldObjectId: ref.objectId,
        },
      ],
      commits: [
        {
          comment: args.request.message,
          ...(author ? { author, committer: author } : {}),
          changes: workspace.listChanges().map((change) => {
            if (change.kind === "delete") {
              return {
                changeType: "delete",
                item: {
                  path: toAzureServerPath(change.path),
                },
              };
            }

            const content = change.rawMarkdown ?? (change.document ? serializeNarrariumDocument(change.document) : null);
            if (typeof content !== "string") {
              throw new Error(`Missing markdown content for changed path ${change.path}`);
            }

            return {
              changeType: snapshot.documentsByPath[change.path] ? "edit" : "add",
              item: {
                path: toAzureServerPath(change.path),
              },
              newContent: {
                content,
                contentType: "rawtext",
              },
            };
          }),
        },
      ],
    };

    const push = await this.requestJson<AzureDevOpsPushResponse>(profile, "/pushes", undefined, {
      method: "POST",
      body: JSON.stringify(pushBody),
    });

    const updatedRef = push.refUpdates?.find((entry) => entry.name === refName) ?? push.refUpdates?.[0];
    const commitSha = updatedRef?.newObjectId ?? push.commits?.[0]?.commitId;

    if (!commitSha) {
      throw new Error("Azure DevOps push response did not include the new commit SHA.");
    }

    return {
      profileId: profile.id,
      provider: profile.provider,
      branch: profile.branch,
      previousCommitSha: snapshot.commitSha,
      commitSha,
      pushedAt: push.date ?? new Date().toISOString(),
      changedPaths: workspace.listChangedPaths(),
      message: args.request.message,
    };
  }

  private async requestJson<TResponse>(
    profile: AzureDevOpsBookConnectionProfile,
    endpoint: string,
    query: Record<string, string> = {},
    init: RequestInit = {},
  ): Promise<TResponse> {
    const url = buildAzureDevOpsApiUrl(this.apiBaseUrl, profile, endpoint, {
      ...query,
      "api-version": this.apiVersion,
    });
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${encodeBasicToken(profile.token)}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Azure DevOps API request failed (${response.status} ${response.statusText}) for ${endpoint}: ${text}`);
    }

    return (await response.json()) as TResponse;
  }
}

function asAzureDevOpsProfile(profile: NarrariumRemoteProviderLoadArgs["profile"]): AzureDevOpsBookConnectionProfile {
  if (profile.provider !== "azure-devops") {
    throw new Error(`AzureDevOpsRemoteProvider cannot handle provider ${profile.provider}`);
  }

  return profile;
}

function buildAzureDevOpsRef(profile: AzureDevOpsBookConnectionProfile): string {
  const candidate = (profile.ref && profile.ref.trim()) || profile.branch;
  return candidate.startsWith("refs/") ? candidate : `refs/heads/${candidate.replace(/^heads\//, "")}`;
}

function buildAzureDevOpsApiUrl(
  apiBaseUrl: string,
  profile: AzureDevOpsBookConnectionProfile,
  endpoint: string,
  query: Record<string, string>,
): string {
  const url = new URL(
    `${encodeURIComponent(profile.organization)}/${encodeURIComponent(profile.project)}/_apis/git/repositories/${encodeURIComponent(profile.repository)}${endpoint}`,
    `${apiBaseUrl}/`,
  );

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

function readAzureItemContent(response: AzureDevOpsItemResponse): string {
  if (typeof response.content === "string") {
    return response.content;
  }

  const first = response.value?.[0];
  if (typeof first?.content === "string") {
    return first.content;
  }

  return "";
}

function normalizeAzureItemPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\\/g, "/");
}

function toAzureServerPath(path: string): string {
  const normalized = normalizeAzureItemPath(path);
  return `/${normalized}`;
}

function buildAzureCommitAuthor(request: BookCommitRequest): { name: string; email: string; date: string } | undefined {
  if (!request.authorName || !request.authorEmail) {
    return undefined;
  }

  return {
    name: request.authorName,
    email: request.authorEmail,
    date: new Date().toISOString(),
  };
}

function encodeBasicToken(token: string): string {
  const value = `:${token}`;
  if (typeof btoa === "function") {
    return btoa(value);
  }

  return Buffer.from(value, "utf8").toString("base64");
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

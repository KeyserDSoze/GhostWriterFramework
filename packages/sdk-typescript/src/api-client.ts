import type { BookPushResult, NarrariumBookSnapshot } from "narrarium";

type FetchLike = typeof fetch;

export interface NarrariumApiClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  routePrefix?: string;
  getHeaders?: () => HeadersInit | Promise<HeadersInit>;
}

export interface BookConnectionProfileResponse {
  id: string;
  name: string;
  provider: "github" | "azure-devops" | string;
  branch: string;
  ref?: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  owner?: string | null;
  organization?: string | null;
  project?: string | null;
  repository: string;
  hasToken: boolean;
}

export interface BookGitStateResponse {
  profileId: string;
  provider: "github" | "azure-devops" | string;
  branch: string;
  ref?: string | null;
  commitSha: string;
  loadedAt: string;
}

export interface CreateGitHubProfileRequest {
  name: string;
  owner: string;
  repository: string;
  branch: string;
  token: string;
  ref?: string;
  isDefault?: boolean;
  id?: string;
}

export interface CreateAzureDevOpsProfileRequest {
  name: string;
  organization: string;
  project: string;
  repository: string;
  branch: string;
  token: string;
  ref?: string;
  isDefault?: boolean;
  id?: string;
}

export interface CommitBookChangeRequest {
  kind: "upsert" | "delete";
  path: string;
  rawMarkdown?: string;
}

export interface CommitBookRequest {
  baseCommitSha: string;
  message: string;
  authorName?: string;
  authorEmail?: string;
  changes: CommitBookChangeRequest[];
}

export interface NoteMutationRequest {
  baseCommitSha: string;
  message: string;
  authorName?: string;
  authorEmail?: string;
  frontmatterPatch?: Record<string, unknown>;
  body?: string;
  appendBody?: string;
}

export interface SaveWorkItemRequest {
  baseCommitSha: string;
  message: string;
  authorName?: string;
  authorEmail?: string;
  bucket: "ideas" | "notes";
  entryId?: string;
  title: string;
  body: string;
  tags?: string[];
  status?: "active" | "review" | "resolved" | "rejected";
}

export interface PromoteWorkItemRequest {
  baseCommitSha: string;
  message: string;
  authorName?: string;
  authorEmail?: string;
  source: "ideas" | "notes";
  entryId: string;
  promotedTo: string;
  target?: "notes" | "story-design";
}

export class NarrariumApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly routePrefix: string;
  private readonly getHeaders: () => HeadersInit | Promise<HeadersInit>;

  constructor(options: NarrariumApiClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.routePrefix = normalizeRoutePrefix(options.routePrefix ?? "/api/narrarium");
    this.getHeaders = options.getHeaders ?? (() => ({}));
  }

  listProfiles(): Promise<BookConnectionProfileResponse[]> {
    return this.requestJson<BookConnectionProfileResponse[]>("GET", "/profiles");
  }

  getDefaultProfile(): Promise<BookConnectionProfileResponse | null> {
    return this.requestJsonOrNull<BookConnectionProfileResponse>("GET", "/profiles/default");
  }

  getProfile(profileId: string): Promise<BookConnectionProfileResponse | null> {
    return this.requestJsonOrNull<BookConnectionProfileResponse>("GET", `/profiles/${encodeURIComponent(profileId)}`);
  }

  createGitHubProfile(request: CreateGitHubProfileRequest): Promise<BookConnectionProfileResponse> {
    return this.requestJson<BookConnectionProfileResponse>("POST", "/profiles/github", request);
  }

  createAzureDevOpsProfile(request: CreateAzureDevOpsProfileRequest): Promise<BookConnectionProfileResponse> {
    return this.requestJson<BookConnectionProfileResponse>("POST", "/profiles/azure-devops", request);
  }

  async deleteProfile(profileId: string): Promise<boolean> {
    const response = await this.send("DELETE", `/profiles/${encodeURIComponent(profileId)}`);
    if (response.status === 404) {
      return false;
    }

    if (response.status === 204) {
      return true;
    }

    return throwApiError(response, "DELETE", this.buildUrl(`/profiles/${encodeURIComponent(profileId)}`));
  }

  setDefaultProfile(profileId: string): Promise<BookConnectionProfileResponse | null> {
    return this.requestJsonOrNull<BookConnectionProfileResponse>("POST", `/profiles/${encodeURIComponent(profileId)}/set-default`);
  }

  loadBook(profileId: string): Promise<NarrariumBookSnapshot | null> {
    return this.requestJsonOrNull<NarrariumBookSnapshot>("GET", `/profiles/${encodeURIComponent(profileId)}/book`);
  }

  getGitState(profileId: string): Promise<BookGitStateResponse | null> {
    return this.requestJsonOrNull<BookGitStateResponse>("GET", `/profiles/${encodeURIComponent(profileId)}/git`);
  }

  commit(profileId: string, request: CommitBookRequest): Promise<BookPushResult> {
    return this.requestJson<BookPushResult>("POST", `/profiles/${encodeURIComponent(profileId)}/commit`, request);
  }

  saveBookItem(profileId: string, request: SaveWorkItemRequest): Promise<BookPushResult> {
    return this.requestJson<BookPushResult>("POST", `/profiles/${encodeURIComponent(profileId)}/items`, request);
  }

  saveChapterItem(profileId: string, chapter: string, request: SaveWorkItemRequest): Promise<BookPushResult> {
    return this.requestJson<BookPushResult>(
      "POST",
      `/profiles/${encodeURIComponent(profileId)}/chapters/${encodeURIComponent(chapter)}/items`,
      request,
    );
  }

  promoteBookItem(profileId: string, request: PromoteWorkItemRequest): Promise<BookPushResult> {
    return this.requestJson<BookPushResult>("POST", `/profiles/${encodeURIComponent(profileId)}/items/promote`, request);
  }

  promoteChapterItem(profileId: string, chapter: string, request: PromoteWorkItemRequest): Promise<BookPushResult> {
    return this.requestJson<BookPushResult>(
      "POST",
      `/profiles/${encodeURIComponent(profileId)}/chapters/${encodeURIComponent(chapter)}/items/promote`,
      request,
    );
  }

  updateBookNotes(profileId: string, request: NoteMutationRequest): Promise<BookPushResult> {
    return this.requestJson<BookPushResult>("POST", `/profiles/${encodeURIComponent(profileId)}/notes`, request);
  }

  updateStoryDesign(profileId: string, request: NoteMutationRequest): Promise<BookPushResult> {
    return this.requestJson<BookPushResult>("POST", `/profiles/${encodeURIComponent(profileId)}/story-design`, request);
  }

  updateChapterNotes(profileId: string, chapter: string, request: NoteMutationRequest): Promise<BookPushResult> {
    return this.requestJson<BookPushResult>(
      "POST",
      `/profiles/${encodeURIComponent(profileId)}/chapters/${encodeURIComponent(chapter)}/notes`,
      request,
    );
  }

  private async requestJson<TResponse>(method: string, path: string, body?: unknown): Promise<TResponse> {
    const response = await this.send(method, path, body);
    if (!response.ok) {
      return throwApiError(response, method, this.buildUrl(path));
    }

    return (await response.json()) as TResponse;
  }

  private async requestJsonOrNull<TResponse>(method: string, path: string, body?: unknown): Promise<TResponse | null> {
    const response = await this.send(method, path, body);
    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      return throwApiError(response, method, this.buildUrl(path));
    }

    return (await response.json()) as TResponse;
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers = new Headers(await this.getHeaders());
    headers.set("Accept", "application/json");
    const init: RequestInit = {
      method,
      headers,
    };

    if (typeof body !== "undefined") {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(body);
    }

    return this.fetchImpl(this.buildUrl(path), init);
  }

  private buildUrl(path: string): string {
    return `${this.baseUrl}${this.routePrefix}${path.startsWith("/") ? path : `/${path}`}`;
  }
}

async function throwApiError(response: Response, method: string, url: string): Promise<never> {
  const text = await response.text();
  throw new Error(`Narrarium API request failed (${response.status} ${response.statusText}) for ${method} ${url}: ${text}`);
}

function normalizeRoutePrefix(value: string): string {
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.replace(/\/$/, "");
}

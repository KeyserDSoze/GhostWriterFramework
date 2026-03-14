import type {
  AssetFrontmatter,
  BookFrontmatter,
  ChapterDraftFrontmatter,
  ChapterFrontmatter,
  CharacterFrontmatter,
  FactionFrontmatter,
  GuidelineFrontmatter,
  ItemFrontmatter,
  LocationFrontmatter,
  ParagraphDraftFrontmatter,
  ParagraphFrontmatter,
  PlotFrontmatter,
  ResearchNoteFrontmatter,
  SecretFrontmatter,
  TimelineEventFrontmatter,
} from "./schemas.js";

export type BookProviderKind = "github" | "azure-devops";

export interface StringKeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BaseBookConnectionProfile {
  id: string;
  name: string;
  provider: BookProviderKind;
  branch: string;
  ref?: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubBookConnectionProfile extends BaseBookConnectionProfile {
  provider: "github";
  owner: string;
  repository: string;
  token: string;
}

export interface AzureDevOpsBookConnectionProfile extends BaseBookConnectionProfile {
  provider: "azure-devops";
  organization: string;
  project: string;
  repository: string;
  token: string;
}

export type BookConnectionProfile = GitHubBookConnectionProfile | AzureDevOpsBookConnectionProfile;

export interface CreateGitHubBookConnectionProfileInput {
  id?: string;
  name: string;
  owner: string;
  repository: string;
  branch: string;
  token: string;
  ref?: string;
  isDefault?: boolean;
}

export interface CreateAzureDevOpsBookConnectionProfileInput {
  id?: string;
  name: string;
  organization: string;
  project: string;
  repository: string;
  branch: string;
  token: string;
  ref?: string;
  isDefault?: boolean;
}

export type NarrariumDocumentKind =
  | "book"
  | "plot"
  | "context"
  | "guideline"
  | "character"
  | "item"
  | "location"
  | "faction"
  | "secret"
  | "timeline-main"
  | "timeline-event"
  | "chapter"
  | "paragraph"
  | "chapter-draft"
  | "paragraph-draft"
  | "resume"
  | "evaluation"
  | "state"
  | "research-note"
  | "asset"
  | "unknown";

type LooseFrontmatter = Record<string, unknown>;

export type NarrariumKnownFrontmatter =
  | BookFrontmatter
  | PlotFrontmatter
  | GuidelineFrontmatter
  | CharacterFrontmatter
  | ItemFrontmatter
  | LocationFrontmatter
  | FactionFrontmatter
  | SecretFrontmatter
  | TimelineEventFrontmatter
  | AssetFrontmatter
  | ChapterFrontmatter
  | ChapterDraftFrontmatter
  | ParagraphFrontmatter
  | ParagraphDraftFrontmatter
  | ResearchNoteFrontmatter
  | LooseFrontmatter;

export interface NarrariumDocument<TFrontmatter = NarrariumKnownFrontmatter> {
  kind: NarrariumDocumentKind;
  path: string;
  frontmatter: TFrontmatter;
  body: string;
  rawMarkdown?: string;
}

export type NarrariumAnyDocument = NarrariumDocument<NarrariumKnownFrontmatter>;

export interface NarrariumChapterSnapshot {
  slug: string;
  chapter: NarrariumDocument<ChapterFrontmatter>;
  paragraphs: Array<NarrariumDocument<ParagraphFrontmatter>>;
}

export interface NarrariumDraftChapterSnapshot {
  slug: string;
  chapter: NarrariumDocument<ChapterDraftFrontmatter>;
  paragraphs: Array<NarrariumDocument<ParagraphDraftFrontmatter>>;
}

export interface NarrariumBookSnapshot {
  profileId: string;
  provider: BookProviderKind;
  branch: string;
  ref: string | null;
  commitSha: string;
  loadedAt: string;
  book: NarrariumDocument<BookFrontmatter> | null;
  plot: NarrariumDocument<PlotFrontmatter> | null;
  context: NarrariumDocument<LooseFrontmatter> | null;
  guidelines: Array<NarrariumDocument<GuidelineFrontmatter>>;
  characters: Array<NarrariumDocument<CharacterFrontmatter>>;
  items: Array<NarrariumDocument<ItemFrontmatter>>;
  locations: Array<NarrariumDocument<LocationFrontmatter>>;
  factions: Array<NarrariumDocument<FactionFrontmatter>>;
  secrets: Array<NarrariumDocument<SecretFrontmatter>>;
  timelineMain: NarrariumDocument<LooseFrontmatter> | null;
  timelineEvents: Array<NarrariumDocument<TimelineEventFrontmatter>>;
  chapters: Array<NarrariumChapterSnapshot>;
  draftChapters: Array<NarrariumDraftChapterSnapshot>;
  resumes: Array<NarrariumDocument<LooseFrontmatter>>;
  stateDocuments: Array<NarrariumDocument<LooseFrontmatter>>;
  evaluations: Array<NarrariumDocument<LooseFrontmatter>>;
  researchNotes: Array<NarrariumDocument<ResearchNoteFrontmatter>>;
  assets: Array<NarrariumDocument<AssetFrontmatter>>;
  otherDocuments: Array<NarrariumDocument<LooseFrontmatter>>;
  documentsByPath: Record<string, NarrariumAnyDocument>;
  chaptersBySlug: Record<string, NarrariumChapterSnapshot>;
  paragraphsById: Record<string, NarrariumDocument<ParagraphFrontmatter>>;
}

export interface CreateEmptyBookSnapshotInput {
  profileId: string;
  provider: BookProviderKind;
  branch: string;
  commitSha: string;
  ref?: string | null;
  loadedAt?: string | Date;
}

export function createEmptyBookSnapshot(input: CreateEmptyBookSnapshotInput): NarrariumBookSnapshot {
  return {
    profileId: input.profileId,
    provider: input.provider,
    branch: input.branch,
    ref: input.ref ?? null,
    commitSha: input.commitSha,
    loadedAt: toIsoString(input.loadedAt ?? new Date()),
    book: null,
    plot: null,
    context: null,
    guidelines: [],
    characters: [],
    items: [],
    locations: [],
    factions: [],
    secrets: [],
    timelineMain: null,
    timelineEvents: [],
    chapters: [],
    draftChapters: [],
    resumes: [],
    stateDocuments: [],
    evaluations: [],
    researchNotes: [],
    assets: [],
    otherDocuments: [],
    documentsByPath: {},
    chaptersBySlug: {},
    paragraphsById: {},
  };
}

export interface NarrariumWorkspaceUpsertChange {
  kind: "upsert";
  path: string;
  document?: NarrariumAnyDocument;
  rawMarkdown?: string;
}

export interface NarrariumWorkspaceDeleteChange {
  kind: "delete";
  path: string;
}

export type NarrariumWorkspaceChange = NarrariumWorkspaceUpsertChange | NarrariumWorkspaceDeleteChange;

export interface NarrariumDocumentPatch<TFrontmatter> {
  frontmatter?: Partial<TFrontmatter>;
  body?: string;
  rawMarkdown?: string;
}

export interface CharacterDocumentInput {
  slug: string;
  frontmatter: CharacterFrontmatter;
  body: string;
  rawMarkdown?: string;
}

export interface ChapterDocumentInput {
  slug: string;
  frontmatter: ChapterFrontmatter;
  body: string;
  rawMarkdown?: string;
}

export interface ParagraphDocumentInput {
  chapterSlug: string;
  slug: string;
  frontmatter: ParagraphFrontmatter;
  body: string;
  rawMarkdown?: string;
}

export interface CharacterDocumentLocator {
  slug?: string;
  id?: string;
}

export interface ChapterDocumentLocator {
  slug?: string;
  id?: string;
}

export interface ParagraphDocumentLocator {
  chapterSlug?: string;
  slug?: string;
  id?: string;
}

export class NarrariumBookWorkspace {
  readonly snapshot: NarrariumBookSnapshot;
  readonly createdAt: string;
  private readonly changesByPath = new Map<string, NarrariumWorkspaceChange>();

  constructor(snapshot: NarrariumBookSnapshot, createdAt: string | Date = new Date()) {
    this.snapshot = snapshot;
    this.createdAt = toIsoString(createdAt);
  }

  upsertDocument(document: NarrariumAnyDocument, options?: { rawMarkdown?: string }): this {
    const path = normalizeDocumentPath(document.path);
    this.changesByPath.set(path, {
      kind: "upsert",
      path,
      document: {
        ...document,
        path,
      },
      rawMarkdown: options?.rawMarkdown,
    });
    return this;
  }

  upsertCharacter(input: CharacterDocumentInput): this {
    return this.upsertDocument(
      buildNarrariumDocument("character", characterDocumentPath(input.slug), input.frontmatter, input.body),
      { rawMarkdown: input.rawMarkdown },
    );
  }

  updateCharacter(locator: string | CharacterDocumentLocator, patch: NarrariumDocumentPatch<CharacterFrontmatter>): this {
    const path = resolveCharacterPath(locator);
    const current = this.requireTypedDocument<CharacterFrontmatter>(path, "character");
    return this.upsertDocument(
      {
        ...current,
        frontmatter: {
          ...current.frontmatter,
          ...(patch.frontmatter ?? {}),
        },
        body: patch.body ?? current.body,
      },
      { rawMarkdown: patch.rawMarkdown },
    );
  }

  upsertChapter(input: ChapterDocumentInput): this {
    return this.upsertDocument(
      buildNarrariumDocument("chapter", chapterDocumentPath(input.slug), input.frontmatter, input.body),
      { rawMarkdown: input.rawMarkdown },
    );
  }

  updateChapter(locator: string | ChapterDocumentLocator, patch: NarrariumDocumentPatch<ChapterFrontmatter>): this {
    const path = resolveChapterPath(locator);
    const current = this.requireTypedDocument<ChapterFrontmatter>(path, "chapter");
    return this.upsertDocument(
      {
        ...current,
        frontmatter: {
          ...current.frontmatter,
          ...(patch.frontmatter ?? {}),
        },
        body: patch.body ?? current.body,
      },
      { rawMarkdown: patch.rawMarkdown },
    );
  }

  upsertParagraph(input: ParagraphDocumentInput): this {
    return this.upsertDocument(
      buildNarrariumDocument(
        "paragraph",
        paragraphDocumentPath(input.chapterSlug, input.slug),
        input.frontmatter,
        input.body,
      ),
      { rawMarkdown: input.rawMarkdown },
    );
  }

  updateParagraph(locator: string | ParagraphDocumentLocator, patch: NarrariumDocumentPatch<ParagraphFrontmatter>): this {
    const path = resolveParagraphPath(locator);
    const current = this.requireTypedDocument<ParagraphFrontmatter>(path, "paragraph");
    return this.upsertDocument(
      {
        ...current,
        frontmatter: {
          ...current.frontmatter,
          ...(patch.frontmatter ?? {}),
        },
        body: patch.body ?? current.body,
      },
      { rawMarkdown: patch.rawMarkdown },
    );
  }

  upsertMarkdown(path: string, rawMarkdown: string): this {
    const normalizedPath = normalizeDocumentPath(path);
    this.changesByPath.set(normalizedPath, {
      kind: "upsert",
      path: normalizedPath,
      rawMarkdown,
    });
    return this;
  }

  deleteDocument(path: string): this {
    const normalizedPath = normalizeDocumentPath(path);
    this.changesByPath.set(normalizedPath, {
      kind: "delete",
      path: normalizedPath,
    });
    return this;
  }

  getChange(path: string): NarrariumWorkspaceChange | null {
    return this.changesByPath.get(normalizeDocumentPath(path)) ?? null;
  }

  listChanges(): NarrariumWorkspaceChange[] {
    return Array.from(this.changesByPath.values()).sort((left, right) => left.path.localeCompare(right.path));
  }

  listChangedPaths(): string[] {
    return this.listChanges().map((change) => change.path);
  }

  hasChanges(): boolean {
    return this.changesByPath.size > 0;
  }

  clearChanges(): void {
    this.changesByPath.clear();
  }

  private requireTypedDocument<TFrontmatter>(path: string, expectedKind: NarrariumDocumentKind): NarrariumDocument<TFrontmatter> {
    const normalizedPath = normalizeDocumentPath(path);
    const change = this.changesByPath.get(normalizedPath);

    if (change?.kind === "delete") {
      throw new Error(`Cannot update ${normalizedPath} because it is already marked for deletion in the workspace.`);
    }

    if (change?.kind === "upsert") {
      if (!change.document) {
        throw new Error(
          `Cannot apply a typed update to ${normalizedPath} because the workspace currently stores raw markdown for that path.`,
        );
      }

      if (change.document.kind !== expectedKind) {
        throw new Error(`Expected ${expectedKind} document at ${normalizedPath} but found ${change.document.kind}.`);
      }

      return change.document as NarrariumDocument<TFrontmatter>;
    }

    const current = this.snapshot.documentsByPath[normalizedPath];
    if (!current) {
      throw new Error(`Narrarium document not found at ${normalizedPath}.`);
    }

    if (current.kind !== expectedKind) {
      throw new Error(`Expected ${expectedKind} document at ${normalizedPath} but found ${current.kind}.`);
    }

    return current as NarrariumDocument<TFrontmatter>;
  }
}

export interface BookCommitRequest {
  message: string;
  authorName?: string;
  authorEmail?: string;
}

export interface BookPushResult {
  profileId: string;
  provider: BookProviderKind;
  branch: string;
  previousCommitSha: string;
  commitSha: string;
  pushedAt: string;
  changedPaths: string[];
  message: string;
}

export interface NarrariumRemoteProviderLoadArgs {
  profile: BookConnectionProfile;
}

export interface NarrariumRemoteProviderCommitArgs {
  profile: BookConnectionProfile;
  snapshot: NarrariumBookSnapshot;
  workspace: NarrariumBookWorkspace;
  request: BookCommitRequest;
}

export interface NarrariumRemoteProvider {
  readonly kind: BookProviderKind;
  loadBookSnapshot(args: NarrariumRemoteProviderLoadArgs): Promise<NarrariumBookSnapshot>;
  commitAndPush(args: NarrariumRemoteProviderCommitArgs): Promise<BookPushResult>;
}

export interface BookConnectionProfileStore {
  listProfiles(): Promise<BookConnectionProfile[]>;
  getProfile(id: string): Promise<BookConnectionProfile | null>;
  saveProfile(profile: BookConnectionProfile): Promise<BookConnectionProfile>;
  deleteProfile(id: string): Promise<boolean>;
}

export class InMemoryBookProfileStore implements BookConnectionProfileStore {
  private readonly profiles = new Map<string, BookConnectionProfile>();

  async listProfiles(): Promise<BookConnectionProfile[]> {
    return sortProfiles(Array.from(this.profiles.values()).map(cloneProfile));
  }

  async getProfile(id: string): Promise<BookConnectionProfile | null> {
    return this.profiles.has(id) ? cloneProfile(this.profiles.get(id) as BookConnectionProfile) : null;
  }

  async saveProfile(profile: BookConnectionProfile): Promise<BookConnectionProfile> {
    const cloned = cloneProfile(profile);
    this.profiles.set(cloned.id, cloned);
    return cloneProfile(cloned);
  }

  async deleteProfile(id: string): Promise<boolean> {
    return this.profiles.delete(id);
  }
}

export interface LocalStorageBookProfileStoreOptions {
  storage?: StringKeyValueStore;
  storageKey?: string;
}

export class LocalStorageBookProfileStore implements BookConnectionProfileStore {
  private readonly storage: StringKeyValueStore;
  private readonly storageKey: string;

  constructor(options: LocalStorageBookProfileStoreOptions = {}) {
    this.storage = options.storage ?? getGlobalLocalStorage();
    this.storageKey = options.storageKey ?? "narrarium.book.profiles";
  }

  async listProfiles(): Promise<BookConnectionProfile[]> {
    return sortProfiles(this.readProfiles());
  }

  async getProfile(id: string): Promise<BookConnectionProfile | null> {
    return this.readProfiles().find((profile) => profile.id === id) ?? null;
  }

  async saveProfile(profile: BookConnectionProfile): Promise<BookConnectionProfile> {
    const profiles = this.readProfiles();
    const next = cloneProfile(profile);
    const index = profiles.findIndex((entry) => entry.id === next.id);

    if (index >= 0) {
      profiles[index] = next;
    } else {
      profiles.push(next);
    }

    this.writeProfiles(profiles);
    return cloneProfile(next);
  }

  async deleteProfile(id: string): Promise<boolean> {
    const profiles = this.readProfiles();
    const filtered = profiles.filter((profile) => profile.id !== id);

    if (filtered.length === profiles.length) {
      return false;
    }

    this.writeProfiles(filtered);
    return true;
  }

  private readProfiles(): BookConnectionProfile[] {
    const raw = this.storage.getItem(this.storageKey);

    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return sortProfiles(parsed.filter(isBookConnectionProfile).map(cloneProfile));
    } catch {
      return [];
    }
  }

  private writeProfiles(profiles: BookConnectionProfile[]): void {
    this.storage.setItem(this.storageKey, JSON.stringify(sortProfiles(profiles.map(cloneProfile))));
  }
}

export interface BookManagerOptions {
  profileStore?: BookConnectionProfileStore;
  providers?: NarrariumRemoteProvider[];
  now?: () => Date;
}

export class BookManager {
  private readonly profileStore: BookConnectionProfileStore;
  private readonly providers = new Map<BookProviderKind, NarrariumRemoteProvider>();
  private readonly now: () => Date;

  constructor(options: BookManagerOptions = {}) {
    this.profileStore = options.profileStore ?? new InMemoryBookProfileStore();
    this.now = options.now ?? (() => new Date());

    for (const provider of options.providers ?? []) {
      this.registerProvider(provider);
    }
  }

  registerProvider(provider: NarrariumRemoteProvider): this {
    this.providers.set(provider.kind, provider);
    return this;
  }

  async listProfiles(): Promise<BookConnectionProfile[]> {
    return this.profileStore.listProfiles();
  }

  async getProfile(id: string): Promise<BookConnectionProfile | null> {
    return this.profileStore.getProfile(id);
  }

  async getDefaultProfile(): Promise<BookConnectionProfile | null> {
    const profiles = await this.profileStore.listProfiles();
    return profiles.find((profile) => profile.isDefault) ?? null;
  }

  async createGitHubProfile(input: CreateGitHubBookConnectionProfileInput): Promise<GitHubBookConnectionProfile> {
    const profiles = await this.profileStore.listProfiles();
    const timestamp = toIsoString(this.now());
    const profile: GitHubBookConnectionProfile = {
      id: input.id ?? buildProfileId("github"),
      name: input.name,
      provider: "github",
      owner: input.owner,
      repository: input.repository,
      branch: input.branch,
      ref: input.ref,
      token: input.token,
      isDefault: input.isDefault ?? profiles.length === 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return this.persistProfile(profile) as Promise<GitHubBookConnectionProfile>;
  }

  async createAzureDevOpsProfile(
    input: CreateAzureDevOpsBookConnectionProfileInput,
  ): Promise<AzureDevOpsBookConnectionProfile> {
    const profiles = await this.profileStore.listProfiles();
    const timestamp = toIsoString(this.now());
    const profile: AzureDevOpsBookConnectionProfile = {
      id: input.id ?? buildProfileId("azure-devops"),
      name: input.name,
      provider: "azure-devops",
      organization: input.organization,
      project: input.project,
      repository: input.repository,
      branch: input.branch,
      ref: input.ref,
      token: input.token,
      isDefault: input.isDefault ?? profiles.length === 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return this.persistProfile(profile) as Promise<AzureDevOpsBookConnectionProfile>;
  }

  async saveProfile(profile: BookConnectionProfile): Promise<BookConnectionProfile> {
    const existing = await this.profileStore.getProfile(profile.id);
    const next: BookConnectionProfile = {
      ...cloneProfile(profile),
      createdAt: existing?.createdAt ?? profile.createdAt ?? toIsoString(this.now()),
      updatedAt: toIsoString(this.now()),
    };

    return this.persistProfile(next);
  }

  async deleteProfile(id: string): Promise<boolean> {
    const deleted = await this.profileStore.deleteProfile(id);
    if (!deleted) {
      return false;
    }

    const profiles = await this.profileStore.listProfiles();
    if (profiles.length > 0 && !profiles.some((profile) => profile.isDefault)) {
      const firstProfile = { ...profiles[0], isDefault: true, updatedAt: toIsoString(this.now()) };
      await this.profileStore.saveProfile(firstProfile);
    }

    return true;
  }

  async setDefaultProfile(id: string): Promise<BookConnectionProfile> {
    const profiles = await this.profileStore.listProfiles();
    const target = profiles.find((profile) => profile.id === id);
    if (!target) {
      throw new Error(`Book connection profile not found: ${id}`);
    }

    const timestamp = toIsoString(this.now());
    for (const profile of profiles) {
      if (profile.isDefault === (profile.id === id)) {
        continue;
      }

      await this.profileStore.saveProfile({
        ...profile,
        isDefault: profile.id === id,
        updatedAt: timestamp,
      });
    }

    return (await this.profileStore.getProfile(id)) as BookConnectionProfile;
  }

  beginWorkspace(snapshot: NarrariumBookSnapshot): NarrariumBookWorkspace {
    return new NarrariumBookWorkspace(snapshot, this.now());
  }

  async loadBook(profileOrId: string | BookConnectionProfile): Promise<NarrariumBookSnapshot> {
    const profile = await this.resolveProfile(profileOrId);
    const provider = this.resolveProvider(profile.provider);
    return provider.loadBookSnapshot({ profile });
  }

  async commitAndPush(
    profileOrId: string | BookConnectionProfile,
    snapshot: NarrariumBookSnapshot,
    workspace: NarrariumBookWorkspace,
    request: BookCommitRequest,
  ): Promise<BookPushResult> {
    const profile = await this.resolveProfile(profileOrId);
    const provider = this.resolveProvider(profile.provider);
    return provider.commitAndPush({
      profile,
      snapshot,
      workspace,
      request,
    });
  }

  private async persistProfile(profile: BookConnectionProfile): Promise<BookConnectionProfile> {
    const saved = await this.profileStore.saveProfile(cloneProfile(profile));
    if (!saved.isDefault) {
      return saved;
    }

    const profiles = await this.profileStore.listProfiles();
    const demotions = profiles.filter((entry) => entry.id !== saved.id && entry.isDefault);
    for (const entry of demotions) {
      await this.profileStore.saveProfile({
        ...entry,
        isDefault: false,
        updatedAt: saved.updatedAt,
      });
    }

    return saved;
  }

  private async resolveProfile(profileOrId: string | BookConnectionProfile): Promise<BookConnectionProfile> {
    if (typeof profileOrId !== "string") {
      return cloneProfile(profileOrId);
    }

    const profile = await this.profileStore.getProfile(profileOrId);
    if (!profile) {
      throw new Error(`Book connection profile not found: ${profileOrId}`);
    }

    return profile;
  }

  private resolveProvider(kind: BookProviderKind): NarrariumRemoteProvider {
    const provider = this.providers.get(kind);
    if (!provider) {
      throw new Error(`Narrarium remote provider is not registered for ${kind}`);
    }

    return provider;
  }
}

function buildProfileId(provider: BookProviderKind): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${provider}-${stamp}-${random}`;
}

function cloneProfile<T extends BookConnectionProfile>(profile: T): T {
  return {
    ...profile,
  };
}

function sortProfiles(profiles: BookConnectionProfile[]): BookConnectionProfile[] {
  return [...profiles].sort((left, right) => {
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }

    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}

function isBookConnectionProfile(value: unknown): value is BookConnectionProfile {
  if (!value || typeof value !== "object") {
    return false;
  }

  const profile = value as Partial<BookConnectionProfile>;
  if (
    typeof profile.id !== "string" ||
    typeof profile.name !== "string" ||
    typeof profile.branch !== "string" ||
    typeof profile.createdAt !== "string" ||
    typeof profile.updatedAt !== "string" ||
    typeof profile.isDefault !== "boolean"
  ) {
    return false;
  }

  if (profile.provider === "github") {
    return typeof (profile as Partial<GitHubBookConnectionProfile>).owner === "string" && typeof profile.repository === "string" && typeof profile.token === "string";
  }

  if (profile.provider === "azure-devops") {
    const azure = profile as Partial<AzureDevOpsBookConnectionProfile>;
    return (
      typeof azure.organization === "string" &&
      typeof azure.project === "string" &&
      typeof azure.repository === "string" &&
      typeof azure.token === "string"
    );
  }

  return false;
}

function getGlobalLocalStorage(): StringKeyValueStore {
  const candidate = (globalThis as { localStorage?: unknown }).localStorage;
  if (!isStringKeyValueStore(candidate)) {
    throw new Error("LocalStorageBookProfileStore requires a Storage-like implementation.");
  }

  return candidate;
}

function isStringKeyValueStore(value: unknown): value is StringKeyValueStore {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as StringKeyValueStore).getItem === "function" &&
      typeof (value as StringKeyValueStore).setItem === "function" &&
      typeof (value as StringKeyValueStore).removeItem === "function",
  );
}

function normalizeDocumentPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function buildNarrariumDocument<TFrontmatter>(
  kind: NarrariumDocumentKind,
  path: string,
  frontmatter: TFrontmatter,
  body: string,
): NarrariumDocument<TFrontmatter> {
  return {
    kind,
    path: normalizeDocumentPath(path),
    frontmatter,
    body,
  };
}

function characterDocumentPath(slug: string): string {
  return `characters/${normalizeSlug(slug)}.md`;
}

function chapterDocumentPath(slug: string): string {
  return `chapters/${normalizeSlug(slug)}/chapter.md`;
}

function paragraphDocumentPath(chapterSlug: string, paragraphSlug: string): string {
  return `chapters/${normalizeSlug(chapterSlug)}/${normalizeSlug(paragraphSlug)}.md`;
}

function resolveCharacterPath(locator: string | CharacterDocumentLocator): string {
  const normalized = normalizeCharacterLocator(locator);
  if (normalized.slug) {
    return characterDocumentPath(normalized.slug);
  }

  if (normalized.id) {
    return characterDocumentPath(extractEntitySlug(normalized.id, "character:"));
  }

  throw new Error("Character locator must include a slug or character id.");
}

function resolveChapterPath(locator: string | ChapterDocumentLocator): string {
  const normalized = normalizeChapterLocator(locator);
  if (normalized.slug) {
    return chapterDocumentPath(normalized.slug);
  }

  if (normalized.id) {
    return chapterDocumentPath(extractEntitySlug(normalized.id, "chapter:"));
  }

  throw new Error("Chapter locator must include a slug or chapter id.");
}

function resolveParagraphPath(locator: string | ParagraphDocumentLocator): string {
  const normalized = normalizeParagraphLocator(locator);
  if (normalized.chapterSlug && normalized.slug) {
    return paragraphDocumentPath(normalized.chapterSlug, normalized.slug);
  }

  if (normalized.id) {
    const parsed = extractParagraphParts(normalized.id);
    return paragraphDocumentPath(parsed.chapterSlug, parsed.slug);
  }

  throw new Error("Paragraph locator must include an id, or both chapterSlug and slug.");
}

function normalizeCharacterLocator(locator: string | CharacterDocumentLocator): CharacterDocumentLocator {
  if (typeof locator !== "string") {
    return locator;
  }

  return locator.startsWith("character:") ? { id: locator } : { slug: locator };
}

function normalizeChapterLocator(locator: string | ChapterDocumentLocator): ChapterDocumentLocator {
  if (typeof locator !== "string") {
    return locator;
  }

  return locator.startsWith("chapter:") ? { id: locator } : { slug: locator };
}

function normalizeParagraphLocator(locator: string | ParagraphDocumentLocator): ParagraphDocumentLocator {
  if (typeof locator !== "string") {
    return locator;
  }

  return { id: locator };
}

function extractEntitySlug(value: string, prefix: string): string {
  if (!value.startsWith(prefix)) {
    throw new Error(`Expected id starting with ${prefix} but received ${value}`);
  }

  return normalizeSlug(value.slice(prefix.length));
}

function extractParagraphParts(value: string): { chapterSlug: string; slug: string } {
  const remainder = value.startsWith("paragraph:") ? value.slice("paragraph:".length) : value;
  const separatorIndex = remainder.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex === remainder.length - 1) {
    throw new Error(`Expected paragraph id in the form paragraph:<chapter-slug>:<paragraph-slug> but received ${value}`);
  }

  return {
    chapterSlug: normalizeSlug(remainder.slice(0, separatorIndex)),
    slug: normalizeSlug(remainder.slice(separatorIndex + 1)),
  };
}

function normalizeSlug(value: string): string {
  return normalizeDocumentPath(value).replace(/^\/+/, "").replace(/\.md$/i, "");
}

function toIsoString(value: string | Date): string {
  return typeof value === "string" ? value : value.toISOString();
}

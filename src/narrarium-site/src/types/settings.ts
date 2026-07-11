// ─── Azure OpenAI ────────────────────────────────────────────────────────────

export interface AzureOpenAIConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  apiVersion: string;
}

export type AIProviderType = "azure_openai" | "openai" | "m365_copilot" | "github_models";

/**
 * Roles a chat model can fulfil. A task picks the model tagged with its capability,
 * falling back to the model tagged "default".
 * - default: universal fallback for any chat task
 * - copilot: the interactive assistant / live voice conversation
 * - simple-tasks: cheap micro-decisions (yes/no confirmation, tiny classifications)
 * - review: evaluations and editorial scoring
 */
export type ChatCapability = "default" | "copilot" | "simple-tasks" | "review" | "chat-resume" | "reader-evaluation" | "reader-evaluation-summary" | "deep-research" | "create-from-research" | "audit";

export const CHAT_CAPABILITIES: ChatCapability[] = ["default", "copilot", "simple-tasks", "review", "chat-resume", "reader-evaluation", "reader-evaluation-summary", "deep-research", "create-from-research", "audit"];

/** Task kinds the configurable router can target: the 4 chat capabilities plus media tasks. */
export type RoutingTaskKind = ChatCapability | "tts" | "stt" | "image";

export const ROUTING_TASKS: RoutingTaskKind[] = ["default", "copilot", "simple-tasks", "review", "chat-resume", "reader-evaluation", "reader-evaluation-summary", "deep-research", "create-from-research", "audit", "tts", "stt", "image"];

/** A concrete integration+model target the router points a task at. */
export interface RoutingTarget {
  /** References AIIntegration.id */
  integrationId: string;
  /** Chat: ChatModel.name. Media: the integration's tts/stt/image model string. */
  model: string;
}

/** Primary target + ordered fallbacks tried when the primary errors (e.g. 429/network). */
export interface TaskRoute {
  primary?: RoutingTarget;
  fallbacks: RoutingTarget[];
}

/** A single chat model entry inside an integration, with its own price and roles. */
export interface ChatModel {
  id: string;
  /** Provider deployment or model name (e.g. "gpt-4o", "gpt-4o-mini"). */
  name: string;
  /** Roles this model is allowed to serve. */
  capabilities: ChatCapability[];
  /** Provider-specific tier label. Currently populated from GitHub Models rate_limit_tier. */
  tier?: string;
  /** Maximum input/context tokens accepted by this model. */
  maxInputTokens?: number;
  /** Maximum output tokens this model can generate. */
  maxOutputTokens?: number;
  /** Optional per-model unit prices; falls back to the integration pricing when absent. */
  pricing?: AIPricing;
}

/** Optional unit prices (EUR) used to track spend. Token prices are per 1,000,000 tokens. */
export interface AIPricing {
  /** EUR per 1M input tokens (chat) */
  inputPerMTok?: number;
  /** EUR per 1M cached input tokens (chat) */
  cachedPerMTok?: number;
  /** EUR per 1M output tokens (chat) */
  outputPerMTok?: number;
  /** Token-based image pricing (gpt-image style), EUR per 1M tokens */
  imageInputTextPerMTok?: number;
  imageCachedInputTextPerMTok?: number;
  imageInputImagePerMTok?: number;
  imageCachedInputImagePerMTok?: number;
  imageOutputPerMTok?: number;
  /** EUR per 1M TTS characters */
  ttsPerMChar?: number;
  /** EUR per hour of STT audio */
  sttPerHour?: number;
}

export interface AIIntegration {
  id: string;
  name: string;
  provider: AIProviderType;
  /** Required for Azure OpenAI; optional base URL for OpenAI-compatible providers. */
  endpoint?: string;
  /** Not used by Microsoft 365 Copilot. */
  apiKey: string;
  /**
   * Chat models offered by this integration, each with its own roles and pricing.
   * Replaces the single modelWriting/modelReview fields (kept below for back-compat).
   */
  chatModels?: ChatModel[];
  /** Chat/writing deployment or model. @deprecated migrated into chatModels */
  modelWriting?: string;
  /** Review/evaluation deployment or model. @deprecated migrated into chatModels */
  modelReview?: string;
  /** Speech-to-text deployment/model, used when browser STT is not enough. */
  modelSpeechToText?: string;
  /** Text-to-speech deployment/model. */
  modelTextToSpeech?: string;
  /** Image generation deployment/model. */
  modelImageGeneration?: string;
  /** Azure API version when provider is azure_openai. */
  apiVersion?: string;
  /** Optional unit prices for spend tracking. */
  pricing?: AIPricing;
}

// ─── GitHub token entry ───────────────────────────────────────────────────────

export interface GitHubToken {
  /** Human-readable label shown in the UI */
  label: string;
  token: string;
}

export type BookExportScope = "full" | "draft";
export type BookExportPageSize = "letter" | "a4";
export type BookExportAlignment = "left" | "justified";
export type BookExportFontFamily = "serif" | "sans" | "mono";
export type ParagraphSeparator = "none" | "star" | "asterisks" | "custom";
export type AuditDepth = "quick" | "standard" | "deep";
export type AuditSeverityThreshold = "critical" | "high" | "medium" | "low" | "informational";
export type AuditReportLanguage = "book" | "en" | "it";

export interface AuditSettings {
  enabled: boolean;
  reportLanguage: AuditReportLanguage;
  defaultDepth: AuditDepth;
  severityThreshold: AuditSeverityThreshold;
  includeTimeline: boolean;
  includeSecrets: boolean;
  includeCharacters: boolean;
  includeLocations: boolean;
  includeItems: boolean;
  includeFactions: boolean;
  includeWritingStyle: boolean;
  includeSummary: boolean;
  includePreviousContext: boolean;
  includeNextContext: boolean;
  generateFixSuggestions: boolean;
  maxFindings: number;
  customPrompt: string;
}

export interface BookMetadataVisibility {
  /** Frontmatter keys rendered as reader/export metadata for the book file. */
  book: string[];
  /** Frontmatter keys rendered as reader/export metadata for chapter files. */
  chapter: string[];
  /** Frontmatter keys rendered as reader/export metadata for paragraph files. */
  paragraph: string[];
}

export interface BookExportSettings {
  defaultScope: BookExportScope;
  sampleChapters: number;
  includeTitlePage: boolean;
  includeImages: boolean;
  includeFrontmatter: boolean;
  showParagraphTitles: boolean;
  showChapterSummary: boolean;
  fontFamily: BookExportFontFamily;
  fontName: string;
  fontSize: number;
  lineSpacing: number;
  marginInches: number;
  paragraphIndentInches: number;
  pageSize: BookExportPageSize;
  paragraphAlignment: BookExportAlignment;
  lineBreakMode: ReaderLineBreakMode;
  sceneBreak: string;
  metadataVisibility: BookMetadataVisibility;
  paragraphSeparator: ParagraphSeparator;
  customParagraphSeparator: string;
  googleDriveFolderId?: string;
  googleDriveFolderName?: string;
  microsoftDriveFolderPath?: string;
}

export interface BookExportProfile {
  id: string;
  name: string;
  settings: Partial<BookExportSettings>;
}

export const DEFAULT_BOOK_EXPORT_SETTINGS: BookExportSettings = {
  defaultScope: "draft",
  sampleChapters: 5,
  includeTitlePage: true,
  includeImages: true,
  includeFrontmatter: false,
  showParagraphTitles: false,
  showChapterSummary: false,
  fontFamily: "serif",
  fontName: "Times New Roman",
  fontSize: 12,
  lineSpacing: 2,
  marginInches: 1,
  paragraphIndentInches: 0.5,
  pageSize: "letter",
  paragraphAlignment: "left",
  lineBreakMode: "book",
  sceneBreak: "#",
  metadataVisibility: {
    book: ["title", "author", "date"],
    chapter: ["title", "date", "summary"],
    paragraph: ["title", "date"],
  },
  paragraphSeparator: "star",
  customParagraphSeparator: "*",
};

export const DEFAULT_AUDIT_SETTINGS: AuditSettings = {
  enabled: true,
  reportLanguage: "book",
  defaultDepth: "standard",
  severityThreshold: "low",
  includeTimeline: true,
  includeSecrets: true,
  includeCharacters: true,
  includeLocations: true,
  includeItems: true,
  includeFactions: true,
  includeWritingStyle: true,
  includeSummary: true,
  includePreviousContext: true,
  includeNextContext: true,
  generateFixSuggestions: true,
  maxFindings: 50,
  customPrompt: "",
};

// ─── Book entry (one GitHub repository = one book) ───────────────────────────

export interface BookEntry {
  /** Unique local ID (crypto.randomUUID()) */
  id: string;
  /** GitHub repository owner (user or org) */
  owner: string;
  /** GitHub repository name */
  repo: string;
  /** Display name – defaults to repo name */
  name: string;
  /**
   * Index into `extraGitHubTokens` array.
   * null means use `defaultGitHubToken` (unless `bookToken` is set).
   */
  tokenIndex: number | null;
  /**
   * Optional repository-specific PAT, stored inline on the book.
   * When present it takes priority over both the saved extra token and the
   * default token, so a book can use a dedicated PAT created just for it.
   */
  bookToken?: string;
  /** Optional label for the inline book PAT. */
  bookTokenLabel?: string;
  /** Optional active branch selected for this book. Undefined = use the personal dev branch. */
  activeBranch?: string;
  /** Optional export settings and saved Drive target for this book. */
  exportSettings?: Partial<BookExportSettings>;
  /** Per-book audit behavior. The model/provider is selected by the fixed audit router task. */
  auditSettings?: Partial<AuditSettings>;
  /** Optional named export presets for this book. */
  exportProfiles?: BookExportProfile[];
  /** Optional default preset id for export dialogs. */
  defaultExportProfileId?: string;
  addedAt: string; // ISO-8601
}

export function resolveBookAuditSettings(book: BookEntry): AuditSettings {
  const raw = (book.auditSettings ?? {}) as Record<string, unknown>;
  const resolved = { ...DEFAULT_AUDIT_SETTINGS };
  const booleanKeys = [
    "enabled",
    "includeTimeline",
    "includeSecrets",
    "includeCharacters",
    "includeLocations",
    "includeItems",
    "includeFactions",
    "includeWritingStyle",
    "includeSummary",
    "includePreviousContext",
    "includeNextContext",
    "generateFixSuggestions",
  ] as const;

  for (const key of booleanKeys) {
    const value = raw[key];
    if (typeof value === "boolean") resolved[key] = value;
  }

  const reportLanguage = typeof raw.reportLanguage === "string" ? raw.reportLanguage.toLowerCase() : "";
  if (reportLanguage === "book" || reportLanguage === "en" || reportLanguage === "it") resolved.reportLanguage = reportLanguage;

  const defaultDepth = typeof raw.defaultDepth === "string" ? raw.defaultDepth.toLowerCase() : "";
  if (defaultDepth === "quick" || defaultDepth === "standard" || defaultDepth === "deep") resolved.defaultDepth = defaultDepth;

  const severityThreshold = typeof raw.severityThreshold === "string" ? raw.severityThreshold.toLowerCase() : "";
  if (severityThreshold === "critical" || severityThreshold === "high" || severityThreshold === "medium" || severityThreshold === "low" || severityThreshold === "informational") {
    resolved.severityThreshold = severityThreshold;
  }

  if (typeof raw.maxFindings === "number" && Number.isFinite(raw.maxFindings)) {
    resolved.maxFindings = Math.max(1, Math.min(500, Math.round(raw.maxFindings)));
  }
  if (typeof raw.customPrompt === "string") resolved.customPrompt = raw.customPrompt;

  return resolved;
}

export function resolveBookExportProfiles(book: BookEntry): BookExportProfile[] {
  if (book.exportProfiles?.length) return book.exportProfiles;
  return [{ id: "default", name: "Default", settings: book.exportSettings ?? {} }];
}

export function resolveBookExportSettings(book: BookEntry, profileId?: string): BookExportSettings {
  const profiles = resolveBookExportProfiles(book);
  const selected = profiles.find((entry) => entry.id === (profileId ?? book.defaultExportProfileId)) ?? profiles[0];
  const bookPresentation = book.exportSettings ?? {};
  const profileSettings = selected?.settings ?? {};
  return {
    ...DEFAULT_BOOK_EXPORT_SETTINGS,
    ...bookPresentation,
    ...profileSettings,
    metadataVisibility: {
      ...DEFAULT_BOOK_EXPORT_SETTINGS.metadataVisibility,
      // These are book-level editorial presentation settings. A legacy profile
      // must not silently replace values saved from Book Settings.
      ...(profileSettings.metadataVisibility ?? {}),
      ...(bookPresentation.metadataVisibility ?? {}),
    },
    paragraphSeparator: bookPresentation.paragraphSeparator ?? profileSettings.paragraphSeparator ?? DEFAULT_BOOK_EXPORT_SETTINGS.paragraphSeparator,
    customParagraphSeparator: bookPresentation.customParagraphSeparator ?? profileSettings.customParagraphSeparator ?? DEFAULT_BOOK_EXPORT_SETTINGS.customParagraphSeparator,
  };
}

/**
 * Resolve the effective GitHub token for a book, in priority order:
 * 1. inline per-book PAT (`bookToken`)
 * 2. a named extra token referenced by `tokenIndex`
 * 3. the default GitHub token
 */
export function resolveBookToken(book: BookEntry, settings: AppSettings): string {
  if (book.bookToken && book.bookToken.trim()) return book.bookToken.trim();
  if (book.tokenIndex != null) {
    return settings.extraGitHubTokens[book.tokenIndex]?.token ?? "";
  }
  return settings.defaultGitHubToken;
}

// ─── Root settings object stored in Google Drive ─────────────────────────────

export type SpeechProvider = "browser" | "ai";

export interface SpeechSettings {
  sttProvider: SpeechProvider;
  ttsProvider: SpeechProvider;
  ttsVoice: string;
  ttsRate: number;
}

export interface RepositorySettings {
  /** Lightweight remote-head check when opening a local repository. */
  autoFetchOnOpen: boolean;
  /** Periodic lightweight remote-head check. 0 disables the interval. */
  autoFetchIntervalMinutes: number;
  /** Apply remote changes automatically only when the local repo is clean. */
  autoPullWhenClean: boolean;
}

export type ResearchIntent = "auto" | "news" | "encyclopedia" | "internet";
export type ResearchRoutableIntent = Exclude<ResearchIntent, "auto">;
export type ResearchProviderId = "gdelt" | "wikipedia" | "wikidata" | "brave" | "duckduckgo_instant" | "tavily";

export interface DeepSearchIntentRoute {
  primary?: ResearchProviderId;
  fallbacks: ResearchProviderId[];
}

export interface DeepSearchProviderSettings {
  braveApiKey: string;
  tavilyApiKey: string;
  /** Existing Cloudflare content proxy base URL, if configured. */
  contentProxyBaseUrl: string;
  routes: Record<ResearchRoutableIntent, DeepSearchIntentRoute>;
}

export interface ReaderBookmark {
  id: string;
  bookId: string;
  chapterSlug: string;
  paragraphNumber: string;
  /** Logical character offset inside the paragraph text. Re-resolved after pagination changes. */
  offset: number;
  label: string;
  preview?: string;
  createdAt: string;
}

export type ReaderLineBreakMode = "book" | "dialogue" | "source";

export interface ReaderSettings {
  showImages: boolean;
  /** Frontmatter stays hidden by default; this is a reader/debug preference. */
  showFrontmatter: boolean;
  showRichEntityLinks: boolean;
  fullScreen: boolean;
  fontSize: number;
  fontFamily: "serif" | "sans" | "mono";
  lineHeight: number;
  pageMargin: number;
  /** How Markdown line/paragraph breaks are translated into the ebook reading flow. */
  lineBreakMode: ReaderLineBreakMode;
  /** Show a persistent exit-fullscreen button overlay while in full-screen mode. Off by default. */
  showExitFullscreenButton: boolean;
  bookmarks: ReaderBookmark[];
}

export type CustomActionActivation = "selection" | "element";
export type CustomActionOutputMode = "show" | "replace";

export interface CustomActionContextInjection {
  includeBody: boolean;
  includeFrontmatter: boolean;
  includeContext: boolean;
  includeWritingStyle: boolean;
  includeGhostwriter: boolean;
}

export interface CustomAction {
  id: string;
  name: string;
  prompt: string;
  /** Router capability used for the chat request. Never stores a concrete model. */
  capability: ChatCapability;
  /** "*" means every supported target type. Other values are semantic target names such as paragraph, chapter, character. */
  targetTypes: string[];
  activation: CustomActionActivation;
  injections: CustomActionContextInjection;
  outputMode: CustomActionOutputMode;
  enabled: boolean;
}

export interface CopilotToolOverride {
  enabled?: boolean;
}

export interface CopilotToolSettings {
  toolOverrides: Record<string, CopilotToolOverride>;
}

export interface AppSettings {
  /** Schema version for future migrations */
  version: 2;
  defaultGitHubToken: string;
  extraGitHubTokens: GitHubToken[];
  azureOpenAI: AzureOpenAIConfig;
  aiIntegrations: AIIntegration[];
  defaultWritingIntegrationId?: string;
  defaultReviewIntegrationId?: string;
  /** Optional configurable router: per task, a primary integration+model and ordered fallbacks. */
  taskRouting?: Partial<Record<RoutingTaskKind, TaskRoute>>;
  /** Currency symbol/code used for cost display (e.g. "USD", "EUR", "GBP"). Default: "USD". */
  costCurrency: string;
  ui: {
    language: "en" | "it";
    theme: "light" | "dark" | "system";
  };
  speech: SpeechSettings;
  repository: RepositorySettings;
  deepSearch: DeepSearchProviderSettings;
  copilotTools: CopilotToolSettings;
  reader: ReaderSettings;
  customActions: CustomAction[];
  books: BookEntry[];
}

export const SETTINGS_FILE_NAME = "settings.json";

export const DEFAULT_SETTINGS: AppSettings = {
  version: 2,
  defaultGitHubToken: "",
  extraGitHubTokens: [],
  azureOpenAI: {
    endpoint: "",
    apiKey: "",
    model: "gpt-4o",
    apiVersion: "2024-10-21",
  },
  aiIntegrations: [],
  defaultWritingIntegrationId: undefined,
  defaultReviewIntegrationId: undefined,
  costCurrency: "USD",
  ui: {
    language: "en",
    theme: "system",
  },
  speech: {
    sttProvider: "browser",
    ttsProvider: "browser",
    ttsVoice: "nova",
    ttsRate: 0.95,
  },
  repository: {
    autoFetchOnOpen: true,
    autoFetchIntervalMinutes: 15,
    autoPullWhenClean: false,
  },
  deepSearch: {
    braveApiKey: "",
    tavilyApiKey: "",
    contentProxyBaseUrl: (typeof import.meta !== "undefined" ? ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_RESEARCH_FETCH_PROXY ?? "") : ""),
    routes: {
      news: { primary: "gdelt", fallbacks: [] },
      encyclopedia: { primary: "wikipedia", fallbacks: ["wikidata"] },
      internet: { primary: "brave", fallbacks: ["duckduckgo_instant"] },
    },
  },
  copilotTools: {
    toolOverrides: {},
  },
  reader: {
    showImages: true,
    showFrontmatter: false,
    showRichEntityLinks: true,
    fullScreen: false,
    fontSize: 19,
    fontFamily: "serif",
    lineHeight: 1.75,
    pageMargin: 48,
    lineBreakMode: "book",
    showExitFullscreenButton: false,
    bookmarks: [],
  },
  customActions: [],
  books: [],
};

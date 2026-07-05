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
export type ChatCapability = "default" | "copilot" | "simple-tasks" | "review";

export const CHAT_CAPABILITIES: ChatCapability[] = ["default", "copilot", "simple-tasks", "review"];

/** Task kinds the configurable router can target: the 4 chat capabilities plus media tasks. */
export type RoutingTaskKind = ChatCapability | "tts" | "stt" | "image";

export const ROUTING_TASKS: RoutingTaskKind[] = ["default", "copilot", "simple-tasks", "review", "tts", "stt", "image"];

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

export interface BookExportSettings {
  defaultScope: BookExportScope;
  sampleChapters: number;
  includeTitlePage: boolean;
  showParagraphTitles: boolean;
  showChapterSummary: boolean;
  fontName: string;
  fontSize: number;
  lineSpacing: number;
  marginInches: number;
  paragraphIndentInches: number;
  pageSize: BookExportPageSize;
  paragraphAlignment: BookExportAlignment;
  sceneBreak: string;
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
  showParagraphTitles: false,
  showChapterSummary: false,
  fontName: "Times New Roman",
  fontSize: 12,
  lineSpacing: 2,
  marginInches: 1,
  paragraphIndentInches: 0.5,
  pageSize: "letter",
  paragraphAlignment: "left",
  sceneBreak: "#",
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
  /** Optional named export presets for this book. */
  exportProfiles?: BookExportProfile[];
  /** Optional default preset id for export dialogs. */
  defaultExportProfileId?: string;
  addedAt: string; // ISO-8601
}

export function resolveBookExportProfiles(book: BookEntry): BookExportProfile[] {
  if (book.exportProfiles?.length) return book.exportProfiles;
  return [{ id: "default", name: "Default", settings: book.exportSettings ?? {} }];
}

export function resolveBookExportSettings(book: BookEntry, profileId?: string): BookExportSettings {
  const profiles = resolveBookExportProfiles(book);
  const selected = profiles.find((entry) => entry.id === (profileId ?? book.defaultExportProfileId)) ?? profiles[0];
  return { ...DEFAULT_BOOK_EXPORT_SETTINGS, ...(selected?.settings ?? book.exportSettings ?? {}) };
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
  ui: {
    language: "en" | "it";
    theme: "light" | "dark" | "system";
  };
  speech: SpeechSettings;
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
  books: [],
};

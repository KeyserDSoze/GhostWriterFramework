// ─── Azure OpenAI ────────────────────────────────────────────────────────────

export interface AzureOpenAIConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  apiVersion: string;
}

export type AIProviderType = "azure_openai" | "openai" | "m365_copilot";

export interface AIIntegration {
  id: string;
  name: string;
  provider: AIProviderType;
  /** Required for Azure OpenAI; optional base URL for OpenAI-compatible providers. */
  endpoint?: string;
  /** Not used by Microsoft 365 Copilot. */
  apiKey: string;
  /** Chat/writing deployment or model. */
  modelWriting?: string;
  /** Review/evaluation deployment or model. */
  modelReview?: string;
  /** Speech-to-text deployment/model, used when browser STT is not enough. */
  modelSpeechToText?: string;
  /** Text-to-speech deployment/model. */
  modelTextToSpeech?: string;
  /** Azure API version when provider is azure_openai. */
  apiVersion?: string;
}

// ─── GitHub token entry ───────────────────────────────────────────────────────

export interface GitHubToken {
  /** Human-readable label shown in the UI */
  label: string;
  token: string;
}

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
  addedAt: string; // ISO-8601
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

export interface AppSettings {
  /** Schema version for future migrations */
  version: 2;
  defaultGitHubToken: string;
  extraGitHubTokens: GitHubToken[];
  azureOpenAI: AzureOpenAIConfig;
  aiIntegrations: AIIntegration[];
  defaultWritingIntegrationId?: string;
  defaultReviewIntegrationId?: string;
  ui: {
    language: "en" | "it";
    theme: "light" | "dark" | "system";
  };
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
  books: [],
};

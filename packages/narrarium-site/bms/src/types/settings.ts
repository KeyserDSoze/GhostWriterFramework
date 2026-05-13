// ─── Azure OpenAI ────────────────────────────────────────────────────────────

export interface AzureOpenAIConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  apiVersion: string;
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
   * null means use `defaultGitHubToken`.
   */
  tokenIndex: number | null;
  addedAt: string; // ISO-8601
}

// ─── Root settings object stored in Google Drive ─────────────────────────────

export interface AppSettings {
  /** Schema version for future migrations */
  version: 1;
  defaultGitHubToken: string;
  extraGitHubTokens: GitHubToken[];
  azureOpenAI: AzureOpenAIConfig;
  books: BookEntry[];
}

export const SETTINGS_FILE_NAME = "narrarium-bms-settings.json";

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  defaultGitHubToken: "",
  extraGitHubTokens: [],
  azureOpenAI: {
    endpoint: "",
    apiKey: "",
    model: "gpt-4o",
    apiVersion: "2024-10-21",
  },
  books: [],
};

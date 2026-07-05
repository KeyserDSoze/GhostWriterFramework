export interface GitHubCatalogModel {
  /** Model id used as ChatModel.name, e.g. "openai/gpt-4o". */
  id: string;
  name?: string;
  publisher?: string;
  summary?: string;
  capabilities?: string[];
  supported_input_modalities?: string[];
  supported_output_modalities?: string[];
  rate_limit_tier?: string;
  tags?: string[];
}

const GITHUB_MODELS_CATALOG_URL = "https://models.github.ai/catalog/models";

/** Fetch the GitHub Models catalog with a GitHub PAT (Bearer). */
export async function fetchGitHubModelsCatalog(pat: string): Promise<GitHubCatalogModel[]> {
  const response = await fetch(GITHUB_MODELS_CATALOG_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${pat}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub Models catalog: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as unknown;
  if (Array.isArray(data)) return data as GitHubCatalogModel[];
  // Some responses wrap the list; be tolerant.
  const models = (data as { models?: unknown }).models;
  return Array.isArray(models) ? (models as GitHubCatalogModel[]) : [];
}

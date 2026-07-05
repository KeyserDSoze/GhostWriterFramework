/**
 * GitHub Models endpoints.
 *
 * The browser cannot call https://models.github.ai directly because that host
 * does not return CORS headers. In production this should point at the
 * Cloudflare Worker proxy in infra/models-github-proxy via
 * VITE_GITHUB_MODELS_BASE. The proxy forwards paths one-to-one, so runtime code
 * only swaps the origin and keeps /inference and /catalog/models unchanged.
 */
const DIRECT_GITHUB_MODELS_HOST = "https://models.github.ai";

/** Origin used to reach GitHub Models: proxy in browser builds, direct fallback otherwise. */
export const GITHUB_MODELS_BASE =
  (import.meta.env.VITE_GITHUB_MODELS_BASE as string | undefined)?.trim().replace(/\/+$/, "") ||
  DIRECT_GITHUB_MODELS_HOST;

/** OpenAI-compatible inference base URL for the github_models provider. */
export const GITHUB_MODELS_INFERENCE_URL = `${GITHUB_MODELS_BASE}/inference`;

/** Model catalog endpoint. */
export const GITHUB_MODELS_CATALOG_URL = `${GITHUB_MODELS_BASE}/catalog/models`;

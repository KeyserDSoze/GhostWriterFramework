/**
 * Where the OAuth token broker lives.
 *
 * The broker is the Cloudflare Worker that already proxies GitHub Models (src/auth-proxy). It keeps the
 * Google and Microsoft client secrets, so the site can hold long-lived credentials for Google Drive and OneDrive.
 * Its address is the origin of VITE_GITHUB_MODELS_BASE, or VITE_AUTH_BROKER_BASE when that is set. With no Worker
 * configured (the site talks to models.github.ai directly) there is no broker, and nothing is ever sent to GitHub's host.
 */
const DIRECT_GITHUB_MODELS_ORIGIN = "https://models.github.ai";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

/** The broker holds secrets: it is reached over https, or over plain http only on this machine (local development). */
function secureBase(value: string): string | null {
  const url = parseUrl(value);
  if (!url || url.search || url.hash) return null;
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  return secure ? `${url.origin}${url.pathname}`.replace(/\/+$/, "") : null;
}

/** Pure form of {@link authBrokerBase}: the same decision for given build-time values. */
export function resolveAuthBrokerBase(authBrokerOverride: string | undefined, githubModelsBase: string | undefined): string | null {
  const override = (authBrokerOverride ?? "").trim();
  // An explicit override that is unusable fails closed instead of silently falling back to another host.
  if (override) return secureBase(override);
  const models = (githubModelsBase ?? "").trim();
  if (!models) return null;
  const url = parseUrl(models);
  if (!url || url.origin === DIRECT_GITHUB_MODELS_ORIGIN) return null;
  return secureBase(url.origin);
}

/** The broker's base URL (no trailing slash), or null when this build has no broker. Read at call time. */
export function authBrokerBase(): string | null {
  return resolveAuthBrokerBase(import.meta.env.VITE_AUTH_BROKER_BASE as string | undefined, import.meta.env.VITE_GITHUB_MODELS_BASE as string | undefined);
}

// Shared by the deploy workflow's verification step (summarize-oauth-status.mjs) and by the
// owner's check-status.mjs: asks the Worker's GET /oauth/status which providers are configured
// and says, in words, what to do next. It never prints a secret: the status answer holds only
// booleans, and the only names printed are the names of repository secrets and variables.

/**
 * The OAuth providers of the broker. `repositorySecret` is the GitHub repository secret the deploy
 * reads, `workerSecret` the Worker secret it is uploaded as (GitHub forbids repository secret names
 * that start with GITHUB_), `clientIdVariable` the public id in wrangler.toml.
 */
export const OAUTH_PROVIDERS = [
  { key: "google", label: "Google", repositorySecret: "GOOGLE_OAUTH_CLIENT_SECRET", workerSecret: "GOOGLE_CLIENT_SECRET", clientIdVariable: "GOOGLE_CLIENT_ID" },
  { key: "microsoft", label: "Microsoft", repositorySecret: "MICROSOFT_OAUTH_CLIENT_SECRET", workerSecret: "MICROSOFT_CLIENT_SECRET", clientIdVariable: "MICROSOFT_CLIENT_ID" },
  { key: "github", label: "GitHub", repositorySecret: "GH_APP_CLIENT_SECRET", workerSecret: "GITHUB_APP_CLIENT_SECRET", clientIdVariable: "GITHUB_APP_CLIENT_ID" },
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_ANSWER_CHARS = 4096;
const USER_AGENT = "narrarium-oauth-status-check/1";

/** The origin of a Worker URL (https anywhere, http only on loopback), or null. A path or query is dropped. */
export function normalizeBaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const safe = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  return safe && url.username === "" && url.password === "" ? url.origin : null;
}

const WORKER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Points a `https://<worker>.<account-subdomain>.workers.dev` URL at another Worker of the same
 * account (the account subdomain is shared). Any other URL (a custom domain, loopback) and an
 * invalid name leave the URL as it is: returns null for an invalid name, the origin otherwise.
 */
export function retargetWorkerName(baseUrl, name) {
  if (typeof name !== "string" || !WORKER_NAME.test(name)) return null;
  const origin = normalizeBaseUrl(baseUrl);
  if (!origin) return null;
  const match = /^https:\/\/[^./]+\.([^./]+\.workers\.dev)$/.exec(origin);
  return match ? `https://${name}.${match[1]}` : origin;
}

function readFlags(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const flags = {};
  for (const { key } of OAUTH_PROVIDERS) flags[key] = typeof data[key] === "boolean" ? data[key] : undefined;
  return flags;
}

const isComplete = (flags) => OAUTH_PROVIDERS.every(({ key }) => typeof flags[key] === "boolean");

async function requestOnce(baseUrl, fetchImpl, timeoutMs) {
  const response = await fetchImpl(`${baseUrl}/oauth/status`, {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) return { reason: `the Worker answered HTTP ${response.status}` };
  const flags = readFlags((await response.text()).slice(0, MAX_ANSWER_CHARS));
  return flags ? { flags } : { reason: "the Worker did not answer with the expected JSON" };
}

/**
 * GET <baseUrl>/oauth/status, tried up to `attempts` times because a new deploy takes a few seconds to
 * propagate (an older Worker answers without the newest provider). Never throws.
 * Resolves to { ok: true, flags } (a provider the answer did not mention is `undefined`) or { ok: false, reason }.
 */
export async function fetchOAuthStatus(baseUrl, options = {}) {
  const { fetchImpl = globalThis.fetch, attempts = 4, delayMs = 5000, timeoutMs = 10_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;
  let best = null;
  let reason = "no attempt was made";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await requestOnce(baseUrl, fetchImpl, timeoutMs);
      if (result.flags) {
        best = result.flags;
        if (isComplete(best)) break;
        reason = "the answer does not list every provider yet";
      } else {
        reason = result.reason;
      }
    } catch {
      reason = "the Worker could not be reached";
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return best ? { ok: true, flags: best } : { ok: false, reason };
}

const TEXT = {
  en: {
    configured: "configured",
    notConfigured: "not configured",
    unknown: "unknown",
    nothing: "Nothing to do.",
    unknownAction: "The Worker answered without this provider: wait a minute and run the workflow again, and check that the deploy step succeeded.",
    notUploaded: (p) =>
      p.key === "github"
        ? `Register the GitHub App, put its Client ID in ${p.clientIdVariable} in src/auth-proxy/wrangler.toml, set the repository secret ${p.repositorySecret}, then run this workflow again.`
        : `Set the repository secret ${p.repositorySecret} (the ${p.label} OAuth client secret), then run this workflow again.`,
    uploadedButOff: (p) => `The secret ${p.workerSecret} was uploaded in this run, so ${p.clientIdVariable} in src/auth-proxy/wrangler.toml is empty or missing: set it and deploy again.`,
  },
  it: {
    configured: "configurato",
    notConfigured: "NON configurato",
    unknown: "sconosciuto",
    nothing: "Niente da fare.",
    unknownAction: "Il Worker ha risposto senza questo provider: attendi un minuto e riprova, e controlla che il deploy sia andato a buon fine.",
    notUploaded: (p) =>
      p.key === "github"
        ? `Registra la GitHub App, scrivi il suo Client ID in ${p.clientIdVariable} in src/auth-proxy/wrangler.toml, imposta il secret ${p.repositorySecret} e rilancia il deploy.`
        : `Imposta il secret ${p.repositorySecret} (il client secret OAuth di ${p.label}) e rilancia il deploy.`,
    uploadedButOff: (p) => `Il secret ${p.workerSecret} e' stato caricato, quindi manca ${p.clientIdVariable} in src/auth-proxy/wrangler.toml: scrivilo e rifai il deploy.`,
  },
};

/**
 * One row per provider: { provider, state: "configured" | "not-configured" | "unknown", label, action }.
 * `uploaded` lists the Worker secret names the current deploy uploaded (names only, never values).
 */
export function describeStatus(flags, { language = "en", uploaded = [] } = {}) {
  const text = TEXT[language] ?? TEXT.en;
  return OAUTH_PROVIDERS.map((provider) => {
    const flag = flags[provider.key];
    if (flag === true) return { provider, state: "configured", label: text.configured, action: text.nothing };
    if (flag === false) {
      const action = uploaded.includes(provider.workerSecret) ? text.uploadedButOff(provider) : text.notUploaded(provider);
      return { provider, state: "not-configured", label: text.notConfigured, action };
    }
    return { provider, state: "unknown", label: text.unknown, action: text.unknownAction };
  });
}

const ICONS = { configured: "✅", "not-configured": "⚠️", unknown: "❔" };
const cell = (value) => String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The job summary: a table with one row per provider. */
export function renderSummary(rows, baseUrl) {
  const lines = [
    "### Worker sign-in status",
    "",
    `Answer of \`${baseUrl}/oauth/status\` (booleans only; no secret is read or printed).`,
    "",
    "| Provider | Status | Next action |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${cell(row.provider.label)} | ${ICONS[row.state]} ${cell(row.label)} | ${cell(row.action)} |`),
    "",
    "Step by step: `src/auth-proxy/docs/auth-proxy-setup.en.md` (Italian: `src/auth-proxy/docs/guida-auth-proxy.it.md`).",
    "",
  ];
  return lines.join("\n");
}

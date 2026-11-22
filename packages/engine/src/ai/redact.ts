const MIN_SECRET_LENGTH = 6;
const REDACTED = "[redacted]";

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const CREDENTIAL_ASSIGNMENT = /(\b(?:api[-_ ]?key|x-api-key|apikey|authorization|access[-_]?token|client[-_]?secret)\b["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;}&]{3,}/gi;
const QUERY_CREDENTIAL = /([?&](?:api[-_]?key|apikey|key|access[-_]?token|token|auth)=)[^&\s"']+/gi;
const SECRET_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{30,}/g;

/**
 * Removes credentials from a message before it is shown, saved or logged: the API keys of the configured integrations
 * (as they are and URL-encoded) and what keys usually look like (`Bearer …`, `api-key: …`, `?key=…`, `sk-…`, GitHub and
 * Google tokens). Messages that carry none of them are returned unchanged.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let output = text ?? "";
  if (!output) return output;
  for (const secret of secrets) {
    const key = (secret ?? "").trim();
    if (key.length < MIN_SECRET_LENGTH) continue;
    for (const form of new Set([key, encodeURIComponent(key)])) if (output.includes(form)) output = output.split(form).join(REDACTED);
  }
  return output
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(CREDENTIAL_ASSIGNMENT, `$1${REDACTED}`)
    .replace(QUERY_CREDENTIAL, `$1${REDACTED}`)
    .replace(SECRET_KEY, `sk-${REDACTED}`)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(GOOGLE_KEY, REDACTED);
}

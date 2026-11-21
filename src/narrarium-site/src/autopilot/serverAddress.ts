import { normalizeServerUrl } from "narrarium-engine";

export type ServerAddressProblem = "empty" | "invalid" | "scheme" | "credentials" | "host" | "insecure";

export type ServerAddressCheck = { ok: true; url: string } | { ok: false; reason: ServerAddressProblem };

/** The personal server address is empty or unusable: nothing is sent anywhere. */
export class ServerAddressError extends Error {
  constructor(readonly reason: ServerAddressProblem) {
    super(`The personal server address is not usable (${reason}).`);
    this.name = "ServerAddressError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Check an address typed by the author without ever throwing. An address is usable when it is a
 * URL with a host over https, or over plain http only for this computer, and carries no credentials.
 * `url` is the normalized address (no query, fragment or trailing slash), as the client will use it.
 */
export function validateServerAddress(value: string): ServerAddressCheck {
  const raw = value.trim();
  if (!raw) return { ok: false, reason: "empty" };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return { ok: false, reason: "scheme" };
  let normalized: string;
  let parsed: URL;
  try {
    normalized = normalizeServerUrl(raw);
    parsed = new URL(normalized);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (parsed.username || parsed.password) return { ok: false, reason: "credentials" };
  if (!parsed.hostname) return { ok: false, reason: "host" };
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) return { ok: false, reason: "insecure" };
  return { ok: true, url: normalized };
}

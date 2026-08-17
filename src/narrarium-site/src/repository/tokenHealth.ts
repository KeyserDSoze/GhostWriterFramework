import type { RepositoryErrorKind } from "@/repository/repositoryError";

export type TokenPermissionStatus = "unknown" | "read-validated" | "write-validated" | "denied";

export interface TokenHealth {
  expiresAt?: string;
  lastValidated: string;
  permissionStatus: TokenPermissionStatus;
  errorKind?: RepositoryErrorKind;
}

export interface TokenHealthTarget {
  accountIdentity: string;
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

const PREFIX = "narrarium-token-health:";

function normalizedTarget(target: TokenHealthTarget): TokenHealthTarget {
  return {
    ...target,
    accountIdentity: target.accountIdentity.trim(),
    owner: target.owner.trim().toLowerCase(),
    repo: target.repo.trim().toLowerCase(),
    // GitHub owner/repository names are case-insensitive; Git refs are not.
    branch: target.branch,
  };
}

async function storageKey(input: TokenHealthTarget): Promise<string> {
  const target = normalizedTarget(input);
  const bytes = new TextEncoder().encode(`${target.accountIdentity}\0${target.token}\0${target.owner}\0${target.repo}\0${target.branch}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `${PREFIX}${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export async function readTokenHealth(target: TokenHealthTarget): Promise<TokenHealth | null> {
  if (!target.accountIdentity || !target.token || !target.owner || !target.repo || !target.branch) return null;
  try {
    const raw = localStorage.getItem(await storageKey(target));
    return raw ? JSON.parse(raw) as TokenHealth : null;
  } catch { return null; }
}

export async function writeTokenHealth(target: TokenHealthTarget, health: TokenHealth): Promise<void> {
  if (!target.accountIdentity || !target.token || !target.owner || !target.repo || !target.branch) return;
  try {
    localStorage.setItem(await storageKey(target), JSON.stringify(health));
  } catch {
    // Token-health telemetry must never turn a successful GitHub operation into a failure.
  }
}

export function clearTokenHealth(): void {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch { /* Storage may be unavailable in private mode. */ }
}

export async function recordSuccessfulGitHubResponse(target: TokenHealthTarget, headers?: Record<string, unknown>): Promise<void> {
  const previous = await readTokenHealth(target);
  await writeTokenHealth(target, {
    expiresAt: tokenExpirationFromHeaders(headers) ?? previous?.expiresAt,
    lastValidated: new Date().toISOString(),
    permissionStatus: previous?.permissionStatus ?? "unknown",
    errorKind: previous?.errorKind,
  });
}

export async function recordRepositoryReadValidated(target: TokenHealthTarget, expiresAt?: string): Promise<TokenHealth> {
  const previous = await readTokenHealth(target);
  const health: TokenHealth = {
    expiresAt: expiresAt ?? previous?.expiresAt,
    lastValidated: new Date().toISOString(),
    permissionStatus: previous?.permissionStatus === "write-validated" ? "write-validated" : "read-validated",
  };
  await writeTokenHealth(target, health);
  return health;
}

export async function recordRepositoryWriteValidated(target: TokenHealthTarget): Promise<void> {
  const previous = await readTokenHealth(target);
  await writeTokenHealth(target, {
    expiresAt: previous?.expiresAt,
    lastValidated: new Date().toISOString(),
    permissionStatus: "write-validated",
  });
}

export function tokenExpirationFromHeaders(headers: Record<string, unknown> | undefined): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === "github-authentication-token-expiration");
  const value = key && typeof headers[key] === "string" ? headers[key] as string : undefined;
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

export function tokenExpirationWarning(expiresAt?: string, now = Date.now()): "expired" | "one-day" | "seven-days" | "thirty-days" | "ok" | "unknown" {
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return "unknown";
  const days = (Date.parse(expiresAt) - now) / 86_400_000;
  if (days <= 0) return "expired";
  if (days <= 1) return "one-day";
  if (days <= 7) return "seven-days";
  if (days <= 30) return "thirty-days";
  return "ok";
}

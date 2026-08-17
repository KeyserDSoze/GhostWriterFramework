export const repositoryErrorKinds = [
  "not-found",
  "credential-invalid",
  "permission",
  "permission-unverified",
  "branch-protected",
  "sso-required",
  "rate-limit",
  "abuse-limit",
  "service-unavailable",
  "network",
  "abort",
  "conflict",
  "malformed",
  "unknown",
] as const;

export type RepositoryErrorKind = (typeof repositoryErrorKinds)[number];

export const repositoryOperations = [
  "read",
  "create",
  "update",
  "delete",
  "list",
  "compare",
  "revert",
] as const;

export type RepositoryOperation = (typeof repositoryOperations)[number];

export class RepositoryError extends Error {
  readonly cause?: unknown;
  readonly details?: { rateLimitReset?: string };

  constructor(
    message: string,
    readonly kind: RepositoryErrorKind,
    readonly operation: RepositoryOperation,
    readonly status?: number,
    options?: { rateLimitReset?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "RepositoryError";
    this.cause = options?.cause;
    this.details = options?.rateLimitReset ? { rateLimitReset: options.rateLimitReset } : undefined;
  }
}

export function classifyRepositoryError(error: unknown, operation: RepositoryOperation, _path?: string): RepositoryError {
  if (error instanceof RepositoryError) return error;
  const record = error && typeof error === "object" ? error as { name?: unknown; message?: unknown; status?: unknown; response?: { status?: unknown; headers?: Record<string, unknown>; data?: { message?: unknown } } } : null;
  const status = typeof record?.status === "number" ? record.status : typeof record?.response?.status === "number" ? record.response.status : undefined;
  const name = typeof record?.name === "string" ? record.name : "";
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  const headers = normalizeRepositoryHeaders(record?.response?.headers);
  const rawMessage = typeof record?.response?.data?.message === "string" ? record.response.data.message : typeof record?.message === "string" ? record.message : "";
  const message = rawMessage.slice(0, 500).toLowerCase();
  const rateLimited = status === 429 || (status === 403 && headers["x-ratelimit-remaining"] === "0");
  const abuseLimited = status === 403 && /secondary rate limit|abuse detection|temporarily blocked/.test(message);
  const ssoRequired = status === 403 && /saml|single sign-on|sso|organization approval|pending approval/.test(message);
  const branchProtected = (status === 403 || status === 422) && /protected branch|protected_branch|branch protection|gh006|required status check|review is required/.test(message);
  const permissionDenied = status === 403 && /resource not accessible|installation|repository access|repo scope|insufficient permission|must have.*permission/.test(message);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const kind: RepositoryErrorKind = name === "AbortError" || code === "ABORT_ERR" ? "abort"
    : abuseLimited ? "abuse-limit"
      : rateLimited ? "rate-limit"
      : status === 401 ? "credential-invalid"
        : branchProtected ? "branch-protected"
          : ssoRequired ? "sso-required"
          : permissionDenied ? "permission"
            : status === 403 ? "permission-unverified"
        : status === 404 && operation === "read" ? "not-found"
          : status === 404 || status === 409 || status === 412 || status === 422 ? "conflict"
            : status !== undefined && status >= 500 ? "service-unavailable"
              : offline || error instanceof TypeError ? "network"
                : /CONFLICT|HEAD_MISMATCH/.test(code) ? "conflict" : "unknown";
  const reset = headers["x-ratelimit-reset"];
  const rateLimitReset = reset && /^\d{1,12}$/.test(reset) ? new Date(Number(reset) * 1000).toISOString() : undefined;
  return new RepositoryError(`REPOSITORY_${kind.replace(/-/g, "_").toUpperCase()}`, kind, operation, status, rateLimitReset ? { rateLimitReset } : undefined);
}

function normalizeRepositoryHeaders(input?: Record<string, unknown>): Record<string, string> {
  const safe: Record<string, string> = {};
  if (!input) return safe;
  for (const key of ["x-ratelimit-remaining", "x-ratelimit-reset", "retry-after", "github-authentication-token-expiration"]) {
    const value = input[key] ?? input[Object.keys(input).find((candidate) => candidate.toLowerCase() === key) ?? ""];
    if (typeof value === "string" && value.length <= 100) safe[key] = value;
    else if (typeof value === "number") safe[key] = String(value);
  }
  return safe;
}

export function repositoryErrorDescription(error: unknown, t: (key: string, options?: Record<string, unknown>) => string): string {
  const classified = classifyRepositoryError(error, "read");
  if (classified.kind === "rate-limit" && classified.details?.rateLimitReset) {
    return t("repositoryErrors.rate-limit-reset", { reset: new Date(classified.details.rateLimitReset).toLocaleString() });
  }
  return t(`repositoryErrors.${classified.kind}`, { reset: classified.details?.rateLimitReset ? new Date(classified.details.rateLimitReset).toLocaleString() : undefined });
}

export function isRepositoryError(error: unknown, kind?: RepositoryErrorKind): error is RepositoryError {
  return error instanceof RepositoryError && (kind === undefined || error.kind === kind);
}

export function isRepositoryNotFoundError(error: unknown): error is RepositoryError {
  return isRepositoryError(error, "not-found");
}

export async function optionalRepositoryRead<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isRepositoryNotFoundError(error)) return null;
    throw error;
  }
}

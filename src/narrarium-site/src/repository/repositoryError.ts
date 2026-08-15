export const repositoryErrorKinds = [
  "not-found",
  "auth",
  "rate-limit",
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

  constructor(
    message: string,
    readonly kind: RepositoryErrorKind,
    readonly operation: RepositoryOperation,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "RepositoryError";
    this.cause = options?.cause;
  }
}

export function classifyRepositoryError(error: unknown, operation: RepositoryOperation, path?: string): RepositoryError {
  if (error instanceof RepositoryError) return error;
  const record = error && typeof error === "object" ? error as { name?: unknown; status?: unknown; response?: { status?: unknown; headers?: Record<string, string> } } : null;
  const status = typeof record?.status === "number" ? record.status : typeof record?.response?.status === "number" ? record.response.status : undefined;
  const name = typeof record?.name === "string" ? record.name : "";
  const rateLimited = status === 429 || (status === 403 && record?.response?.headers?.["x-ratelimit-remaining"] === "0");
  const kind: RepositoryErrorKind = name === "AbortError" ? "abort"
    : rateLimited ? "rate-limit"
      : status === 401 || status === 403 ? "auth"
        : status === 404 && operation === "read" ? "not-found"
          : status === 404 || status === 409 || status === 412 || status === 422 ? "conflict"
            : status !== undefined && status >= 500 ? "network"
              : error instanceof TypeError ? "network" : "unknown";
  return new RepositoryError(`Repository ${operation} failed${path ? ` for ${path}` : ""}${status ? `: ${status}` : ""}.`, kind, operation, status, { cause: error });
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

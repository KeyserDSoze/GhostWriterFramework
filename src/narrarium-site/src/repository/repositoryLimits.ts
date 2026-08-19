export const REPOSITORY_TEXT_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
export const REPOSITORY_BINARY_FILE_LIMIT_BYTES = 25 * 1024 * 1024;
export const REPOSITORY_MUTATION_LIMIT_BYTES = 50 * 1024 * 1024;
export const REPOSITORY_TRANSFER_LIMIT_BYTES = 250 * 1024 * 1024;

export type RepositoryContentKind = "text" | "binary";
export type RepositoryLimitScope = "file" | "mutation" | "transfer";

export class RepositoryLimitExceededError extends Error {
  readonly code = "REPOSITORY_LIMIT_EXCEEDED";

  constructor(
    readonly scope: RepositoryLimitScope,
    readonly kind: RepositoryContentKind | "aggregate",
    readonly measuredBytes: number,
    readonly allowedBytes: number,
  ) {
    super(`Repository ${scope} limit exceeded (${measuredBytes} > ${allowedBytes} bytes).`);
    this.name = "RepositoryLimitExceededError";
  }
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function repositoryFileLimit(kind: RepositoryContentKind): number {
  return kind === "text" ? REPOSITORY_TEXT_FILE_LIMIT_BYTES : REPOSITORY_BINARY_FILE_LIMIT_BYTES;
}

export function assertRepositoryFileBytes(kind: RepositoryContentKind, measuredBytes: number, allowedBytes = repositoryFileLimit(kind)): void {
  if (!Number.isFinite(measuredBytes) || measuredBytes < 0 || measuredBytes > allowedBytes) {
    throw new RepositoryLimitExceededError("file", kind, measuredBytes, allowedBytes);
  }
}

export function assertRepositoryAggregateBytes(measuredBytes: number, scope: Extract<RepositoryLimitScope, "mutation" | "transfer">, allowedBytes = scope === "mutation" ? REPOSITORY_MUTATION_LIMIT_BYTES : REPOSITORY_TRANSFER_LIMIT_BYTES): void {
  if (!Number.isFinite(measuredBytes) || measuredBytes < 0 || measuredBytes > allowedBytes) {
    throw new RepositoryLimitExceededError(scope, "aggregate", measuredBytes, allowedBytes);
  }
}

export class RepositoryByteMeter {
  private total = 0;

  constructor(readonly scope: Extract<RepositoryLimitScope, "mutation" | "transfer">, readonly allowedBytes = scope === "mutation" ? REPOSITORY_MUTATION_LIMIT_BYTES : REPOSITORY_TRANSFER_LIMIT_BYTES) {}

  add(kind: RepositoryContentKind, measuredBytes: number, fileAllowedBytes = repositoryFileLimit(kind)): number {
    assertRepositoryFileBytes(kind, measuredBytes, fileAllowedBytes);
    const next = this.total + measuredBytes;
    assertRepositoryAggregateBytes(next, this.scope, this.allowedBytes);
    this.total = next;
    return next;
  }

  addChunk(kind: RepositoryContentKind, chunkBytes: number, fileMeasuredBytes: number, fileAllowedBytes = repositoryFileLimit(kind)): number {
    assertRepositoryFileBytes(kind, fileMeasuredBytes, fileAllowedBytes);
    const next = this.total + chunkBytes;
    assertRepositoryAggregateBytes(next, this.scope, this.allowedBytes);
    this.total = next;
    return next;
  }

  get measuredBytes(): number { return this.total; }
}

export function formatRepositoryBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length))));
  }
  return btoa(chunks.join(""));
}

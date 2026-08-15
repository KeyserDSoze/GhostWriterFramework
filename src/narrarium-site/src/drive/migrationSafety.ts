export function assertCloudStatus(ok: boolean, status: number, context: string): void {
  if (!ok) throw new Error(`${context}: ${status}`);
}

export async function readMigrationSource<T>(label: string, load: () => Promise<T>, validate: (value: T) => boolean): Promise<T> {
  const value = await load();
  if (!validate(value)) throw new Error(`${label} source is malformed.`);
  return value;
}

export async function writeAndVerifyMigrationTarget<T>(
  label: string,
  write: () => Promise<void>,
  read: () => Promise<T>,
  expected: T,
  equal: (left: T, right: T) => boolean,
): Promise<void> {
  await write();
  const actual = await read();
  if (!equal(actual, expected)) throw new Error(`${label} target verification failed.`);
}

export function resumableMigrationSteps<T extends { step: string; ok: boolean; verified?: boolean }>(allSteps: string[], previous: T[]): string[] {
  const completed = new Set(previous.filter((result) => result.ok && result.verified).map((result) => result.step));
  return allSteps.filter((step) => !completed.has(step));
}

export function indexUniqueMigrationIdentities<T extends { id: string; fileId?: string }>(items: T[], label: string): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const item of items) {
    if (indexed.has(item.id)) throw new Error(`${label} has duplicate chat identity ${item.id}.`);
    indexed.set(item.id, item);
  }
  return indexed;
}

export function assertMigrationChatCompatible<T>(sessionId: string, source: T, target: T, canonical: (value: T) => unknown): void {
  const targetIdentity = (target as { id?: unknown }).id;
  if (targetIdentity !== sessionId) throw new Error(`Target chat ${sessionId} has mismatched session identity.`);
  if (JSON.stringify(canonical(source)) !== JSON.stringify(canonical(target))) {
    throw new Error(`Target chat ${sessionId} conflicts with the migration source.`);
  }
}

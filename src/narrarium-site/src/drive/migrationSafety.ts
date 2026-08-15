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

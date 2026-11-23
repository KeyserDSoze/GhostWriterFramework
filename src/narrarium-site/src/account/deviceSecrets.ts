/**
 * Secrets that belong to this device and must never leave it with the synced account data: the access token of the GitHub App, and any token
 * that ever stands in for it. The account dataset is made of settings, costs, clipboard and chats, so none is in it by construction; this list is the
 * second wall: `dataProjection` drops any token field of the settings that holds one of these values, so a copy of it made by mistake in a field
 * that IS synced (the default token, a named one, a book's own) is never written to Drive, OneDrive or the settings repository. Nothing here logs.
 */
const secrets = new Map<string, string>();

/** Registers (or, with no value, forgets) the device-local secret held under `slot`. */
export function setDeviceLocalSecret(slot: string, value: string | undefined): void {
  const text = value?.trim();
  if (text) secrets.set(slot, text);
  else secrets.delete(slot);
}

export function isDeviceLocalSecret(value: string | undefined): boolean {
  const text = value?.trim();
  if (!text) return false;
  for (const secret of secrets.values()) if (secret === text) return true;
  return false;
}

export function resetDeviceLocalSecretsForTests(): void {
  secrets.clear();
}

function numericVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerAppVersion(candidate: string, current: string): boolean {
  const next = numericVersion(candidate);
  const installed = numericVersion(current);
  if (!next || !installed) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (next[index]! > installed[index]!) return true;
    if (next[index]! < installed[index]!) return false;
  }
  return false;
}

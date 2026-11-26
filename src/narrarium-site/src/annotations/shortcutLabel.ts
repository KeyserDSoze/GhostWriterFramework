/**
 * The name of the platform and the label of the shortcut that annotates, apart from the keys themselves (`shortcut.ts`): the list of the keyboard
 * shortcuts is in the shell and needs only these, and the shell does not carry what only the reader does.
 */

function platformName(): string {
  if (typeof navigator === "undefined") return "";
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return data?.platform || navigator.platform || navigator.userAgent || "";
}

export function isMacPlatform(platform: string = platformName()): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function annotateShortcutLabel(mac: boolean = isMacPlatform()): string {
  return mac ? "⌥⌘A" : "Ctrl+Alt+M";
}

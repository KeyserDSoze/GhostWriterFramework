import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { defaultDataRoot } from "./runtime-install.js";

/**
 * Where the server keeps its data unless `--data-root` or NARRARIUM_SERVER_HOME says otherwise. Windows used to keep it under %APPDATA%
 * (the roaming profile: copied to other computers and into backups, with the secrets in it). A new install uses %LOCALAPPDATA%, and
 * an install that already has its data in the old place keeps using it: nothing is moved, so nothing can be lost.
 */
export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (folder: string) => boolean = existsSync): string {
  if (platform !== "win32" || env.NARRARIUM_SERVER_HOME?.trim()) return defaultDataRoot(env, platform);
  const windows = path.win32;
  const profile = env.USERPROFILE ?? env.HOME ?? homedir();
  const local = windows.resolve(env.LOCALAPPDATA ?? windows.join(profile, "AppData", "Local"), "Narrarium", "server");
  const roaming = windows.resolve(env.APPDATA ?? windows.join(profile, "AppData", "Roaming"), "Narrarium", "server");
  if (exists(local)) return local;
  return exists(roaming) ? roaming : local;
}

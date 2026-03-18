import path from "node:path";
import process from "node:process";

export function loadReaderEnvFiles(cwd = process.cwd()) {
  for (const fileName of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.join(cwd, fileName));
    } catch {
      // Ignore missing or unreadable local env files.
    }
  }
}

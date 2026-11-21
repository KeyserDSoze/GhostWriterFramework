/** Test entry (bundled to dist/testing.mjs, never published). */
export { startNarrariumServer, type NarrariumServerOptions, type RunningNarrariumServer } from "./server.js";
export { DataDirectory, DEFAULT_ORIGINS, loadServerConfig, normalizeOrigin } from "./config.js";
export { Auth } from "./auth.js";
export { Vault } from "./vault.js";
export { FileBookStore, KeyedMutex } from "./fs-store.js";
export { GitRepository, GitError, gitVersion, runGit } from "./git.js";
export { BookRegistry } from "./books.js";
export { HttpError } from "./errors.js";
export { SERVER_VERSION } from "./version.js";
export { lockDataRoot, atomicJson, readJson } from "./files.js";
export * from "./npm-release.js";
export * from "./runtime-install.js";
export * from "./tunnel.js";
export * from "./autostart.js";
export * from "./network.js";
export * from "./admin-client.js";
export { main as cliMain, parseCommand, doctorChecks, HELP } from "./cli-main.js";

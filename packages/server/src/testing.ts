/** Test entry (bundled to dist/testing.mjs, never published). */
export { startNarrariumServer, errorStatus, type NarrariumServerOptions, type RunningNarrariumServer } from "./server.js";
export { DataDirectory, DEFAULT_ORIGINS, loadServerConfig, normalizeOrigin } from "./config.js";
export { Auth } from "./auth.js";
export { Vault } from "./vault.js";
export { FileBookStore, KeyedMutex } from "./fs-store.js";
export { GitRepository, GitError, gitVersion, runGit } from "./git.js";
export { BookRegistry } from "./books.js";
export { HttpError } from "./errors.js";
export { SERVER_VERSION } from "./version.js";
export { lockDataRoot, atomicJson, readJson } from "./files.js";
export * from "./limits.js";
export { bridgeToApi, forwardedHeaders } from "./gateway.js";
export * from "./npm-release.js";
export * from "./der.js";
export * from "./runtime-install.js";
export * from "./data-root.js";
export * from "./tunnel.js";
export * from "./process-identity.js";
export * from "./autostart.js";
export * from "./network.js";
export * from "./admin-client.js";
export { main as cliMain, parseCommand, doctorChecks, prepareRuntime, HELP, type CliDependencies } from "./cli-main.js";
// The engine's own copy of these classes (the one the server's `instanceof` checks see), for tests that must build them.
export { AiProviderError, AiReplyRejectedError, AutopilotStateCorruptError } from "narrarium-engine";

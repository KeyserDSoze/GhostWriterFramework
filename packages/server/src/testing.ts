/** Test entry (bundled to dist/testing.mjs, never published). */
export { startNarrariumServer, errorStatus, type NarrariumServerOptions, type RunningNarrariumServer } from "./server.js";
export { DataDirectory, DEFAULT_ORIGINS, loadServerConfig, normalizeOrigin, publicLabel } from "./config.js";
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
export * from "./ai-approval.js";
export * from "./spend.js";
export * from "./admin-client.js";
export { main as cliMain, parseCommand, doctorChecks, prepareRuntime, HELP, type CliDependencies } from "./cli-main.js";
// The engine's own copy of these classes (the one the server's `instanceof` checks see), for tests that must build them.
export {
  AiFallbackBlockedError,
  AiPromptTooLargeError,
  AiProviderError,
  AiReplyRejectedError,
  AiRoutingBudgetError,
  AutopilotRuleError,
  AutopilotStateCorruptError,
  FrontmatterError,
  FrozenChapterError,
} from "narrarium-engine";
export { McpBooks, assertSlug, slugFromTitle } from "./mcp-books.js";
export { McpAudit } from "./mcp-audit.js";
export { pageText } from "./mcp-kit.js";
export * from "./webauthn.js";
export { OAuthServer } from "./oauth.js";
export { OAuthStore } from "./oauth-store.js";

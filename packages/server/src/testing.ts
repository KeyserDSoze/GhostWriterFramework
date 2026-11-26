/** Test entry (bundled to dist/testing.mjs, never published). */
export { startNarrariumServer, errorStatus, type NarrariumServerOptions, type RunningNarrariumServer } from "./server.js";
export { DataDirectory, DEFAULT_ORIGINS, aiCallsSettingsOf, loadServerConfig, normalizeOrigin, parseAiCallsSettings, publicLabel } from "./config.js";
export { Auth } from "./auth.js";
export { Vault } from "./vault.js";
export { FileBookStore, KeyedMutex } from "./fs-store.js";
export { GitRepository, GitError, gitVersion, runGit } from "./git.js";
export { GIT_OPERATION_MARKER, GithubConflictError } from "./github-conflicts.js";
export { BookRegistry } from "./books.js";
export { HttpError } from "./errors.js";
export { SERVER_VERSION } from "./version.js";
export { lockDataRoot, lockStartMs, atomicJson, readJson } from "./files.js";
export * from "./limits.js";
export { bridgeToApi, forwardedHeaders } from "./gateway.js";
export * from "./npm-release.js";
export * from "./mcp-outline-edit.js";
export { OUTLINE_SCAN_MAX_ENTRIES } from "./mcp-outline.js";
export { ToolError } from "./mcp-kit.js";
/** The registry that `tools/list` shows: `npm run docs:tools` writes `mcp-tools.json` from it. */
export { TOOLS } from "./mcp-tools.js";
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
export * from "./admin-log.js";
export * from "./admin-devices.js";
export * from "./ai-calls.js";
export * from "./admin-actions.js";
export * from "./admin-runs.js";
export * from "./admin-health.js";
export * from "./admin-risks.js";
export * from "./ui-texts.js";
export * from "./update-verification.js";
export * from "./update-history.js";
export { main as cliMain, parseCommand, doctorChecks, prepareRuntime, HELP, type CliDependencies } from "./cli-main.js";
// The engine's own copy of these classes (the one the server's `instanceof` checks see), for tests that must build them.
export {
  AiCallDiskFullError,
  AiFallbackBlockedError,
  AiPromptTooLargeError,
  AiProviderError,
  AiReplyRejectedError,
  AiRoutingBudgetError,
  AutopilotRuleError,
  AutopilotStateCorruptError,
  FrontmatterError,
  FrozenChapterError,
  RevisionCampaignError,
} from "narrarium-engine";
export { McpBooks, assertSlug, slugFromTitle } from "./mcp-books.js";
export { McpAudit } from "./mcp-audit.js";
export { pageText } from "./mcp-kit.js";
export * from "./webauthn.js";
export { OAuthServer } from "./oauth.js";
export { OAuthStore } from "./oauth-store.js";

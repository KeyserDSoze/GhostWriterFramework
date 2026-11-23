import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const sources = readdirSync(join(root, "src"), { recursive: true })
  .map(String)
  .filter((path) => /\.(ts|tsx)$/.test(path))
  .map((path) => `src/${path}`);
const read = (path) => readFileSync(join(root, path), "utf8");
const importing = (pattern) => sources.filter((path) => pattern.test(read(path))).sort();

const COPILOT_PATH = ["src/assistant/router.ts", "src/assistant/llm.ts", "src/assistant/copilotAi.ts", "src/assistant/completionFallback.ts"];

test("the Copilot's path does not use the openai SDK: it asks the engine's client, through the browser's AI port", () => {
  for (const path of COPILOT_PATH) {
    assert.doesNotMatch(read(path), /from "openai"|chat\.completions/, path);
  }
  assert.match(read("src/assistant/copilotAi.ts"), /createBrowserAi\(/);
  assert.doesNotMatch(read("src/assistant/llm.ts"), /completeText|completeToolWith|classifyConfirmationWith/);
});

test("the openai SDK stays a dependency of the site because the media, the speech and the Azure helpers still import it", () => {
  assert.deepEqual(importing(/from "openai"/), ["src/assets/assetImages.ts", "src/assistant/speech.ts", "src/azure-openai/openaiClient.ts"]);
  const manifest = JSON.parse(read("package.json"));
  assert.ok(manifest.dependencies.openai, "the dependency is still listed: three modules import it");
});

test("the Copilot has no absolute timer and does not read the provider timeout of an integration as a ceiling", () => {
  for (const path of ["src/assistant/router.ts", "src/assistant/llm.ts", "src/assistant/completionFallback.ts"]) {
    const source = read(path);
    assert.doesNotMatch(source, /setTimeout|runWithCandidateTimeout|DEFAULT_PROVIDER_TIMEOUT_MS|CandidateTimeoutError|executionLimits/, path);
    assert.doesNotMatch(source, /requestTimeoutMs|idleTimeoutMs/, `${path} leaves the deadlines of a request to the engine's client`);
  }
  const bridge = read("src/assistant/copilotAi.ts");
  assert.doesNotMatch(bridge, /requestTimeoutMs|idleTimeoutMs|DEFAULT_PROVIDER_TIMEOUT_MS|executionLimits/);
  assert.equal(bridge.match(/setTimeout\(/g)?.length, 1, "the only timer of the bridge is the routing time (maxTotalDurationMs) that is left for a fallback");
  assert.match(bridge, /maxTotalDurationMs/);
  // The other timer of the Copilot's path is the wait before a quiet retry, which the author's Stop ends and which never decides how long a request may take.
  const retry = read("src/assistant/quietRetry.ts");
  assert.equal(retry.match(/setTimeout\(/g)?.length, 1, "the wait of a quiet retry is the only other timer");
  assert.doesNotMatch(retry, /requestTimeoutMs|idleTimeoutMs|DEFAULT_PROVIDER_TIMEOUT_MS|executionLimits/);
});

test("executionLimits stays for the media, which have deadlines of their own, and for the constant that the settings show", () => {
  assert.deepEqual(importing(/executionLimits/), [
    "src/assets/assetImages.ts",
    "src/assistant/mediaFallback.ts",
    "src/assistant/speech.ts",
    "src/components/settings/IntegrationRequestFields.tsx",
  ]);
});

test("a call of the Copilot is recorded once, by the browser's AI port: no second debug entry and no second cost record of its own", () => {
  for (const path of COPILOT_PATH) {
    assert.doesNotMatch(read(path), /useLlmDebugStore|useCostsStore|recordChatUsage|recordCurrent/, path);
  }
  assert.match(read("src/autopilot/browserAi.ts"), /useLlmDebugStore\.getState\(\)\.begin/);
  assert.match(read("src/autopilot/browserAi.ts"), /useCostsStore\.getState\(\)\.recordCurrent/);
});

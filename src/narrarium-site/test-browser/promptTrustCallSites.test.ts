import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fg from "fast-glob";

const ROUTED_CALL_SITES = [
  "src/assets/assetImages.ts",
  "src/assistant/brainstorm/runner.ts",
  "src/assistant/copilotLoop.ts",
  "src/components/assistant/AssistantPanel.tsx",
  "src/components/editor/useProseAssist.tsx",
  "src/custom-actions/customActions.ts",
  "src/narrarium/audit.ts",
  "src/narrarium/pipeline.ts",
  "src/narrarium/readerEvaluations.ts",
  "src/narrarium/rewriteFromReaderFeedback.ts",
  "src/outline/outlineAssistPrompts.ts",
  "src/pages/EvaluationStylePage.tsx",
  "src/research/createFromResearch.ts",
  "src/research/engine.ts",
  "src/research/regenerateEntity.ts",
];

/** The text, the forced calls and the confirmations of the Copilot go through the engine's client (`createBrowserAi`), so they are not here: only the media and the Azure helpers still call a provider API themselves. */
const DIRECT_PROVIDER_CALL_SITES = ["src/assistant/speech.ts", "src/assets/assetImages.ts", "src/azure-openai/openaiClient.ts"];

/** Adapters that hand prompts already framed by the shared engine (packages/engine) to the engine's own AI client. */
const ENGINE_AI_ADAPTERS = ["src/autopilot/browserAi.ts"];
const ENGINE_PROMPT_MODULES = ["../../packages/engine/src/autopilot/tasks.ts", "../../packages/engine/src/director/opinion.ts"];

describe("LLM call-site trust contract", () => {
  it.each(ROUTED_CALL_SITES)("frames dynamic data at %s", (path) => {
    const source = readFileSync(resolve(process.cwd(), path), "utf8");
    expect(source).toMatch(/complete(?:Text|Tool)Routed(?:\s*<|\s*\()/);
    expect(source).toContain("@/assistant/promptTrust");
    expect(source).toContain("currentRequest(");
    expect(source).toContain("untrustedData(");
  });

  it.each(ENGINE_AI_ADAPTERS)("hands the engine-framed prompts to the engine's client unchanged at %s", (path) => {
    const source = readFileSync(resolve(process.cwd(), path), "utf8");
    expect(source).toContain("createFetchAi(");
    expect(source).toMatch(/\.complete\(\{ \.\.\.request,/);
    // The same client as the personal server: neither the site's routed completions nor its SDK, and no second framing.
    expect(source).not.toMatch(/complete(?:Text|Tool)Routed/);
    expect(source).not.toMatch(/from "openai"/);
    expect(source).not.toContain("currentRequest(");
    expect(source).not.toContain("untrustedData(");
  });

  it.each(ENGINE_PROMPT_MODULES)("frames dynamic data in the shared engine at %s", (path) => {
    const source = readFileSync(resolve(process.cwd(), path), "utf8");
    expect(source).toContain("../prompt/trust.js");
    expect(source).toContain("currentRequest(");
    expect(source).toContain("untrustedData(");
  });

  it("audits every application module that calls routed completion", () => {
    const expected = [...ROUTED_CALL_SITES, "src/assistant/service.ts"].sort();
    const discovered = fg.sync("src/**/*.{ts,tsx}", { cwd: process.cwd() })
      .filter((path) => path !== "src/assistant/router.ts")
      .filter((path) => /complete(?:Text|Tool)Routed(?:\s*<|\s*\()/.test(readFileSync(resolve(process.cwd(), path), "utf8")))
      .sort();
    expect(discovered).toEqual(expected);
  });

  it("audits every direct provider API call behind operation cancellation", () => {
    const discovered = fg.sync("src/**/*.{ts,tsx}", { cwd: process.cwd() })
      .filter((path) => /(?:chat\.completions|audio\.(?:transcriptions|speech)|images)\.(?:create|generate)\(/.test(readFileSync(resolve(process.cwd(), path), "utf8")))
      .sort();
    expect(discovered).toEqual([...DIRECT_PROVIDER_CALL_SITES].sort());
    for (const path of discovered) expect(readFileSync(resolve(process.cwd(), path), "utf8")).toContain("beginAccountScopedAiOperation");
  });

  it("builds the engine's AI client only in the autopilot adapter, which runs it behind operation cancellation", () => {
    // The generated documentation quotes the engine's README: prose, not a call.
    const discovered = fg.sync("src/**/*.{ts,tsx}", { cwd: process.cwd(), ignore: ["src/lib/generated-docs.ts"] })
      .filter((path) => /\bcreateFetchAi\s*\(/.test(readFileSync(resolve(process.cwd(), path), "utf8")))
      .sort();
    expect(discovered).toEqual([...ENGINE_AI_ADAPTERS].sort());
    for (const path of discovered) expect(readFileSync(resolve(process.cwd(), path), "utf8")).toContain("beginAccountScopedAiOperation");
  });

  it("prevents raw attachment, image, and Azure helper payloads", () => {
    const service = readFileSync(resolve(process.cwd(), "src/assistant/service.ts"), "utf8");
    expect(service).not.toContain("buildUserMessage(input, input.prompt)");
    const images = readFileSync(resolve(process.cwd(), "src/assets/assetImages.ts"), "utf8");
    expect(images).toContain('prompt: providerPrompt');
    expect(images).not.toContain('prompt: input.prompt');
    expect(images).not.toContain('], "default", { accountScope: input.accountScope, label: "image:prompt" }).catch');
    const azure = readFileSync(resolve(process.cwd(), "src/azure-openai/openaiClient.ts"), "utf8");
    expect(azure).toContain("trustedInstruction: string");
    expect(azure).toContain("untrustedPayload: string");
    expect(azure).not.toContain("systemPrompt: string");
  });

  it("frames confirmation utterances exactly once before dispatch, and sends the framed text as it is", () => {
    const router = readFileSync(resolve(process.cwd(), "src/assistant/router.ts"), "utf8");
    expect(router).toContain('content: currentRequest(utterance)');
    expect(router).toContain('messages: [{ role: "user", content: budgetedUtterance }]');
    expect(router).not.toContain("currentRequest(budgetedUtterance");
    for (const path of ["src/assistant/llm.ts", "src/assistant/copilotAi.ts"]) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(source, path).not.toContain('messages: [{ role: "user", content: utterance }]');
      expect(source, path).not.toContain("currentRequest(");
    }
  });

  it("sends the Copilot's text, forced calls and confirmations through the engine's client, behind the operation of the account, and never through the SDK", () => {
    const copilotAi = readFileSync(resolve(process.cwd(), "src/assistant/copilotAi.ts"), "utf8");
    expect(copilotAi).toContain("createBrowserAi(");
    expect(copilotAi).toContain("accountScope: attempt.accountScope");
    for (const path of ["src/assistant/router.ts", "src/assistant/llm.ts", "src/assistant/copilotAi.ts", "src/assistant/completionFallback.ts"]) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(source, path).not.toMatch(/from "openai"/);
      expect(source, path).not.toMatch(/chat\.completions/);
    }
  });
});

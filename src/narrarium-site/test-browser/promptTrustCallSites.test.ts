import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fg from "fast-glob";

const ROUTED_CALL_SITES = [
  "src/assets/assetImages.ts",
  "src/components/assistant/AssistantPanel.tsx",
  "src/components/editor/useProseAssist.tsx",
  "src/custom-actions/customActions.ts",
  "src/narrarium/audit.ts",
  "src/narrarium/pipeline.ts",
  "src/narrarium/readerEvaluations.ts",
  "src/narrarium/rewriteFromReaderFeedback.ts",
  "src/pages/EvaluationStylePage.tsx",
  "src/research/createFromResearch.ts",
  "src/research/engine.ts",
  "src/research/regenerateEntity.ts",
];

const DIRECT_PROVIDER_CALL_SITES = ["src/assistant/llm.ts", "src/assistant/speech.ts", "src/assets/assetImages.ts", "src/azure-openai/openaiClient.ts"];

describe("LLM call-site trust contract", () => {
  it.each(ROUTED_CALL_SITES)("frames dynamic data at %s", (path) => {
    const source = readFileSync(resolve(process.cwd(), path), "utf8");
    expect(source).toMatch(/complete(?:Text|Tool)Routed(?:\s*<|\s*\()/);
    expect(source).toContain("@/assistant/promptTrust");
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

  it("frames confirmation utterances exactly once before direct dispatch", () => {
    const router = readFileSync(resolve(process.cwd(), "src/assistant/router.ts"), "utf8");
    expect(router).toContain('content: currentRequest(utterance)');
    const llm = readFileSync(resolve(process.cwd(), "src/assistant/llm.ts"), "utf8");
    expect(llm).not.toContain('messages: [{ role: "user", content: utterance }]');
    expect(llm).toContain('messages: [{ role: "user", content: framedRequest }]');
  });
});

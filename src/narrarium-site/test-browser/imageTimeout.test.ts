import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings } from "@/types/settings";

const imageGenerate = vi.hoisted(() => vi.fn());

vi.mock("openai", () => {
  class ImageClient {
    images = { generate: imageGenerate };
  }
  return { default: ImageClient, AzureOpenAI: ImageClient };
});

import { generateAssetImage } from "@/assets/assetImages";
import { useLlmDebugStore } from "@/debug/llmDebugStore";

function integration(id: string, model: string, timeout = 5): AIIntegration {
  return { id, name: id, provider: "openai", apiKey: "key", requestTimeoutMs: timeout, modelImageGeneration: model, chatModels: [] };
}

function settings(): AppSettings {
  const primary = integration("private-primary", "primary-image");
  const fallback = integration("fallback", "fallback-image");
  return {
    ...DEFAULT_SETTINGS,
    aiIntegrations: [primary, fallback],
    taskRouting: { image: { primary: { integrationId: primary.id, model: primary.modelImageGeneration! }, fallbacks: [{ integrationId: fallback.id, model: fallback.modelImageGeneration! }] } },
  };
}

describe("image provider timeouts", () => {
  beforeEach(() => {
    imageGenerate.mockReset();
    vi.unstubAllGlobals();
    useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
  });

  it("times out generation, advances fallback, and records redacted route metadata", async () => {
    imageGenerate.mockImplementationOnce((_request, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("sk-private-secret", "AbortError")), { once: true });
    })).mockResolvedValueOnce({ data: [{ b64_json: btoa("png") }] });

    const result = await generateAssetImage({ settings: settings(), prompt: "private prompt", orientation: "square" });
    expect(result.model).toBe("fallback-image");
    const primary = useLlmDebugStore.getState().entries.find((entry) => entry.routeCandidateIndex === 0);
    const fallback = useLlmDebugStore.getState().entries.find((entry) => entry.routeCandidateIndex === 1);
    expect(primary).toMatchObject({ failureKind: "timeout", timeoutMs: 5, provider: "openai", usedFallback: false });
    expect(primary?.integrationId).toMatch(/^integration:[0-9a-f]{16}$/);
    expect(fallback).toMatchObject({ status: "done", usedFallback: true });
    expect(JSON.stringify(primary)).not.toContain("private-primary");
    expect(JSON.stringify(primary)).not.toContain("private prompt");
    expect(JSON.stringify(primary)).not.toContain("sk-private-secret");
  });

  it("applies the timeout to provider-hosted image download and advances fallback", async () => {
    imageGenerate.mockResolvedValueOnce({ data: [{ url: "https://private.invalid/image.png" }] }).mockResolvedValueOnce({ data: [{ b64_json: btoa("png") }] });
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("download aborted", "AbortError")), { once: true });
    })));

    const result = await generateAssetImage({ settings: settings(), prompt: "prompt", orientation: "portrait" });
    expect(result.model).toBe("fallback-image");
    expect(useLlmDebugStore.getState().entries.find((entry) => entry.routeCandidateIndex === 0)).toMatchObject({ failureKind: "timeout", timeoutMs: 5 });
  });

  it("does not advance fallback after operation cancellation", async () => {
    const controller = new AbortController();
    imageGenerate.mockImplementation((_request, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      controller.abort(new DOMException("user cancelled", "AbortError"));
    }));

    await expect(generateAssetImage({ settings: settings(), prompt: "prompt", orientation: "portrait", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(imageGenerate).toHaveBeenCalledTimes(1);
  });
});

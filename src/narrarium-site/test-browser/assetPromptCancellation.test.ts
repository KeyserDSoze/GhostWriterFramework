import { beforeEach, describe, expect, it, vi } from "vitest";

const completeTextRouted = vi.hoisted(() => vi.fn());

vi.mock("@/assistant/router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/assistant/router")>(),
  completeTextRouted,
}));

import { composeAssetPromptWithAI } from "@/assets/assetImages";
import { optionalAssetPrompt } from "@/components/book/AssetImageDialog";

describe("optional asset prompt fallback", () => {
  beforeEach(() => completeTextRouted.mockReset());

  it("falls back only for non-abort optional failures", async () => {
    await expect(optionalAssetPrompt(Promise.reject(new Error("provider unavailable")))).resolves.toBeNull();
  });

  it("propagates stale-account cancellation instead of falling back", async () => {
    const cancellation = new DOMException("The AI operation belongs to a stale authenticated account.", "AbortError");
    await expect(optionalAssetPrompt(Promise.reject(cancellation))).rejects.toBe(cancellation);
  });

  it("propagates account cancellation directly from routed completion through compose", async () => {
    const cancellation = new DOMException("The authenticated account changed.", "AbortError");
    completeTextRouted.mockRejectedValueOnce(cancellation);

    await expect(composeAssetPromptWithAI({ settings: {} as never, kind: "book", title: "Title", sourceText: "Source", accountScope: "google:first@example.com" })).rejects.toMatchObject({ name: "AbortError" });
    expect(completeTextRouted).toHaveBeenCalledOnce();
  });
});

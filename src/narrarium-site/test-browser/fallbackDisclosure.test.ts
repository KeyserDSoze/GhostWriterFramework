import { beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeCrossBoundaryFallback, applySameBoundaryPolicy, CrossBoundaryFallbackCancelledError, setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings } from "@/types/settings";
import { beginAccountScopedAiOperation } from "@/assistant/accountScopedOperation";

const first: AIIntegration = { id: "account-a", name: "Account A", provider: "openai", apiKey: "secret" };
const same: AIIntegration = { id: "account-a", name: "Account A", provider: "openai", apiKey: "secret" };
const other: AIIntegration = { id: "account-b", name: "Account B", provider: "azure_openai", apiKey: "secret" };
const candidates = [{ integration: first }, { integration: same }, { integration: other }];

function settings(patch: Partial<AppSettings["fallbackDisclosure"]>): AppSettings {
  return { ...DEFAULT_SETTINGS, fallbackDisclosure: { ...DEFAULT_SETTINGS.fallbackDisclosure, ...patch } };
}

describe("fallback provider/account disclosure", () => {
  beforeEach(() => { localStorage.clear(); setFallbackAcknowledgementAccountScope("google:writer@example.com"); });

  it("restricts text, STT, TTS, and image chains to the primary account boundary", () => {
    for (const task of ["text", "stt", "tts", "image"]) {
      expect(applySameBoundaryPolicy(settings({ sameBoundaryOnly: true }), candidates).map((entry) => entry.integration.id), task).toEqual(["account-a", "account-a"]);
    }
  });

  it.each(["text", "audio", "image"] as const)("durably acknowledges %s disclosure with content-kind scope", (kind) => {
    const confirm = vi.fn(() => true);
    const input = { settings: settings({ requireAcknowledgement: true }), kind, from: candidates[0], to: candidates[2], confirm };
    acknowledgeCrossBoundaryFallback(input);
    acknowledgeCrossBoundaryFallback(input);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("supports cancel before acknowledging or dispatching", () => {
    expect(() => acknowledgeCrossBoundaryFallback({ settings: settings({ requireAcknowledgement: true }), kind: "audio", from: candidates[0], to: candidates[2], confirm: () => false })).toThrow(CrossBoundaryFallbackCancelledError);
    expect(localStorage.length).toBe(0);
  });

  it("isolates durable acknowledgements by normalized provider/account identity", () => {
    const confirm = vi.fn(() => true);
    const base = { settings: settings({ requireAcknowledgement: true }), kind: "text" as const, from: candidates[0], to: candidates[2], confirm };
    acknowledgeCrossBoundaryFallback({ ...base, accountScope: "Google:Writer@Example.com" });
    acknowledgeCrossBoundaryFallback({ ...base, accountScope: "google:writer@example.com" });
    acknowledgeCrossBoundaryFallback({ ...base, accountScope: "microsoft:writer@example.com" });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("switches the active account namespace without deleting a returning account's acknowledgement", () => {
    const confirm = vi.fn(() => true);
    const input = { settings: settings({ requireAcknowledgement: true }), kind: "text" as const, from: candidates[0], to: candidates[2], confirm };
    setFallbackAcknowledgementAccountScope("google:first@example.com");
    acknowledgeCrossBoundaryFallback(input);
    setFallbackAcknowledgementAccountScope(null);
    acknowledgeCrossBoundaryFallback(input);
    setFallbackAcknowledgementAccountScope("google:second@example.com");
    acknowledgeCrossBoundaryFallback(input);
    setFallbackAcknowledgementAccountScope("google:first@example.com");
    acknowledgeCrossBoundaryFallback(input);
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("does not persist logged-out acknowledgements", () => {
    const confirm = vi.fn(() => true);
    const base = { settings: settings({ requireAcknowledgement: true }), kind: "audio" as const, from: candidates[0], to: candidates[2], accountScope: null, confirm };
    acknowledgeCrossBoundaryFallback(base);
    acknowledgeCrossBoundaryFallback(base);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(localStorage.length).toBe(0);
  });

  it("keeps image acknowledgement separate from text", () => {
    const confirm = vi.fn(() => true);
    const base = { settings: settings({ requireAcknowledgement: true }), from: candidates[0], to: candidates[2], accountScope: "google:writer@example.com", confirm };
    acknowledgeCrossBoundaryFallback({ ...base, kind: "text" });
    acknowledgeCrossBoundaryFallback({ ...base, kind: "image" });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("snapshots account scope and aborts an active operation on account switch", () => {
    setFallbackAcknowledgementAccountScope("google:first@example.com");
    const operation = beginAccountScopedAiOperation();
    setFallbackAcknowledgementAccountScope("google:second@example.com");
    expect(operation.accountScope).toBe("google:first@example.com");
    expect(operation.signal).toHaveProperty("aborted", true);
    operation.dispose();
  });

  it("rejects stale explicit scopes after account switch or logout", () => {
    setFallbackAcknowledgementAccountScope("google:current@example.com");
    const staleAccount = beginAccountScopedAiOperation(undefined, "google:previous@example.com");
    expect(() => staleAccount.signal.throwIfAborted()).toThrow(expect.objectContaining({ name: "AbortError" }));
    setFallbackAcknowledgementAccountScope(null);
    const staleLogout = beginAccountScopedAiOperation(undefined, "google:current@example.com");
    expect(() => staleLogout.signal.throwIfAborted()).toThrow(expect.objectContaining({ name: "AbortError" }));
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/types/settings";

const speechCreate = vi.hoisted(() => vi.fn());
const transcriptionCreate = vi.hoisted(() => vi.fn());
const speechCandidate = vi.hoisted(() => ({
  integration: { id: "tts", name: "TTS", provider: "openai" as const, apiKey: "key", modelTextToSpeech: "tts-1", requestTimeoutMs: undefined as number | undefined },
  model: "tts-1",
}));
const fallbackSpeechCandidate = vi.hoisted(() => ({
  integration: { id: "tts-fallback", name: "TTS fallback", provider: "openai" as const, apiKey: "key", modelTextToSpeech: "tts-2", requestTimeoutMs: undefined as number | undefined },
  model: "tts-2",
}));
const speechCandidates = vi.hoisted(() => [speechCandidate]);
const debugBegin = vi.hoisted(() => vi.fn());
const debugFinish = vi.hoisted(() => vi.fn());

vi.mock("openai", () => {
  class AudioClient {
    audio = { speech: { create: speechCreate }, transcriptions: { create: transcriptionCreate } };
  }
  return { default: AudioClient, AzureOpenAI: AudioClient };
});

vi.mock("@/assistant/router", () => ({
  resolveTaskCandidates: () => speechCandidates,
}));

vi.mock("@/debug/llmDebugStore", () => ({
  useLlmDebugStore: { getState: () => ({ begin: debugBegin, finish: debugFinish }) },
}));

import { speakText, transcribeAudio } from "@/assistant/speech";

class FakeAudio {
  static instances: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ended = false;
  src: string;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

const settings = {
  speech: { ttsVoice: "nova", ttsRate: 1 },
  ui: { language: "en" },
} as AppSettings;

const response = () => ({ arrayBuffer: async () => new ArrayBuffer(1) });

async function flushPlayback() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("AI speech playback", () => {
  beforeEach(() => {
    speechCreate.mockReset();
    transcriptionCreate.mockReset();
    speechCandidate.integration.requestTimeoutMs = undefined;
    fallbackSpeechCandidate.integration.requestTimeoutMs = undefined;
    speechCandidates.splice(0, speechCandidates.length, speechCandidate);
    debugBegin.mockReset();
    debugBegin.mockImplementation(() => `debug-${debugBegin.mock.calls.length}`);
    debugFinish.mockReset();
    FakeAudio.instances = [];
    vi.stubGlobal("Audio", FakeAudio);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:${speechCreate.mock.calls.length}`) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: vi.fn(() => []) },
    });
  });

  it("plays the successful first synthesis instead of requesting it twice", async () => {
    speechCreate.mockResolvedValue(response());

    const controller = await speakText("First. Second.", settings, { segments: ["First.", "Second."] });
    await flushPlayback();

    expect(speechCreate.mock.calls.map(([input]) => input.input)).toEqual(["First.", "Second."]);
    expect(debugFinish).not.toHaveBeenCalled();
    FakeAudio.instances[0].onended?.();
    await flushPlayback();
    FakeAudio.instances[1].onended?.();
    await controller.done;
    expect(debugBegin).toHaveBeenCalledTimes(2);
    expect(debugFinish.mock.calls.map(([, patch]) => patch.response)).toEqual(expect.arrayContaining([
      "6 generated chars, 6 played chars",
      "7 generated chars, 7 played chars",
    ]));
  });

  it("rejects done for a later synthesis failure without requiring an onError callback", async () => {
    speechCreate.mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("provider failed"));

    const controller = await speakText("First. Second.", settings, { segments: ["First.", "Second."] });
    await flushPlayback();
    FakeAudio.instances[0].onended?.();
    await expect(controller.done).rejects.toThrow("provider failed");

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1");
  });

  it("advances to the next TTS candidate when a later chunk fails", async () => {
    speechCandidates.push(fallbackSpeechCandidate);
    speechCreate.mockResolvedValueOnce(response()).mockRejectedValueOnce(new DOMException("provider aborted", "AbortError")).mockResolvedValueOnce(response());

    const controller = await speakText("First. Second.", settings, { segments: ["First.", "Second."] });
    await flushPlayback();
    expect(speechCreate.mock.calls.map(([input]) => [input.model, input.input])).toEqual([
      ["tts-1", "First."],
      ["tts-1", "Second."],
      ["tts-2", "Second."],
    ]);
    FakeAudio.instances[0].onended?.();
    await flushPlayback();
    FakeAudio.instances[1].onended?.();
    await controller.done;
    expect(debugFinish.mock.calls.some(([, patch]) => patch.failureKind === "provider")).toBe(true);
  });

  it("rejects done for playback failure without requiring an onError callback", async () => {
    speechCreate.mockResolvedValue(response());
    const controller = await speakText("First.", settings, { segments: ["First."] });
    await flushPlayback();

    FakeAudio.instances[0].onerror?.();

    await expect(controller.done).rejects.toThrow("Audio playback failed for segment 1");
  });

  it("stop aborts in-flight prefetch, settles once, and releases object URLs", async () => {
    let prefetchSignal: AbortSignal | undefined;
    speechCreate.mockResolvedValueOnce(response()).mockImplementationOnce((_input, options) => new Promise((_resolve, reject) => {
      prefetchSignal = options.signal;
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));

    const controller = await speakText("First. Second.", settings, { segments: ["First.", "Second."] });
    await flushPlayback();
    controller.stop();
    controller.stop();
    await controller.done;

    expect(prefetchSignal?.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1");
  });

  it("times out TTS synthesis and records privacy-safe candidate diagnostics", async () => {
    speechCandidate.integration.requestTimeoutMs = 5;
    speechCreate.mockImplementation((_input, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("provider secret", "AbortError")), { once: true });
    }));

    await expect(speakText("First.", settings, { segments: ["First."] })).rejects.toMatchObject({ name: "CandidateTimeoutError" });
    expect(debugBegin.mock.calls[0][0]).toMatchObject({ provider: "openai", integrationId: "tts", routeCandidateIndex: 0, usedFallback: false });
    expect(debugFinish.mock.calls[0][1]).toMatchObject({ failureKind: "timeout", timeoutMs: 5 });
  });

  it("times out STT with the configured provider timeout", async () => {
    speechCandidate.integration.requestTimeoutMs = 5;
    transcriptionCreate.mockImplementation((_input, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));

    await expect(transcribeAudio(new Blob(["audio"]), settings)).rejects.toMatchObject({ name: "CandidateTimeoutError" });
    expect(debugFinish.mock.calls[0][1]).toMatchObject({ failureKind: "timeout", timeoutMs: 5 });
  });
});

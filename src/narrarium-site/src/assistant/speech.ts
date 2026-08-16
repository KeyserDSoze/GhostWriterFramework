import OpenAI, { AzureOpenAI } from "openai";
import type { AIIntegration, AppSettings } from "@/types/settings";
import { resolveWritingIntegration } from "@/assistant/llm";
import { resolveTaskCandidates, type TaskCandidate } from "@/assistant/router";
import { sttDelta, ttsDelta, useCostsStore } from "@/costs/costsStore";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { BrowserSpeechFallbackRequired, executeMediaFallback } from "@/assistant/mediaFallback";
import { CandidateTimeoutError } from "@/assistant/executionLimits";
import { acknowledgeCrossBoundaryFallback, applySameBoundaryPolicy } from "@/assistant/fallbackDisclosure";
import { beginAccountScopedAiOperation } from "@/assistant/accountScopedOperation";

const MAX_TTS_CHARS = 1200;
const BROWSER_TTS_FALLBACK = "narrarium:browser-tts-fallback";

/** Options shared by every TTS engine. */
export interface SpeakOptions {
  /** Pre-computed reading units ("strofe"). When omitted they are derived from the text. */
  segments?: string[];
  /** Index of the first segment to read (used to resume after a pause or rewrite). */
  startIndex?: number;
  /** Fired right before a segment starts playing, with its index in `segments`. */
  onSegment?: (index: number) => void;
  /** Reports playback or synthesis failures that happen after a controller is returned. */
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
  accountScope: string | null;
}

export interface SpeechController {
  stop: () => void;
  pause: () => void;
  resume: () => void;
  /** True while playback is paused (audio + queue frozen). */
  isPaused: () => boolean;
  /** The reading units this controller is speaking. */
  segments: string[];
  /** Index of the segment currently playing (or about to play). */
  getCurrentIndex: () => number;
  done: Promise<void>;
}

export function markdownToSpeechText(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  let tableOmitted = false;
  const tableBorderPattern = /^\|.*\|$/;
  const tableDividerPattern = /^(?:-|:|\||\s)+$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (tableBorderPattern.test(trimmed) || tableDividerPattern.test(trimmed)) {
      if (!tableOmitted) {
        out.push("Tabella omessa.");
        tableOmitted = true;
      }
      continue;
    }
    tableOmitted = false;
    const cleaned = trimmed
      .replace(/^#{1,6}\s+/g, "")
      .replace(/^[-*+]\s+/g, "")
      .replace(/^>\s*/g, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
      .replace(/[*_~]/g, "")
      .trim();
    if (cleaned) out.push(cleaned);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Split clean prose into "strofe": one sentence/clause per entry.
 * Keeps the terminator with the sentence and never drops an empty line as a separator
 * so that verse-like text (one line per stanza) also segments naturally.
 */
export function splitIntoStrofe(text: string): string[] {
  const normalized = markdownToSpeechText(text);
  const strofe: string[] = [];
  for (const line of normalized.split(/\n+/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    // Split on sentence terminators (. ! ? … ;) keeping the terminator attached.
    const sentences = trimmedLine.match(/[^.!?…;]+[.!?…;]+|[^.!?…;]+$/g);
    if (!sentences) {
      strofe.push(trimmedLine);
      continue;
    }
    for (const sentence of sentences) {
      const cleaned = sentence.trim();
      if (cleaned) strofe.push(cleaned);
    }
  }
  return strofe;
}

/** Legacy paragraph-based chunking, kept for non-live whole-text reading efficiency. */
export function splitSpeechText(text: string): string[] {
  const normalized = markdownToSpeechText(text);
  const paragraphs = normalized.split(/\n{2,}/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).length > MAX_TTS_CHARS && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function getSpeechIntegration(settings: AppSettings): AIIntegration | null {
  const integration = resolveWritingIntegration(settings);
  // GitHub Models is LLM-only → keep STT/TTS on OpenAI/Azure (browser fallback otherwise).
  if (!integration || integration.provider === "m365_copilot" || integration.provider === "github_models") return null;
  if (!integration.apiKey) return null;
  return integration;
}

export async function transcribeAudio(blob: Blob, settings: AppSettings, signal: AbortSignal | undefined, startCandidateIndex: number, accountScope: string | null): Promise<string> {
  const operation = beginAccountScopedAiOperation(signal, accountScope);
  operation.signal.throwIfAborted();
  try {
  const routeCandidates = applySameBoundaryPolicy(settings, resolveTaskCandidates(settings, "stt"));
  const candidates = routeCandidates.slice(startCandidateIndex);
  if (!candidates.length) throw new Error("No AI speech-to-text model is configured.");
  const sizeKb = Math.round(blob.size / 1024);
  return await executeMediaFallback<string, TaskCandidate>({ candidates, signal: operation.signal, beforeCandidate: (candidate, index) => { const previous = routeCandidates[startCandidateIndex + index - 1]; if (previous) acknowledgeCrossBoundaryFallback({ settings, kind: "audio", from: previous, to: candidate, accountScope: operation.accountScope }); }, runBrowser: async (index) => { throw new BrowserSpeechFallbackRequired(startCandidateIndex + index + 1); }, runAi: async (candidate, attemptSignal, candidateIndex) => {
    const integration = candidate.integration as AIIntegration;
    const model = candidate.model!;
    const pricing = candidates.find((entry) => entry.integration === integration && entry.model === model)?.pricing;
    const file = new File([blob], "speech.webm", { type: blob.type || "audio/webm" });
    const client = createAudioClient(integration);
    const debugId = useLlmDebugStore.getState().begin({ kind: "stt", contentKinds: ["audio"], label: "stt", model, provider: integration.provider, integrationId: integration.id, routeCandidateIndex: startCandidateIndex + candidateIndex, usedFallback: startCandidateIndex + candidateIndex > 0, messages: [{ role: "input", content: `audio ${sizeKb} KB` }] });
    try {
      const response = await client.audio.transcriptions.create({ file, model }, { signal: attemptSignal });
      attemptSignal?.throwIfAborted();
      const estimatedHours = blob.size > 0 ? blob.size / (16000 * 3600) : 0;
      const cost = pricing ? sttDelta(estimatedHours, pricing).sttCost : undefined;
      if (estimatedHours > 0 && pricing) useCostsStore.getState().recordCurrent(sttDelta(estimatedHours, pricing));
      const text = response.text ?? "";
      useLlmDebugStore.getState().finish(debugId, { status: "done", response: text, cost });
      return text;
    } catch (err) {
      useLlmDebugStore.getState().finish(debugId, mediaDebugFailure(err, attemptSignal));
      throw err;
    }
  } });
  } finally {
    operation.dispose();
  }
}

export async function speakText(text: string, settings: AppSettings, options: SpeakOptions): Promise<SpeechController> {
  const operation = beginAccountScopedAiOperation(options.signal, options.accountScope);
  operation.signal.throwIfAborted();
  const voice = settings.speech.ttsVoice || "nova";
  const candidates = applySameBoundaryPolicy(settings, resolveTaskCandidates(settings, "tts"));
  if (!candidates.length) throw new Error("No text-to-speech route is configured.");
  try {
    const scopedOptions = { ...options, signal: operation.signal, accountScope: operation.accountScope };
    const controller = await executeMediaFallback<SpeechController, TaskCandidate>({ candidates, signal: operation.signal, timeoutAi: false, beforeCandidate: (candidate, index) => { if (index > 0) acknowledgeCrossBoundaryFallback({ settings, kind: "text", from: candidates[index - 1], to: candidate, accountScope: operation.accountScope }); }, runBrowser: () => speakWithBrowser(text, settings.speech.ttsVoice, settings.speech.ttsRate, settings.ui.language, scopedOptions), runAi: async (_candidate, _attemptSignal, candidateIndex) => {
        return speakWithOpenAICompatible(text, settings, candidates, candidateIndex, voice, scopedOptions, (startIndex) => speakWithBrowser(text, settings.speech.ttsVoice, settings.speech.ttsRate, settings.ui.language, { ...scopedOptions, startIndex }));
    } });
    void controller.done.then(operation.dispose, operation.dispose);
    return controller;
  } catch (error) {
    operation.dispose();
    throw error;
  }
}

function createAudioClient(integration: AIIntegration): AzureOpenAI | OpenAI {
  return integration.provider === "azure_openai"
    ? new AzureOpenAI({ endpoint: integration.endpoint ?? "", apiKey: integration.apiKey, apiVersion: integration.apiVersion || "2024-10-21", dangerouslyAllowBrowser: true })
    : new OpenAI({ apiKey: integration.apiKey, baseURL: integration.endpoint || "https://api.openai.com/v1", dangerouslyAllowBrowser: true });
}

function detectSpeechLang(text: string, uiLanguage: string): string {
  const sample = text.slice(0, 600).toLowerCase();
  const italianHints = /\b(che|non|più|perché|gli|della|sono|questo|quando|anche|già|però|cosa|essere|nella|sulla|tra|fra|verso)\b/g;
  const englishHints = /\b(the|and|that|with|this|from|have|which|would|there|about|their|because|into|been)\b/g;
  const italianScore = (sample.match(italianHints) ?? []).length + (sample.match(/[àèéìòù]/g) ?? []).length;
  const englishScore = (sample.match(englishHints) ?? []).length;
  if (italianScore > englishScore) return "it-IT";
  if (englishScore > italianScore) return "en-US";
  return uiLanguage === "it" ? "it-IT" : "en-US";
}

async function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const existing = window.speechSynthesis.getVoices();
  if (existing.length) return existing;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.onvoiceschanged = finish;
    window.setTimeout(finish, 500);
  });
}

function pickVoice(voices: SpeechSynthesisVoice[], voiceName: string, lang: string): SpeechSynthesisVoice | undefined {
  const langPrefix = lang.slice(0, 2).toLowerCase();
  const wanted = voiceName?.trim().toLowerCase();
  const byExactName = wanted ? voices.find((entry) => entry.name.toLowerCase() === wanted) : undefined;
  if (byExactName && byExactName.lang.toLowerCase().startsWith(langPrefix)) return byExactName;
  const byNameInLang = wanted ? voices.find((entry) => entry.name.toLowerCase().includes(wanted) && entry.lang.toLowerCase().startsWith(langPrefix)) : undefined;
  if (byNameInLang) return byNameInLang;
  const googleInLang = voices.find((entry) => entry.lang.toLowerCase().startsWith(langPrefix) && entry.name.toLowerCase().includes("google"));
  if (googleInLang) return googleInLang;
  const anyInLang = voices.find((entry) => entry.lang.toLowerCase().startsWith(langPrefix));
  if (anyInLang) return anyInLang;
  return byExactName;
}

function resolveSegments(text: string, options: SpeakOptions): string[] {
  if (options.segments && options.segments.length) return options.segments;
  return splitSpeechText(text);
}

async function speakWithBrowser(text: string, voiceName: string, rate: number, uiLanguage: string, options: SpeakOptions): Promise<SpeechController> {
  const segments = resolveSegments(text, options);
  const lang = detectSpeechLang(text, uiLanguage);
  const voices = await loadVoices();
  options.signal?.throwIfAborted();
  const voice = pickVoice(voices, voiceName, lang);
  let stopped = false;
  let paused = false;
  let currentIndex = Math.max(0, options.startIndex ?? 0);
  window.speechSynthesis.cancel();
  let resolveDone: () => void = () => undefined;
  let rejectDone: (error: unknown) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  let settled = false;
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    if (error !== undefined) {
      rejectDone(error);
      options.onError?.(error);
    } else {
      resolveDone();
    }
  };

  const play = (index: number) => {
    currentIndex = index;
    if (stopped || index >= segments.length) {
      finish();
      return;
    }
    options.onSegment?.(index);
    const utterance = new SpeechSynthesisUtterance(segments[index]);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang ?? lang;
    utterance.rate = Number.isFinite(rate) ? rate : 0.95;
    utterance.onend = () => { if (!stopped) play(index + 1); };
    utterance.onerror = (event) => {
      if (stopped) return;
      stopped = true;
      finish(new Error(`Browser speech playback failed: ${event.error}`));
    };
    window.speechSynthesis.speak(utterance);
  };
  play(currentIndex);
  const controller: SpeechController = {
    stop: () => {
      stopped = true;
      window.speechSynthesis.cancel();
      finish();
    },
    pause: () => {
      if (stopped || paused) return;
      paused = true;
      window.speechSynthesis.pause();
    },
    resume: () => {
      if (stopped || !paused) return;
      paused = false;
      window.speechSynthesis.resume();
    },
    isPaused: () => paused,
    segments,
    getCurrentIndex: () => currentIndex,
    done,
  };
  const abort = () => controller.stop();
  options.signal?.addEventListener("abort", abort, { once: true });
  const cleanupAbort = () => options.signal?.removeEventListener("abort", abort);
  void done.then(cleanupAbort, cleanupAbort);
  return controller;
}

async function speakWithOpenAICompatible(text: string, settings: AppSettings, candidates: TaskCandidate[], candidateIndex: number, voice: string, options: SpeakOptions, browserFallback: (startIndex: number) => Promise<SpeechController>): Promise<SpeechController> {
  const segments = resolveSegments(text, options);
  const startIndex = Math.max(0, options.startIndex ?? 0);
  let stopped = false;
  let paused = false;
  let currentIndex = startIndex;
  let audio: HTMLAudioElement | null = null;
  let browserController: SpeechController | null = null;
  const activeUrls = new Set<string>();
  const pendingDebug = new Map<string, { id: string; chars: number; cost?: number }>();
  const synthesisController = new AbortController();
  const abortSynthesis = () => synthesisController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortSynthesis, { once: true });
  // Set when a pause arrives between "fetch" and "play": resume() will start it.
  let heldPlay: (() => void) | null = null;
  options.signal?.throwIfAborted();
  const synthesize = async (segment: string, allowFallback = true): Promise<string> => {
    const attempts = allowFallback ? candidates.slice(candidateIndex) : [candidates[candidateIndex]];
    return executeMediaFallback<string, TaskCandidate>({ candidates: attempts, signal: synthesisController.signal, beforeCandidate: (candidate, index) => { if (index > 0) acknowledgeCrossBoundaryFallback({ settings, kind: "text", from: attempts[index - 1], to: candidate, accountScope: options.accountScope }); }, runBrowser: async () => BROWSER_TTS_FALLBACK, runAi: async (candidate, attemptSignal, relativeIndex) => {
      const integration = candidate.integration as AIIntegration;
      const model = candidate.model!;
      const absoluteIndex = allowFallback ? candidateIndex + relativeIndex : candidateIndex;
      const pricing = candidate.pricing ?? integration.pricing;
      const debugId = useLlmDebugStore.getState().begin({ kind: "tts", contentKinds: ["text"], label: `tts (${voice})`, model, provider: integration.provider, integrationId: integration.id, routeCandidateIndex: absoluteIndex, usedFallback: absoluteIndex > 0, messages: [{ role: "input", content: segment.slice(0, 400) }] });
      let url: string;
      try {
        url = await synthesizeChunk(segment, integration, model, voice, attemptSignal);
      } catch (error) {
        useLlmDebugStore.getState().finish(debugId, mediaDebugFailure(error, attemptSignal));
        throw error;
      }
      const cost = pricing ? ttsDelta(segment.length, pricing).ttsCost : undefined;
      if (pricing) useCostsStore.getState().recordCurrent(ttsDelta(segment.length, pricing));
      if (stopped || synthesisController.signal.aborted) {
        URL.revokeObjectURL(url);
        useLlmDebugStore.getState().finish(debugId, { status: "done", response: `${segment.length} generated chars, 0 played chars`, cost });
        throw synthesisController.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      activeUrls.add(url);
      pendingDebug.set(url, { id: debugId, chars: segment.length, cost });
      return url;
    } });
  };
  const finishChunkDebug = (url: string, played: boolean, error?: unknown) => {
    const debug = pendingDebug.get(url);
    if (!debug) return;
    pendingDebug.delete(url);
    useLlmDebugStore.getState().finish(debug.id, error === undefined
      ? { status: "done", response: `${debug.chars} generated chars, ${played ? debug.chars : 0} played chars`, cost: debug.cost }
      : { status: "error", error: error instanceof Error ? error.message : String(error), response: `${debug.chars} generated chars, 0 played chars`, cost: debug.cost });
  };
  type SynthesisResult = { url: string } | { error: unknown };
  const queuedSynthesis = (segment: string): Promise<SynthesisResult> => synthesize(segment).then(
    (url) => ({ url }),
    (error: unknown) => ({ error }),
  );
  let initialUrl: string;
  try {
    initialUrl = await synthesize(segments[startIndex] ?? text.slice(0, 200), false);
  } catch (error) {
    options.signal?.removeEventListener("abort", abortSynthesis);
    throw error;
  }
  let nextPromise: Promise<SynthesisResult> | null = Promise.resolve({ url: initialUrl });
  let resolveDone: () => void = () => undefined;
  let rejectDone: (error: unknown) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  let settled = false;
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    stopped = true;
    heldPlay = null;
    synthesisController.abort();
    options.signal?.removeEventListener("abort", abortSynthesis);
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    for (const url of activeUrls) {
      finishChunkDebug(url, false);
      URL.revokeObjectURL(url);
    }
    activeUrls.clear();
    if (error !== undefined) {
      rejectDone(error);
      options.onError?.(error);
    } else {
      resolveDone();
    }
  };

  const playNext = async (index: number): Promise<void> => {
    currentIndex = index;
    if (stopped || index >= segments.length || !nextPromise) {
      finish();
      return;
    }
    const result = await nextPromise;
    if ("error" in result) {
      finish(result.error);
      return;
    }
    const { url } = result;
    if (url === BROWSER_TTS_FALLBACK) {
      browserController = await browserFallback(index);
      void browserController.done.then(() => finish(), finish);
      return;
    }
    // Prefetch the following segment, but never while paused (freezes mp3 generation too).
    nextPromise = !paused && segments[index + 1] ? queuedSynthesis(segments[index + 1]) : null;
    if (stopped) {
      URL.revokeObjectURL(url);
      activeUrls.delete(url);
      finish();
      return;
    }
    audio = new Audio(url);
    audio.onended = () => {
      finishChunkDebug(url, true);
      URL.revokeObjectURL(url);
      activeUrls.delete(url);
      if (!paused) void playNext(index + 1).catch(finish);
      // If paused exactly at the boundary, resume() advances to index + 1.
    };
    audio.onerror = () => {
      const error = new Error(`Audio playback failed for segment ${index + 1}.`);
      finishChunkDebug(url, false, error);
      finish(error);
    };
    const start = () => {
      options.onSegment?.(index);
      void audio?.play().catch((error) => {
        finishChunkDebug(url, false, error);
        finish(error);
      });
    };
    if (paused) {
      // Hold this segment until resume() is called.
      heldPlay = start;
      return;
    }
    start();
  };

  void playNext(startIndex).catch(finish);
  const controller: SpeechController = {
    stop: () => {
      window.speechSynthesis.cancel();
      browserController?.stop();
      finish();
    },
    pause: () => {
      if (stopped || paused) return;
      paused = true;
      audio?.pause();
      browserController?.pause();
    },
    resume: () => {
      if (stopped || !paused) return;
      paused = false;
      if (browserController) {
        browserController.resume();
        return;
      }
      // Re-arm prefetch of the upcoming segment if it was suppressed during pause.
      if (!nextPromise && segments[currentIndex + 1]) {
        nextPromise = queuedSynthesis(segments[currentIndex + 1]);
      }
      if (heldPlay) {
        const run = heldPlay;
        heldPlay = null;
        run();
        return;
      }
      if (audio && audio.ended) {
        void playNext(currentIndex + 1).catch(finish);
        return;
      }
      void audio?.play().catch(finish);
    },
    isPaused: () => paused,
    segments,
    getCurrentIndex: () => browserController?.getCurrentIndex() ?? currentIndex,
    done,
  };
  const abort = () => controller.stop();
  options.signal?.addEventListener("abort", abort, { once: true });
  const cleanupAbort = () => options.signal?.removeEventListener("abort", abort);
  void done.then(cleanupAbort, cleanupAbort);
  return controller;
}

async function synthesizeChunk(text: string, integration: AIIntegration, model: string, voice: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const client = createAudioClient(integration);
  const response = await client.audio.speech.create({ model, voice: voice || "nova", input: text, response_format: "mp3" } as never, { signal });
  signal?.throwIfAborted();
  const blob = new Blob([await response.arrayBuffer()], { type: "audio/mpeg" });
  signal?.throwIfAborted();
  return URL.createObjectURL(blob);
}

function mediaDebugFailure(error: unknown, signal?: AbortSignal): { status: "error"; error: string; failureKind: "timeout" | "cancelled" | "provider"; timeoutMs?: number } {
  const converted = signal?.reason instanceof CandidateTimeoutError ? signal.reason : error;
  if (converted instanceof CandidateTimeoutError) return { status: "error", error: converted.message, failureKind: "timeout", timeoutMs: converted.timeoutMs };
  const cancelled = signal?.aborted === true;
  return { status: "error", error: converted instanceof Error ? converted.message : String(converted), failureKind: cancelled ? "cancelled" : "provider" };
}

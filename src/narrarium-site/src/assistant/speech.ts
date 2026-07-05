import OpenAI, { AzureOpenAI } from "openai";
import type { AIIntegration, AppSettings } from "@/types/settings";
import { resolveWritingIntegration } from "@/assistant/llm";
import { resolveTaskCandidates } from "@/assistant/router";
import { sttDelta, ttsDelta, useCostsStore } from "@/costs/costsStore";
import { useLlmDebugStore } from "@/debug/llmDebugStore";

const MAX_TTS_CHARS = 1200;

/** Options shared by every TTS engine. */
export interface SpeakOptions {
  /** Pre-computed reading units ("strofe"). When omitted they are derived from the text. */
  segments?: string[];
  /** Index of the first segment to read (used to resume after a pause or rewrite). */
  startIndex?: number;
  /** Fired right before a segment starts playing, with its index in `segments`. */
  onSegment?: (index: number) => void;
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

export async function transcribeAudio(blob: Blob, settings: AppSettings): Promise<string> {
  const candidates = resolveTaskCandidates(settings, "stt").filter((c) => c.model);
  if (!candidates.length) throw new Error("No AI speech-to-text model is configured.");
  const sizeKb = Math.round(blob.size / 1024);
  let lastError: unknown = null;
  for (const candidate of candidates) {
    const { integration, model, pricing } = candidate;
    const file = new File([blob], "speech.webm", { type: blob.type || "audio/webm" });
    const client = createAudioClient(integration);
    const debugId = useLlmDebugStore.getState().begin({ kind: "stt", label: "stt", model, messages: [{ role: "input", content: `audio ${sizeKb} KB` }] });
    try {
      const response = await client.audio.transcriptions.create({ file, model });
      const estimatedHours = blob.size > 0 ? blob.size / (16000 * 3600) : 0;
      const cost = pricing ? sttDelta(estimatedHours, pricing).sttCost : undefined;
      if (estimatedHours > 0 && pricing) useCostsStore.getState().recordCurrent(sttDelta(estimatedHours, pricing));
      const text = response.text ?? "";
      useLlmDebugStore.getState().finish(debugId, { status: "done", response: text, cost });
      return text;
    } catch (err) {
      useLlmDebugStore.getState().finish(debugId, { status: "error", error: err instanceof Error ? err.message : String(err) });
      lastError = err;
      // try next fallback candidate
    }
  }
  throw lastError ?? new Error("Speech-to-text failed.");
}

export async function speakText(text: string, settings: AppSettings, options: SpeakOptions = {}): Promise<SpeechController> {
  if (settings.speech.ttsProvider === "ai") {
    const voice = settings.speech.ttsVoice || "nova";
    const candidates = resolveTaskCandidates(settings, "tts").filter((c) => c.model);
    const segments = resolveSegments(text, options);
    const probeText = segments[Math.max(0, options.startIndex ?? 0)] ?? text.slice(0, 200);
    for (const candidate of candidates) {
      try {
        // Probe: synthesize the first segment to confirm this provider works before committing.
        const probeUrl = await synthesizeChunk(probeText, candidate.integration, candidate.model, voice);
        try { URL.revokeObjectURL(probeUrl); } catch { /* ignore */ }
        return speakWithOpenAICompatible(text, candidate.integration, candidate.model, voice, options, candidate.pricing);
      } catch {
        // try next TTS fallback candidate
      }
    }
    // All AI candidates failed → browser fallback.
  }
  return speakWithBrowser(text, settings.speech.ttsVoice, settings.speech.ttsRate, settings.ui.language, options);
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
  const voice = pickVoice(voices, voiceName, lang);
  let stopped = false;
  let paused = false;
  let currentIndex = Math.max(0, options.startIndex ?? 0);
  window.speechSynthesis.cancel();
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  const play = (index: number) => {
    currentIndex = index;
    if (stopped || index >= segments.length) {
      resolveDone();
      return;
    }
    options.onSegment?.(index);
    const utterance = new SpeechSynthesisUtterance(segments[index]);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang ?? lang;
    utterance.rate = Number.isFinite(rate) ? rate : 0.95;
    utterance.onend = () => { if (!stopped) play(index + 1); };
    utterance.onerror = () => { if (!stopped) play(index + 1); };
    window.speechSynthesis.speak(utterance);
  };
  play(currentIndex);
  return {
    stop: () => {
      stopped = true;
      window.speechSynthesis.cancel();
      resolveDone();
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
}

async function speakWithOpenAICompatible(text: string, integration: AIIntegration, model: string, voice: string, options: SpeakOptions, pricingOverride?: import("@/types/settings").AIPricing): Promise<SpeechController> {
  const segments = resolveSegments(text, options);
  const startIndex = Math.max(0, options.startIndex ?? 0);
  const pricing = pricingOverride ?? integration.pricing;
  const ttsChars = segments.slice(startIndex).reduce((sum, chunk) => sum + chunk.length, 0);
  if (ttsChars > 0) {
    if (pricing) useCostsStore.getState().recordCurrent(ttsDelta(ttsChars, pricing));
    const cost = pricing ? ttsDelta(ttsChars, pricing).ttsCost : undefined;
    const preview = segments.slice(startIndex).join(" ").slice(0, 400);
    const ttsId = useLlmDebugStore.getState().begin({ kind: "tts", label: `tts (${voice})`, model, messages: [{ role: "input", content: preview }] });
    useLlmDebugStore.getState().finish(ttsId, { status: "done", response: `${ttsChars} chars`, cost });
  }
  let stopped = false;
  let paused = false;
  let currentIndex = startIndex;
  let audio: HTMLAudioElement | null = null;
  // Set when a pause arrives between "fetch" and "play": resume() will start it.
  let heldPlay: (() => void) | null = null;
  let nextPromise: Promise<string> | null = segments[startIndex] ? synthesizeChunk(segments[startIndex], integration, model, voice) : null;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  const playNext = async (index: number): Promise<void> => {
    currentIndex = index;
    if (stopped || index >= segments.length || !nextPromise) {
      resolveDone();
      return;
    }
    const url = await nextPromise;
    // Prefetch the following segment, but never while paused (freezes mp3 generation too).
    nextPromise = !paused && segments[index + 1] ? synthesizeChunk(segments[index + 1], integration, model, voice) : null;
    if (stopped) {
      URL.revokeObjectURL(url);
      resolveDone();
      return;
    }
    audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (!paused) void playNext(index + 1);
      // If paused exactly at the boundary, resume() advances to index + 1.
    };
    const start = () => {
      options.onSegment?.(index);
      void audio?.play().catch(() => {
        URL.revokeObjectURL(url);
        void playNext(index + 1);
      });
    };
    if (paused) {
      // Hold this segment until resume() is called.
      heldPlay = start;
      return;
    }
    start();
  };

  void playNext(startIndex);
  return {
    stop: () => {
      stopped = true;
      heldPlay = null;
      if (audio) audio.pause();
      window.speechSynthesis.cancel();
      resolveDone();
    },
    pause: () => {
      if (stopped || paused) return;
      paused = true;
      audio?.pause();
    },
    resume: () => {
      if (stopped || !paused) return;
      paused = false;
      // Re-arm prefetch of the upcoming segment if it was suppressed during pause.
      if (!nextPromise && segments[currentIndex + 1]) {
        nextPromise = synthesizeChunk(segments[currentIndex + 1], integration, model, voice);
      }
      if (heldPlay) {
        const run = heldPlay;
        heldPlay = null;
        run();
        return;
      }
      if (audio && audio.ended) {
        void playNext(currentIndex + 1);
        return;
      }
      void audio?.play().catch(() => { void playNext(currentIndex + 1); });
    },
    isPaused: () => paused,
    segments,
    getCurrentIndex: () => currentIndex,
    done,
  };
}

async function synthesizeChunk(text: string, integration: AIIntegration, model: string, voice: string): Promise<string> {
  const client = createAudioClient(integration);
  const response = await client.audio.speech.create({ model, voice: voice || "nova", input: text, response_format: "mp3" } as never);
  const blob = new Blob([await response.arrayBuffer()], { type: "audio/mpeg" });
  return URL.createObjectURL(blob);
}

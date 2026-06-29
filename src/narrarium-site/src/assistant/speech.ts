import OpenAI, { AzureOpenAI } from "openai";
import type { AIIntegration, AppSettings } from "@/types/settings";
import { resolveWritingIntegration } from "@/assistant/llm";
import { sttDelta, ttsDelta, useCostsStore } from "@/costs/costsStore";

const MAX_TTS_CHARS = 1200;

export interface SpeechController {
  stop: () => void;
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
  if (!integration || integration.provider === "m365_copilot") return null;
  if (!integration.apiKey) return null;
  return integration;
}

export async function transcribeAudio(blob: Blob, settings: AppSettings): Promise<string> {
  const integration = getSpeechIntegration(settings);
  const model = integration?.modelSpeechToText?.trim();
  if (!integration || !model) throw new Error("No AI speech-to-text model is configured.");
  const file = new File([blob], "speech.webm", { type: blob.type || "audio/webm" });
  const client = createAudioClient(integration);
  const response = await client.audio.transcriptions.create({ file, model });
  // Rough minute estimate from compressed audio size (~16KB/s typical webm/opus voice).
  const estimatedMinutes = blob.size > 0 ? blob.size / (16000 * 60) : 0;
  if (estimatedMinutes > 0) useCostsStore.getState().recordCurrent(sttDelta(estimatedMinutes, integration.pricing));
  return response.text ?? "";
}

export async function speakText(text: string, settings: AppSettings): Promise<SpeechController> {
  const integration = getSpeechIntegration(settings);
  const ttsModel = integration?.modelTextToSpeech?.trim();
  if (settings.speech.ttsProvider === "ai" && integration && ttsModel) {
    return speakWithOpenAICompatible(text, integration, ttsModel, settings.speech.ttsVoice || "nova");
  }
  return speakWithBrowser(text, settings.speech.ttsVoice, settings.speech.ttsRate, settings.ui.language);
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

async function speakWithBrowser(text: string, voiceName: string, rate: number, uiLanguage: string): Promise<SpeechController> {
  const chunks = splitSpeechText(text);
  const lang = detectSpeechLang(text, uiLanguage);
  const voices = await loadVoices();
  const voice = pickVoice(voices, voiceName, lang);
  let stopped = false;
  window.speechSynthesis.cancel();
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  const play = (index: number) => {
    if (stopped || index >= chunks.length) {
      resolveDone();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(chunks[index]);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang ?? lang;
    utterance.rate = Number.isFinite(rate) ? rate : 0.95;
    utterance.onend = () => play(index + 1);
    utterance.onerror = () => play(index + 1);
    window.speechSynthesis.speak(utterance);
  };
  play(0);
  return {
    stop: () => {
    stopped = true;
    window.speechSynthesis.cancel();
    resolveDone();
    },
    done,
  };
}

async function speakWithOpenAICompatible(text: string, integration: AIIntegration, model: string, voice: string): Promise<SpeechController> {
  const chunks = splitSpeechText(text);
  const ttsChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (ttsChars > 0) useCostsStore.getState().recordCurrent(ttsDelta(ttsChars, integration.pricing));
  let stopped = false;
  let audio: HTMLAudioElement | null = null;
  let nextPromise: Promise<string> | null = chunks[0] ? synthesizeChunk(chunks[0], integration, model, voice) : null;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  const playNext = async (index: number): Promise<void> => {
    if (stopped || index >= chunks.length || !nextPromise) {
      resolveDone();
      return;
    }
    const url = await nextPromise;
    nextPromise = chunks[index + 1] ? synthesizeChunk(chunks[index + 1], integration, model, voice) : null;
    if (stopped) {
      URL.revokeObjectURL(url);
      resolveDone();
      return;
    }
    audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      void playNext(index + 1);
    };
    await audio.play().catch(() => {
      URL.revokeObjectURL(url);
      void playNext(index + 1);
    });
  };

  void playNext(0);
  return {
    stop: () => {
      stopped = true;
      if (audio) audio.pause();
      window.speechSynthesis.cancel();
      resolveDone();
    },
    done,
  };
}

async function synthesizeChunk(text: string, integration: AIIntegration, model: string, voice: string): Promise<string> {
  const client = createAudioClient(integration);
  const response = await client.audio.speech.create({ model, voice: voice || "nova", input: text, response_format: "mp3" } as never);
  const blob = new Blob([await response.arrayBuffer()], { type: "audio/mpeg" });
  return URL.createObjectURL(blob);
}

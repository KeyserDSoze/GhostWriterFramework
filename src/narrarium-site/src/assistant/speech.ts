import OpenAI, { AzureOpenAI } from "openai";
import type { AIIntegration, AppSettings } from "@/types/settings";
import { resolveWritingIntegration } from "@/assistant/llm";

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
  return response.text ?? "";
}

export async function speakText(text: string, settings: AppSettings): Promise<SpeechController> {
  const integration = getSpeechIntegration(settings);
  const ttsModel = integration?.modelTextToSpeech?.trim();
  if (settings.speech.ttsProvider === "ai" && integration && ttsModel) {
    return speakWithOpenAICompatible(text, integration, ttsModel, settings.speech.ttsVoice || "nova");
  }
  return speakWithBrowser(text, settings.speech.ttsVoice, settings.speech.ttsRate);
}

function createAudioClient(integration: AIIntegration): AzureOpenAI | OpenAI {
  return integration.provider === "azure_openai"
    ? new AzureOpenAI({ endpoint: integration.endpoint ?? "", apiKey: integration.apiKey, apiVersion: integration.apiVersion || "2024-10-21", dangerouslyAllowBrowser: true })
    : new OpenAI({ apiKey: integration.apiKey, baseURL: integration.endpoint || "https://api.openai.com/v1", dangerouslyAllowBrowser: true });
}

async function speakWithBrowser(text: string, voiceName: string, rate: number): Promise<SpeechController> {
  const chunks = splitSpeechText(text);
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
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find((entry) => entry.name === voiceName || entry.lang.toLowerCase().startsWith(voiceName.toLowerCase()));
    if (voice) utterance.voice = voice;
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

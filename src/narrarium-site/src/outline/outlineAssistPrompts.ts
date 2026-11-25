import { z } from "zod";
import { clipMiddle, type OutlineChapterEntry } from "narrarium-engine";
import { currentRequest, untrustedData } from "@/assistant/promptTrust";
import { completeTextRouted } from "@/assistant/router";
import type { LlmMessage } from "@/assistant/llm";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import type { AppSettings, ChatCapability } from "@/types/settings";

/**
 * What the assistant of the Outline's text areas sends to a model. The texts of the book are data, never instructions (`untrustedData`); a
 * request asks for a plan, not for prose, and in the language of the book. Nothing here writes: the page shows the answer, and the author applies it.
 */

/** Characters of the description of the book, of one nearby entry and of one canon file in a request. */
const DESCRIPTION_CHARS = 3000;
const NEARBY_CHARS = 1200;
const CANON_CHARS = 1500;
/** Nearby entries on each side of the one at hand. */
export const NEARBY_ENTRIES = 3;

export interface OutlineAssistContext {
  /** The language of the book (`it`, `en`…). */
  language: string;
  bookTitle: string;
  description: string;
  /** The entry at hand, with the text the author sees now (saved or not). */
  number: number;
  title: string;
  body: string;
  /** The entries around it, as they are now. */
  nearby: ReadonlyArray<Pick<OutlineChapterEntry, "number" | "title" | "body">>;
  /** Canon files the entry and its neighbours mention, with their text. */
  canon: ReadonlyArray<{ path: string; content: string }>;
}

function entryLine(entry: Pick<OutlineChapterEntry, "number" | "title" | "body">, chars: number): string {
  return `Chapter ${entry.number}${entry.title.trim() ? ` — ${entry.title.trim()}` : ""}:\n${clipMiddle(entry.body.trim(), chars) || "(no text yet)"}`;
}

function contextBlock(context: OutlineAssistContext): string {
  const before = context.nearby.filter((entry) => entry.number < context.number);
  const after = context.nearby.filter((entry) => entry.number > context.number);
  return [
    `BOOK: ${context.bookTitle || "(untitled)"} (language: ${context.language || "unknown"})`,
    `DESCRIPTION OF THE BOOK (the outline's own):\n${clipMiddle(context.description.trim(), DESCRIPTION_CHARS) || "(none)"}`,
    before.length ? `CHAPTERS BEFORE IN THE OUTLINE:\n${before.map((entry) => entryLine(entry, NEARBY_CHARS)).join("\n\n")}` : "",
    after.length ? `CHAPTERS AFTER IN THE OUTLINE:\n${after.map((entry) => entryLine(entry, NEARBY_CHARS)).join("\n\n")}` : "",
    context.canon.length ? `CANON THE CHAPTERS MENTION:\n${context.canon.map((file) => `FILE ${file.path}:\n${clipMiddle(file.content.trim(), CANON_CHARS)}`).join("\n\n")}` : "",
    `THE ENTRY OF CHAPTER ${context.number}${context.title.trim() ? ` — ${context.title.trim()}` : ""}:\n${context.body.trim() || "(no text yet)"}`,
  ].filter(Boolean).join("\n\n");
}

const PLAN_RULES = "An entry of the outline is a plan in plain text: what happens in the chapter, its events and key points, short paragraphs or a list. It is not prose: no dialogue, no scenes written out, no markdown headings.";

function languageRule(language: string): string {
  return language ? `Write in the language of the book (${language}).` : "Write in the language the entry is written in.";
}

/** «Develop this chapter»: events and key points consistent with the description, the nearby entries and the canon, keeping what the entry says. */
export function developMessages(context: OutlineAssistContext): LlmMessage[] {
  return [
    { role: "system", content: `You help an author plan a book in Narrarium. You develop one entry of the book's outline (the Synopsis). ${PLAN_RULES} Keep every event, name and fact the entry already has; add what makes the chapter work (the events that lead from the previous chapter to the next, the turning point, who is there and what changes), consistent with the description of the book, the nearby chapters and the canon, never contradicting them, and do not reveal what the nearby chapters keep for later. ${languageRule(context.language)} Return only the new text of the entry.` },
    { role: "user", content: `${currentRequest(`Develop the entry of chapter ${context.number}.`)}\n\n${untrustedData("repository_content", contextBlock(context))}` },
  ];
}

export const checkOutputSchema = z.object({
  issues: z.array(z.string()).max(30),
  revised: z.string().max(40_000).default(""),
});

export type OutlineCheck = z.infer<typeof checkOutputSchema>;

/** «Check against the canon and the nearby chapters»: the inconsistencies, and a corrected text only when one is needed. */
export function checkMessages(context: OutlineAssistContext): LlmMessage[] {
  return [
    { role: "system", content: `You check one entry of a book's outline (the Synopsis) in Narrarium. ${PLAN_RULES} Find what does not hold: contradictions with the canon, with the description of the book or with the nearby chapters; events out of order; characters, places or objects that cannot be there; a reveal that comes too early. Each issue is one short sentence that names what clashes with what. When the entry has issues, also write a corrected text of the entry that keeps everything else; when it has none, return no issues and an empty revised text. ${languageRule(context.language)} Return ONLY JSON: {"issues":["…"],"revised":"…"}.` },
    { role: "user", content: `${currentRequest(`Check the entry of chapter ${context.number}.`)}\n\n${untrustedData("repository_content", contextBlock(context))}` },
  ];
}

/** «Improve» on an entry (or on the selected part of it): clearer and more concrete, still a plan. */
export function improveMessages(context: OutlineAssistContext, selection: string | null): LlmMessage[] {
  return [
    { role: "system", content: `You improve the text of one entry of a book's outline (the Synopsis) in Narrarium. ${PLAN_RULES} Make the selected text clearer and more concrete, keep every event, name and fact, invent nothing that the description or the nearby chapters contradict. ${languageRule(context.language)} Return only the improved text${selection ? " of the selection" : ""}.` },
    { role: "user", content: `${currentRequest(selection ? "Improve the selected text of the entry." : "Improve the text of the entry.")}\n\n${untrustedData("repository_content", `${contextBlock(context)}${selection ? `\n\nSELECTED TEXT:\n${selection}` : ""}`)}` },
  ];
}

/** «Summarize» an entry (or the selected part of it) into a few sentences. */
export function summarizeMessages(context: OutlineAssistContext, selection: string | null): LlmMessage[] {
  return [
    { role: "system", content: `You summarize the text of one entry of a book's outline (the Synopsis) in Narrarium into two or three concise sentences that keep the events that matter. ${languageRule(context.language)} Return only the summary.` },
    { role: "user", content: `${currentRequest("Summarize the text of the entry.")}\n\n${untrustedData("repository_content", selection ?? context.body)}` },
  ];
}

/** Sends one of these requests through the AI router, for the task given; the data in them is already framed as data. */
export function completeOutlineRequest(settings: AppSettings, messages: LlmMessage[], capability: ChatCapability, label: string, signal?: AbortSignal): Promise<string> {
  return completeTextRouted(settings, messages, capability, { accountScope: localWorkspaceScope(), signal, label });
}

/** «Improve» and «Summarize» on the description of the book. */
export function descriptionMessages(kind: "improve" | "summarize", input: { language: string; bookTitle: string; body: string; selection: string | null }): LlmMessage[] {
  const task = kind === "improve"
    ? "Improve the selected text of the rough description of a book (the head of its outline, the Synopsis): clearer and more concrete, keeping every fact. Return only the improved text."
    : "Summarize the rough description of a book (the head of its outline, the Synopsis) into a few concise sentences. Return only the summary.";
  return [
    { role: "system", content: `You help an author plan a book in Narrarium. ${task} ${languageRule(input.language)}` },
    { role: "user", content: `${currentRequest(kind === "improve" ? "Improve the description of the book." : "Summarize the description of the book.")}\n\n${untrustedData("repository_content", `BOOK: ${input.bookTitle}\n\nDESCRIPTION:\n${input.body}${input.selection ? `\n\nSELECTED TEXT:\n${input.selection}` : ""}`)}` },
  ];
}

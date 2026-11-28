import { isItalian, loadBookSnapshot, type WildcardPresetId, type WildcardProfile } from "narrarium-engine";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import type { AssistantMessage } from "@/assistant/store";
import { openWildcardsDialog, type WildcardsTarget } from "@/store/wildcardsDialogStore";
import type { AppSettings, BookEntry } from "@/types/settings";
import { consultBookRoom } from "@/wildcards/roomRunner";
import { roomTranscript } from "@/wildcards/roomText";
import { loadWildcardRoom } from "@/wildcards/wildcardFiles";
import type { BookStructure } from "@/types/book";

/**
 * «What do the provocateurs think of this chapter?»: the Copilot asks the room about the chapter or the scene it is on, the voices the request names (the
 * provocateurs, the sentinels, a pre-mortem, wildcards by name; the creative room otherwise). Their answers are in the chat, each as its own character, and
 * in the table of the ideas, where the author accepts or skips them and applies them in one go: nothing is applied by the answer itself.
 */

export interface CopilotRoomInput {
  prompt: string;
  settings: AppSettings;
  book: BookEntry;
  branch: string;
  structure: BookStructure | null;
  token: string;
  accountScope: string | null;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  /** The chapter (its slug) and the scene (its slug) the request is about, as the Copilot resolved them. */
  chapterSlug?: string;
  paragraphSlug?: string;
}

const SENTINELS = /(?<![\p{L}])(?:sentinel(?:s|le|la)?|controll[io] di qualit[àa]|quality check|continuit[yà]|spoiler)(?![\p{L}])/iu;
const PRE_MORTEM = /(?<![\p{L}])(?:pre-?mortem|devil'?s advocate|avvocato del diavolo|why (?:it|the book) (?:will )?fail|perch[ée] (?:il libro )?fallir)/iu;

/** The voices a request names: wildcards by name, else a preset its words say, else the creative room. */
export function voicesOfPrompt(prompt: string, room: readonly WildcardProfile[]): { voices?: string[]; preset?: WildcardPresetId } {
  const lower = prompt.toLowerCase();
  const named = room.filter((profile) => profile.enabled && profile.name.trim().length > 3 && lower.includes(profile.name.toLowerCase().replace(/^(the|il|lo|la|l'|i|gli|le)\s+/i, "")));
  if (named.length) return { voices: named.map((profile) => profile.slug) };
  if (PRE_MORTEM.test(prompt)) return { preset: "pre-mortem" };
  if (SENTINELS.test(prompt)) return { preset: "quality-check" };
  return { preset: "creative-room" };
}

function reply(text: string): AssistantMessage {
  return { id: crypto.randomUUID(), role: "assistant", text };
}

export async function askWildcardsFromPrompt(input: CopilotRoomInput): Promise<AssistantMessage> {
  const italian = isItalian(input.structure?.language || input.settings.ui.language);
  if (!input.chapterSlug) return reply(italian ? "Apri un capitolo o una scena, o nominali, per chiedere ai Fuori dal coro." : "Open a chapter or a scene, or name one, to ask the wildcards.");
  const store = createBrowserBookStore(input.book, input.branch);
  const snapshot = await loadBookSnapshot(store);
  const chapter = snapshot.chapters.find((entry) => entry.slug === input.chapterSlug);
  if (!chapter) return reply(italian ? "Non trovo questo capitolo nel libro." : "This chapter is not in the book.");
  const paragraph = input.paragraphSlug ? chapter.paragraphs.find((entry) => entry.slug === input.paragraphSlug) : undefined;
  const { room } = await loadWildcardRoom({ settings: input.settings, token: input.token, book: input.book, branch: input.branch, structure: input.structure });
  const choice = voicesOfPrompt(input.prompt, room);
  const result = await consultBookRoom({
    settings: input.settings,
    book: input.book,
    branch: input.branch,
    accountScope: input.accountScope,
    snapshot,
    panel: room,
    target: paragraph ? { kind: "paragraph", chapter: chapter.number, paragraph: paragraph.number } : { kind: "chapter", chapter: chapter.number },
    ...choice,
    question: input.prompt,
    by: "copilot",
    ...(input.signal ? { signal: input.signal } : {}),
    onVoice: (event) => input.onText?.(`**${event.name}**: ${event.status}`),
  });
  const target: WildcardsTarget = paragraph ? { kind: "paragraph", chapter: chapter.slug, paragraph: paragraph.slug } : { kind: "chapter", chapter: chapter.slug };
  // The table of the ideas opens with the answer: there the author accepts or skips them, and applies them in one go.
  if (result.ideas.length) openWildcardsDialog({ bookId: input.book.id, target, result, question: input.prompt });
  const next = result.ideas.length
    ? (italian ? "Le idee sono anche nella tabella che si è aperta: lì le accetti o le scarti, e le applichi in una volta." : "The ideas are also in the table that opened: accept or skip them there, and apply them in one go.")
    : (italian ? "Nessuna voce ha dato un'idea: prova altre voci, o chiedi più tardi." : "No voice gave an idea: try other voices, or ask again later.");
  return reply(`${roomTranscript(result, italian)}\n\n${next}`);
}

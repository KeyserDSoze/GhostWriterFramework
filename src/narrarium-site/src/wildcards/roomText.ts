import type { WildcardIdea, WildcardRoomResult, WildcardVoiceResult } from "narrarium-engine";

/**
 * The room as the chat shows it: each voice as its own character (a quote with its name, then its ideas or findings), never a score; and the same as the model
 * that synthesises it reads it. The words are the language of the conversation; the voices' own texts are theirs.
 */

const WORDS = {
  en: { head: (count: number) => `**The room (Fuori dal coro): ${count} ${count === 1 ? "voice" : "voices"}**`, provocateur: "provocateur", sentinel: "sentinel", why: "Why", risk: "Risk", changes: "Changes", evidence: "Where", failed: "did not answer", skipped: "not asked: the money cap of the room was reached", omitted: (count: number) => `${count} more ${count === 1 ? "idea" : "ideas"} not shown (the most a voice gives)`, clipped: (to: number, from: number) => `The room read ${to} of the ${from} characters of the material, shortened in the middle to fit its model.`, more: (count: number) => `${count} more ${count === 1 ? "voice was" : "voices were"} not asked (8 at most).`, advisory: "_Advisory: never a score, and nothing is applied by itself._" },
  it: { head: (count: number) => `**La stanza (Fuori dal coro): ${count} ${count === 1 ? "voce" : "voci"}**`, provocateur: "provocatore", sentinel: "sentinella", why: "Perché", risk: "Rischio", changes: "Cambia", evidence: "Dove", failed: "non ha risposto", skipped: "non interpellato: raggiunto il tetto di spesa della stanza", omitted: (count: number) => `${count} ${count === 1 ? "altra idea non mostrata" : "altre idee non mostrate"} (il massimo che una voce dà)`, clipped: (to: number, from: number) => `La stanza ha letto ${to} dei ${from} caratteri del materiale, accorciato nel mezzo per stare nel suo modello.`, more: (count: number) => `${count} ${count === 1 ? "altra voce non interpellata" : "altre voci non interpellate"} (al massimo 8).`, advisory: "_Consultivo: mai un voto, e nulla viene applicato da sé._" },
};

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function ideaLines(idea: WildcardIdea, words: typeof WORDS.en, index: number): string[] {
  const details = [
    idea.why ? `_${words.why}:_ ${oneLine(idea.why)}` : "",
    idea.changes.summary ? `_${words.changes}:_ ${oneLine(idea.changes.summary)}` : "",
    idea.evidence ? `_${words.evidence}:_ ${oneLine(idea.evidence)}` : "",
    idea.risk ? `_${words.risk}:_ ${oneLine(idea.risk)}` : "",
  ].filter(Boolean).join(" · ");
  return [`> ${index + 1}. **${oneLine(idea.title)}** — ${oneLine(idea.idea)}`, ...(details ? [`>    ${details}`] : [])];
}

function voiceBlock(voice: WildcardVoiceResult, words: typeof WORDS.en): string {
  const role = voice.persona.group === "sentinel" ? words.sentinel : words.provocateur;
  if (voice.status === "skipped") return `> **${voice.persona.name}** · ${role} — ${words.skipped}`;
  if (voice.status === "failed") return `> **${voice.persona.name}** · ${role} — ${words.failed}${voice.reason ? `: ${oneLine(voice.reason)}` : ""}`;
  return [
    `> **${voice.persona.name}** · ${role}`,
    ">",
    ...voice.ideas.flatMap((idea, index) => ideaLines(idea, words, index)),
    ...(voice.omitted ? [">", `> _${words.omitted(voice.omitted)}_`] : []),
  ].join("\n");
}

/** The voices of a consultation as the chat shows them, in Markdown. */
export function roomTranscript(result: Pick<WildcardRoomResult, "voices" | "voicesOmitted" | "clipped">, italian: boolean): string {
  const words = italian ? WORDS.it : WORDS.en;
  return [
    words.head(result.voices.length),
    ...result.voices.map((voice) => voiceBlock(voice, words)),
    result.voicesOmitted ? `_${words.more(result.voicesOmitted)}_` : "",
    result.clipped ? `_${words.clipped(result.clipped.to, result.clipped.from)}_` : "",
    words.advisory,
  ].filter(Boolean).join("\n\n");
}

/** The voices as the model that synthesises them reads them: one line for each idea, by voice. */
export function roomForModel(result: Pick<WildcardRoomResult, "voices">): string {
  return result.voices.map((voice) => {
    if (voice.status !== "ok") return `VOICE ${voice.persona.name} (${voice.persona.group}): did not answer${voice.reason ? ` (${voice.reason})` : ""}.`;
    return [`VOICE ${voice.persona.name} (${voice.persona.group}):`, ...voice.ideas.map((idea, index) => `  [${index + 1}] ${oneLine(idea.title)}: ${oneLine(idea.idea)}${idea.why ? ` Why: ${oneLine(idea.why)}.` : ""}${idea.changes.summary ? ` Changes: ${oneLine(idea.changes.summary)}.` : ""}${idea.risk ? ` Risk: ${oneLine(idea.risk)}.` : ""}`)].join("\n");
  }).join("\n");
}

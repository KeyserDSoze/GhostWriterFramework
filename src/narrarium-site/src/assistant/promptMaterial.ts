/**
 * What the author asks, apart from what they pasted to be read. A long message, or the part of a message that is a document (headings, tables, lists, labels in bold,
 * many paragraphs, a fenced or a quoted block), is material: the rules that decide what to do (the intent of a change, the keywords of the tools, the rules of the
 * pages) read the instruction only, so that a sentence of the material («non ho modificato alcun file», «nessuno crea…») never decides what the author asked. The
 * instruction is the short lead-in the author typed before the document, or the lines after it, or the words outside the fenced block; the material goes to the
 * model as data. A short message is all instruction, as it always was: «non creare i capitoli» stays what it says.
 */

export interface PromptParts {
  /** What the author asks: what the rules read, and the request the model is given. `""` when the message is only material. */
  instruction: string;
  /** What the author pasted to be read, not obeyed: `""` when there is none. */
  material: string;
}

/** A message longer than this, outside its fenced and quoted blocks, is a document when it is not one plain request. */
export const MATERIAL_CHARS = 1_500;
/** The lead-in or the closing lines of a document that can be the author's instruction: longer than this, they are part of the document. */
const INSTRUCTION_CHARS = 600;
/** A long request of the author's own, in a paragraph or two of plain words, with nothing of a document: it stays a request. */
const PLAIN_REQUEST_CHARS = 4_000;

const HEADING = /^\s{0,3}#{1,6}\s+\S/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,3}[.)])\s+\S/;
const BOLD_LABEL = /^\s*\*\*[^*\n]{1,80}\*\*/;
const CHAPTER_HEADING = /^\s*(?:capitolo|chapter|cap\.)\s+(?:\d{1,4}|[ivxlc]{1,7})\b/i;

/** A line that belongs to a document: a heading, a row of a table, an item of a list, a label in bold, the heading of a chapter. */
function structural(line: string): boolean {
  return HEADING.test(line) || TABLE_ROW.test(line) || LIST_ITEM.test(line) || BOLD_LABEL.test(line) || CHAPTER_HEADING.test(line);
}

/** Whether a text is shaped like a document rather than like a request: headings, a table, labels, a list of many items, or many paragraphs. */
export function looksLikeDocument(text: string): boolean {
  const lines = text.split("\n");
  if (lines.some((line) => HEADING.test(line) || CHAPTER_HEADING.test(line))) return true;
  if (lines.filter((line) => TABLE_ROW.test(line)).length >= 2) return true;
  if (lines.filter((line) => BOLD_LABEL.test(line)).length >= 3) return true;
  if (lines.filter((line) => LIST_ITEM.test(line)).length >= 6) return true;
  return text.split(/\n[ \t]*\n/).filter((paragraph) => paragraph.trim()).length >= 5;
}

/** Words that speak to the assistant: a verb in the imperative at the start of a sentence (or after «per favore», «puoi»…), and a question to it. */
const IMPERATIVE = /(?:^|[.!?:;]\s+|,\s*|\b(?:per favore|ti prego|ora|adesso|poi|please|now|then|puoi|potresti|can you|could you|would you)\s+)(?:non\s+)?(?:crea|creami|creane|creare|fammi|fai|fare|scrivi|scrivimi|scrivere|genera|generami|aggiungi|aggiungere|usa|usalo|usala|usare|basati|segui|seguire|rispetta|trasforma|leggi|analizza|riassumi|dimmi|metti|imposta|compila|riempi|prepara|proponi|sostituisci|importa|carica|modifica|modificare|cambia|cambiare|riscrivi|tieni|considera|controlla|create|make|write|generate|add|use|follow|turn|read|analy[sz]e|summari[sz]e|tell|fill|prepare|propose|replace|import|build|change|rewrite|keep|check|don't|do not)(?![\p{L}])/iu;
/** Words that point at the pasted text, the way a request does: «questo testo», «qui sotto», «this text», «below». */
const DEICTIC = /(?<![\p{L}])(?:quest[oa]\s+(?:testo|riassunto|sinossi|documento|traccia|scaletta|materiale|analisi qui)|il testo (?:qui )?(?:sotto|sopra|seguente|incollato|allegato)|qui (?:sotto|sopra)|di seguito|seguente|incollat[oa]|basandoti|in base a|sulla base di|this (?:text|summary|synopsis|document|outline|material)|the (?:text|document|summary) (?:below|above)|the following|below|above|pasted|based on)(?![\p{L}])/iu;
const QUESTION = /(?:cosa ne pensi|che ne pensi|che cosa ne pensi|what do you think|what's your take)\b|\?\s*$/iu;
/** Words of whoever wrote the document, not of the author asking: «non ho modificato», «ho creato», «I did not change». */
const NARRATOR = /(?<![\p{L}])(?:(?:non\s+)?(?:ho|abbiamo|è stato|sono stati)\s+\p{L}+(?:at|ut|it)[oaie]|i (?:have|did|didn't|did not|made|changed|created|modified)|we (?:have|did))(?![\p{L}])/iu;

/** How much a short passage speaks to the assistant: above zero, it can be the author's instruction. */
function addressing(text: string): number {
  return (IMPERATIVE.test(text) ? 2 : 0) + (DEICTIC.test(text) ? 2 : 0) + (QUESTION.test(text) ? 1 : 0) - (NARRATOR.test(text) ? 3 : 0);
}

/** The lines that start a document before its first blank or structural line, and the ones that end it after its last: where an instruction can be. */
function edges(lines: readonly string[]): { lead: number; trail: number } {
  let lead = 0;
  while (lead < lines.length && lines[lead].trim() && !structural(lines[lead])) lead += 1;
  let trail = lines.length;
  while (trail > lead && lines[trail - 1].trim() && !structural(lines[trail - 1])) trail -= 1;
  return { lead, trail };
}

function splitDocument(text: string): PromptParts {
  const lines = text.split("\n");
  // One block of words without a line break: its first sentence may be the request («Crea i capitoli da questo testo: Capitolo 1…»).
  if (lines.length === 1) {
    const first = /^[^\n]{1,400}?[.!?:](?=\s)/.exec(text)?.[0] ?? "";
    return first && addressing(first) > 0 ? { instruction: first.trim(), material: text.slice(first.length).trim() } : { instruction: "", material: text };
  }
  const { lead, trail } = edges(lines);
  const leadText = lines.slice(0, lead).join("\n").trim();
  const trailText = trail < lines.length ? lines.slice(trail).join("\n").trim() : "";
  const takeLead = Boolean(leadText) && leadText.length <= INSTRUCTION_CHARS && addressing(leadText) > 0;
  const takeTrail = Boolean(trailText) && trail > lead && trailText.length <= INSTRUCTION_CHARS && addressing(trailText) > 0;
  const instruction = [takeLead ? leadText : "", takeTrail ? trailText : ""].filter(Boolean).join("\n");
  const material = lines.slice(takeLead ? lead : 0, takeTrail ? trail : lines.length).join("\n").trim();
  return { instruction, material };
}

/** A request of the author's own that is long but is one plain request: a paragraph or two of words, nothing of a document. */
function plainRequest(text: string): boolean {
  return text.length <= PLAIN_REQUEST_CHARS && !looksLikeDocument(text) && text.split(/\n[ \t]*\n/).filter((paragraph) => paragraph.trim()).length <= 2 && !text.split("\n").some(structural);
}

/**
 * The instruction and the material of a message. Fenced (```) and quoted (>) blocks are material wherever they are; what is left is the instruction when it is short and
 * not a document, else the lead-in and the closing lines that speak to the assistant are, and the rest is material. A message that is only a document has no instruction.
 */
export function splitPrompt(prompt: string): PromptParts {
  const text = prompt.replace(/\r\n?/g, "\n");
  const blocks: string[] = [];
  let rest = text.replace(/^```[^\n]*\n([\s\S]*?)(?:^```[ \t]*$|(?![\s\S]))/gm, (_whole, body: string) => {
    blocks.push(body.trim());
    return "\n";
  });
  rest = rest.replace(/(?:^>[^\n]*(?:\n|$))+/gm, (quote) => {
    blocks.push(quote.replace(/^> ?/gm, "").trim());
    return "\n";
  });
  rest = rest.replace(/\n{3,}/g, "\n\n").trim();
  const quoted = blocks.filter(Boolean).join("\n\n");
  if ((rest.length <= MATERIAL_CHARS && !looksLikeDocument(rest)) || plainRequest(rest)) return { instruction: blocks.length ? rest : prompt.trim(), material: quoted };
  const parts = splitDocument(rest);
  return { instruction: parts.instruction, material: [parts.material, quoted].filter(Boolean).join("\n\n") };
}

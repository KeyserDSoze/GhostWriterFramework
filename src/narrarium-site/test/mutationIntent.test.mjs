import assert from "node:assert/strict";
import test from "node:test";
import { classifyMutationIntent, mutatingToolIds } from "../src/assistant/mutationIntent.ts";

const cases = [
  ["switch-branch", "switch to branch draft", "cambia branch in draft", "which branch is active?", "do not switch branch"],
  ["import-attachments", "import the attachments", "importa gli allegati", "what is in the attachments?", "non importare gli allegati"],
  ["create-chapter", "create a chapter", "crea un capitolo", "what is this chapter?", "do not create a chapter"],
  ["create-paragraph", "add a paragraph", "aggiungi un paragrafo", "tell me about this paragraph", "non aggiungere un paragrafo"],
  ["create-entity", "create a character", "crea un personaggio", "parlami del personaggio Lyra", "non creare un personaggio"],
  ["create-script", "write a script", "scrivi uno script", "what does the script contain?", "non scrivere uno script"],
  ["create-draft", "generate a draft", "genera una bozza", "cosa contiene questa bozza?", "non generare una bozza"],
  ["update-plot", "update the plot", "aggiorna il plot", "qual e il plot?", "non aggiornare il plot, spiegamelo"],
  ["write-resume", "write the resume", "scrivi il riassunto", "show me the resume", "non scrivere il riassunto"],
  ["write-evaluation", "evaluate this chapter", "valuta questo capitolo", "what is this evaluation?", "non valutare questo capitolo"],
  ["evaluate-chapter-paragraphs", "evaluate every paragraph", "valuta tutti i paragrafi", "which paragraphs were evaluated?", "do not evaluate every paragraph"],
  ["create-note", "save a note", "salva un appunto", "read this note", "non salvare un appunto"],
  ["deep-research", "run deep research", "fai una ricerca approfondita", "tell me about this research", "non fare una ricerca approfondita"],
  ["create-from-research", "create from research", "crea dalla ricerca", "what came from this research?", "non creare dalla ricerca"],
  ["create-simulated-reader", "create a simulated reader", "crea un lettore simulato", "which simulated reader is this?", "non creare un lettore simulato"],
  ["toggle-simulated-reader", "disable this reader", "disabilita questo lettore", "is this reader enabled?", "do not disable this reader"],
  ["evaluate-with-readers", "evaluate with readers", "valuta con i lettori", "what did the readers evaluate?", "non valutare con i lettori"],
  ["summarize-reader-evaluations", "summarize reader evaluations", "riassumi le valutazioni dei lettori", "show reader evaluations", "do not summarize reader evaluations"],
  ["run-audit", "run an audit", "esegui un audit", "show the audit", "non eseguire un audit"],
  ["update-audit", "update the audit", "aggiorna l'audit", "when was the audit updated?", "do not update the audit"],
  ["set-audit-finding-status", "mark finding resolved", "segna il finding risolto", "what is the finding status?", "non segnare il finding"],
  ["create-pull-request", "create a pull request", "crea una pull request", "list open pull requests", "do not create a pull request"],
  ["delete-current-note", "delete this note", "elimina questa nota", "what is in this note?", "non eliminare questa nota"],
  ["delete-current-paragraph", "delete this paragraph", "elimina questo paragrafo", "read this paragraph", "non eliminare questo paragrafo"],
  ["delete-current-entity", "delete this character", "elimina questo personaggio", "who is this character?", "non eliminare questo personaggio"],
  ["delete-reader-evaluation", "delete reader evaluation", "elimina la valutazione del lettore", "show reader evaluation", "non eliminare la valutazione del lettore"],
  ["delete-audit", "delete the audit", "elimina l'audit", "show the audit", "non eliminare l'audit"],
];

test("the mutation policy covers every mutating built-in tool", () => {
  assert.deepEqual(mutatingToolIds().sort(), cases.map(([toolId]) => toolId).sort());
});

test("every mutating tool requires positive bilingual action intent", () => {
  for (const [toolId, positiveEn, positiveIt, readOnly, negated] of cases) {
    assert.equal(classifyMutationIntent(positiveEn, toolId), "positive", `${toolId}: English positive`);
    assert.equal(classifyMutationIntent(positiveIt, toolId), "positive", `${toolId}: Italian positive`);
    assert.equal(classifyMutationIntent(readOnly, toolId), "read-only", `${toolId}: read-only collision`);
    assert.equal(classifyMutationIntent(negated, toolId), "negated", `${toolId}: negation`);
    assert.equal(classifyMutationIntent(`how would I ${positiveEn}?`, toolId), "read-only", `${toolId}: English read-only`);
    assert.equal(classifyMutationIntent(`come potrei ${positiveIt}?`, toolId), "read-only", `${toolId}: Italian read-only`);
    assert.equal(classifyMutationIntent(`do not ${positiveEn}`, toolId), "negated", `${toolId}: English negation`);
    assert.equal(classifyMutationIntent(`non ${positiveIt}`, toolId), "negated", `${toolId}: Italian negation`);
  }
});

test("bare mutation nouns require confirmation and instructional questions stay read-only", () => {
  assert.equal(classifyMutationIntent("plot", "update-plot"), "ambiguous");
  assert.equal(classifyMutationIntent("bozza", "create-draft"), "ambiguous");
  assert.equal(classifyMutationIntent("how do I update the plot?", "update-plot"), "read-only");
  assert.equal(classifyMutationIntent("come posso creare un personaggio?", "create-entity"), "read-only");
  assert.equal(classifyMutationIntent("should I update the plot?", "update-plot"), "read-only");
  assert.equal(classifyMutationIntent("e possibile aggiornare il plot?", "update-plot"), "read-only");
  assert.equal(classifyMutationIntent("to update the plot, what would you change?", "update-plot"), "read-only");
  assert.equal(classifyMutationIntent("can you update the plot?", "update-plot"), "positive");
  assert.equal(classifyMutationIntent("puoi aggiornare il plot?", "update-plot"), "positive");
});

test("typographic apostrophes, exclusions, and unknown mutating tools fail safely", () => {
  assert.equal(classifyMutationIntent("don’t update the plot", "update-plot"), "negated");
  assert.equal(classifyMutationIntent("do everything except create a chapter", "create-chapter"), "negated");
  assert.equal(classifyMutationIntent("update everything except the plot", "update-plot"), "negated");
  assert.equal(classifyMutationIntent("update the plot. Actually, do not update it", "update-plot"), "negated");
  assert.equal(classifyMutationIntent("fai tutto tranne eliminare la nota", "delete-current-note"), "negated");
  assert.equal(classifyMutationIntent("execute it", "future-mutating-tool"), "ambiguous");
});

test("a positive instruction in a separate contrast clause remains actionable", () => {
  assert.equal(classifyMutationIntent("do not explain it, but update the plot", "update-plot"), "positive");
  assert.equal(classifyMutationIntent("non spiegarmelo, ma aggiorna il plot", "update-plot"), "positive");
});

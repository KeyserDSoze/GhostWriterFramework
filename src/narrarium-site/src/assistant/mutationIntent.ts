export type MutationIntent = "positive" | "negated" | "read-only" | "ambiguous";

const MUTATION_VERBS: Record<string, RegExp> = {
  "switch-branch": /\b(switch|checkout|change|create|use|go to|cambia|cambiare|crea|creare|usa|usare|vai sul)\b/i,
  "import-attachments": /\b(import|attach|use|add|save|importa|importare|allega|allegare|usa|usare|aggiungi|aggiungere|salva|salvare)\b/i,
  "create-chapter": /\b(create|add|write|draft|crea|creare|aggiungi|aggiungere|scrivi|scrivere|genera|generare)\b/i,
  "create-paragraph": /\b(create|add|write|draft|crea|creare|aggiungi|aggiungere|scrivi|scrivere|genera|generare)\b/i,
  "create-entity": /\b(create|add|define|crea|creare|aggiungi|aggiungere|definisci|definire)\b/i,
  "create-script": /\b(create|add|write|draft|crea|creare|aggiungi|aggiungere|scrivi|scrivere|genera|generare)\b/i,
  "create-draft": /\b(create|add|write|generate|crea|creare|aggiungi|aggiungere|scrivi|scrivere|genera|generare)\b/i,
  "update-plot": /\b(update|refresh|write|save|sync|revise|aggiorna|aggiornare|scrivi|scrivere|salva|salvare|sincronizza|sincronizzare|rivedi|rivedere)\b/i,
  "write-resume": /\b(write|create|refresh|update|save|scrivi|scrivere|crea|creare|aggiorna|aggiornare|salva|salvare)\b/i,
  "write-evaluation": /\b(write|create|refresh|update|save|evaluate|review|scrivi|scrivere|crea|creare|aggiorna|aggiornare|salva|salvare|valuta|valutare|recensisci|recensire)\b/i,
  "evaluate-chapter-paragraphs": /\b(evaluate|review|run|write|valuta|valutare|recensisci|recensire|esegui|eseguire|scrivi|scrivere)\b/i,
  "create-note": /\b(create|add|write|save|take|append|crea|creare|aggiungi|aggiungere|scrivi|scrivere|salva|salvare|annota|annotare)\b/i,
  "deep-research": /\b(run|start|conduct|perform|do|save|esegui|eseguire|avvia|avviare|fai|fare|conduci|condurre|salva|salvare)\b/i,
  "create-from-research": /\b(create|add|generate|crea|creare|aggiungi|aggiungere|genera|generare)\b/i,
  "create-simulated-reader": /\b(create|add|define|crea|creare|aggiungi|aggiungere|definisci|definire)\b/i,
  "toggle-simulated-reader": /\b(enable|disable|activate|deactivate|toggle|abilita|abilitare|disabilita|disabilitare|attiva|attivare|disattiva|disattivare|riattiva|riattivare)\b/i,
  "evaluate-with-readers": /\b(evaluate|review|run|valuta|valutare|recensisci|recensire|esegui|eseguire|fai valutare|fare valutare)\b/i,
  "summarize-reader-evaluations": /\b(summarize|compare|write|save|sintetizza|sintetizzare|riassumi|riassumere|confronta|confrontare|scrivi|scrivere|salva|salvare)\b/i,
  "run-audit": /\b(run|start|execute|perform|audit|esegui|eseguire|avvia|avviare|fai|fare|controlla|controllare)\b/i,
  "update-audit": /\b(update|rerun|repeat|refresh|aggiorna|aggiornare|ripeti|ripetere|rifai|rifare)\b/i,
  "set-audit-finding-status": /\b(mark|set|change|resolve|ignore|segna|segnare|imposta|impostare|cambia|cambiare|risolvi|risolvere|ignora|ignorare|contrassegna|contrassegnare)\b/i,
  "create-pull-request": /\b(create|make|submit|crea|creare|apri|aprire|invia|inviare)\b/i,
  "delete-current-note": /\b(delete|remove|erase|elimina|eliminare|cancella|cancellare|rimuovi|rimuovere)\b/i,
  "delete-current-paragraph": /\b(delete|remove|erase|elimina|eliminare|cancella|cancellare|rimuovi|rimuovere)\b/i,
  "delete-current-entity": /\b(delete|remove|erase|elimina|eliminare|cancella|cancellare|rimuovi|rimuovere)\b/i,
  "delete-reader-evaluation": /\b(delete|remove|erase|elimina|eliminare|cancella|cancellare|rimuovi|rimuovere)\b/i,
  "delete-audit": /\b(delete|remove|erase|elimina|eliminare|cancella|cancellare|rimuovi|rimuovere)\b/i,
};

const NEGATION = /\b(no|not|never|don't|dont|do not|without|avoid|except|excluding|non|mai|senza|evita|tranne|eccetto|escludendo|non voglio)\b/i;
const READ_ONLY = /\b(what|which|who|where|when|how|tell me|explain|describe|show|list|read|get|contents?|qual[ei]?|chi|dove|quando|come|dimmi|parlami|spiega|descrivi|mostra|elenca|leggi|cosa contiene|cos'è|cos e|vorrei sapere)\b/i;
const DIRECT_REQUEST = /\b(can you|could you|would you|will you|please|puoi|potresti|vorresti|per favore|ti prego)\b/i;
const DELIBERATIVE = /\b(should i|should we|do i|do we|is it possible|would it make sense|what if|dovrei|dovremmo|posso|possiamo|e possibile|è possibile|avrebbe senso|cosa succede se)\b/i;
const CLAUSE_BOUNDARY = /[.!?;]\s*|\b(?:but|however|instead|ma|però|invece)\b/i;

export function mutatingToolIds(): string[] {
  return Object.keys(MUTATION_VERBS);
}

export function classifyMutationIntent(prompt: string, toolId: string): MutationIntent {
  const mutationVerb = MUTATION_VERBS[toolId];
  if (!mutationVerb) return "ambiguous";

  const normalizedPrompt = prompt.replace(/[’‘]/g, "'");
  const isQuestion = /\?\s*$/.test(normalizedPrompt.trim());

  let foundNegatedMutation = false;
  let foundPositiveMutation = false;
  let foundReadOnlyMutation = false;
  for (const clause of normalizedPrompt.split(CLAUSE_BOUNDARY)) {
    const verbMatch = mutationVerb.exec(clause);
    if (!verbMatch) continue;
    const beforeVerb = clause.slice(0, verbMatch.index);
    if (NEGATION.test(clause)) foundNegatedMutation = true;
    else if (READ_ONLY.test(beforeVerb)) foundReadOnlyMutation = true;
    else if (DIRECT_REQUEST.test(beforeVerb) || verbMatch.index === 0) foundPositiveMutation = true;
    else if (DELIBERATIVE.test(beforeVerb) || (isQuestion && READ_ONLY.test(normalizedPrompt))) foundReadOnlyMutation = true;
    else foundPositiveMutation = true;
  }

  if (foundNegatedMutation) return "negated";
  if (foundPositiveMutation) return "positive";
  if (foundReadOnlyMutation || READ_ONLY.test(normalizedPrompt) || isQuestion) return "read-only";
  return "ambiguous";
}

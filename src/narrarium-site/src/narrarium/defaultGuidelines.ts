import { parseDocument, stringify } from "yaml";

export const EVALUATION_GUIDELINES_PATH = "evaluation-guidelines.md";

export function normalizeBookLanguage(language: string | undefined): "it" | "en" {
  return language?.trim().toLowerCase().startsWith("it") ? "it" : "en";
}

export function defaultWritingStyleBody(language: string | undefined): string {
  if (normalizeBookLanguage(language) === "it") {
    return `# Stile di scrittura

## Contratto di base

- Preserva canone, cronologia, nomi e fatti già visibili.
- Scrivi una prosa concreta di scena con punto di vista leggibile, appoggio sensoriale e ritmo intenzionale.
- Mantieni i dialoghi chiari: ogni battuta deve avere ownership leggibile tramite voce, contesto o action beat sobri.
- Preferisci verbi specifici e immagini nette invece di riassunti generici.
- Migliora chiarezza, tensione, ritmo e precisione emotiva senza cambiare l'intento narrativo.

## Regole di revisione

- Non inventare nuovo canone durante la revisione se l'utente non lo chiede esplicitamente.
- Mantieni la stessa lingua del testo sorgente salvo richiesta esplicita di traduzione.
- Restituisci solo la prosa o il body markdown richiesto, senza commenti o code fence.
`;
  }
  return `# Writing Style

## Core Contract

- Preserve established canon, chronology, names, and visible facts.
- Write concrete scene prose with clear viewpoint, sensory grounding, and purposeful rhythm.
- Keep dialogue readable: each spoken line should have clear speaker ownership through voice, context, or restrained action beats.
- Prefer specific verbs and images over generic summary.
- Improve clarity, tension, pacing, and emotional precision without changing story intent.

## Revision Rules

- Do not invent new canon while revising unless the user explicitly asks.
- Keep the same language as the source text unless a task explicitly requests translation.
- Return only the requested prose or markdown body, without commentary or code fences.
`;
}

export function defaultWritingStyleTitle(language: string | undefined): string {
  return normalizeBookLanguage(language) === "it" ? "Stile di scrittura" : "Writing Style";
}

export const PUNCTUATION_STYLE_PATH = "punctuation-style.md";

export function defaultPunctuationStyleTitle(language: string | undefined): string {
  return normalizeBookLanguage(language) === "it" ? "Stile di punteggiatura" : "Punctuation Style";
}

export function defaultPunctuationStyleBody(language: string | undefined): string {
  if (normalizeBookLanguage(language) === "it") {
    return `# Stile di punteggiatura

Queste regole di punteggiatura sono vincolanti e vanno rispettate SEMPRE quando scrivi, riscrivi o modifichi prosa, dialoghi, bozze o paragrafi. Applicale in modo coerente anche se non vengono ripetute nella singola richiesta.

## Dialoghi

- Usa le virgolette caporali (parentesi francesi) « » per aprire e chiudere ogni battuta di dialogo. Non usare "virgolette dritte" né 'apici' né “virgolette curve” per i dialoghi.
- Tieni TUTTI i segni di punteggiatura DENTRO le caporali (virgola, punto e virgola, due punti, punto interrogativo, punto esclamativo, puntini di sospensione), TRANNE il punto fermo finale, che va SEMPRE FUORI dalle caporali.
  - Esempio corretto: «Vieni con me».
  - Esempio corretto: «Vieni con me?» chiese lei.
  - Esempio corretto: «Vieni con me!»
  - Esempio corretto: «Aspetta…».
  - Esempio ERRATO: «Vieni con me.»  (il punto non deve stare dentro)
  - Esempio ERRATO: "Vieni con me".  (non usare virgolette dritte)
- Quando la battuta è seguita da un inciso (dice, chiese, mormorò), chiudi le caporali, poi metti l'inciso, e il punto finale va alla fine della frase completa: «Vieni con me», disse.

## Regole generali

- Non lasciare spazi subito dopo « né subito prima di ».
- Usa i puntini di sospensione come carattere unico … (tre punti), senza spazio prima.
- Mantieni coerenza in tutto il testo: non alternare stili di virgolette diversi.

## Priorità

Se una richiesta contraddice queste regole senza motivo esplicito, dai priorità a queste regole di punteggiatura.
`;
  }
  return `# Punctuation Style

These punctuation rules are binding and must ALWAYS be respected when you write, rewrite, or edit prose, dialogue, drafts, or paragraphs. Apply them consistently even when they are not repeated in the individual request.

## Dialogue

- Use guillemets (French angle quotes) « » to open and close every line of dialogue. Do not use "straight quotes", 'apostrophes', or “curly quotes” for dialogue.
- Keep ALL punctuation marks INSIDE the guillemets (comma, semicolon, colon, question mark, exclamation mark, ellipsis) EXCEPT the final full stop (period), which must ALWAYS stay OUTSIDE the guillemets.
  - Correct: «Come with me».
  - Correct: «Come with me?» she asked.
  - Correct: «Come with me!»
  - Correct: «Wait…».
  - WRONG: «Come with me.»  (the full stop must not be inside)
  - WRONG: "Come with me".  (do not use straight quotes)
- When a dialogue tag follows (said, asked, whispered), close the guillemets, add the tag, and place the final full stop at the end of the whole sentence: «Come with me», she said.

## General rules

- Do not leave a space right after « or right before ».
- Use a single ellipsis character … (not three separate dots) with no space before it.
- Stay consistent across the whole text: never mix different quote styles.

## Priority

If a request contradicts these rules without an explicit reason, give priority to these punctuation rules.
`;
}

function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.replace(/^\n+/, "").trimEnd()}\n`;
}

export function defaultEvaluationGuidelinesMarkdown(language: string | undefined): string {
  const localized = normalizeBookLanguage(language) === "it"
    ? {
        title: "Stile di valutazione",
        body: [
          "# Stile di valutazione",
          "",
          "Usa questo file come contratto per le valutazioni di capitoli e paragrafi.",
          "Sii severo, preciso e critico: non dare voti di cortesia e non addolcire problemi reali.",
          "",
          "## Principi critici",
          "",
          "- Valuta solo ciò che è davvero presente nel testo e nel canone visibile.",
          "- Evidenzia con chiarezza difetti, ambiguità, contraddizioni, ritmo debole, opacità psicologica e problemi di tono.",
          "- Non regalare voti alti: un 8, 9 o 10 richiede qualità evidente e sostenuta.",
          "- Ogni sezione discorsiva deve restare concreta e utile alla revisione.",
          "- Ogni criterio numerico deve avere una breve spiegazione del voto.",
          "",
          "## Struttura della valutazione discorsiva",
          "",
          "Per un capitolo usa queste sezioni:",
          "- `## Verdetto`",
          "- `## Punti forti`",
          "- `## Rischi e debolezze`",
          "- `## Canone e continuità`",
          "- `## Priorità di riscrittura`",
          "",
          "Per un paragrafo usa queste sezioni:",
          "- `## Verdetto`",
          "- `## Cosa funziona`",
          "- `## Cosa non funziona`",
          "- `## Canone e continuità`",
          "- `## Priorità di riscrittura`",
        ].join("\n"),
        criteria: {
          chiarezza: { description: "Quanto il testo è leggibile, comprensibile e ben articolato alla prima lettura." },
          ritmo: { description: "Quanto il passo narrativo regge senza trascinarsi o comprimersi in modo scomposto." },
          tensione: { description: "Quanto il testo mantiene pressione narrativa, conflitto, attesa o attrito significativo." },
          coerenza_canone: { description: "Quanto il testo resta coerente con canone, cronologia, reveal e continuità interna." },
          forza_stilistica: { description: "Quanto la prosa è precisa, incisiva, visiva e adatta al progetto del libro." },
        },
      }
    : {
        title: "Evaluation Style",
        body: [
          "# Evaluation Style",
          "",
          "Use this file as the contract for chapter and paragraph evaluations.",
          "Be severe, exact, and critical: do not hand out comfort scores and do not soften real weaknesses.",
          "",
          "## Critical principles",
          "",
          "- Evaluate only what is actually present in the text and visible canon.",
          "- Clearly surface flaws, ambiguity, contradictions, weak pacing, thin psychology, and tonal drift.",
          "- Do not hand out high scores cheaply: 8, 9, or 10 should require clearly sustained quality.",
          "- Keep the discursive evaluation concrete and revision-useful.",
          "- Every numeric criterion must include a short explanation for the score.",
          "",
          "## Discursive evaluation structure",
          "",
          "For a chapter, use these sections:",
          "- `## Verdict`",
          "- `## Strengths`",
          "- `## Risks And Weaknesses`",
          "- `## Canon And Continuity`",
          "- `## Rewrite Priorities`",
          "",
          "For a paragraph, use these sections:",
          "- `## Verdict`",
          "- `## What Works`",
          "- `## What Does Not Work`",
          "- `## Canon And Continuity`",
          "- `## Rewrite Priorities`",
        ].join("\n"),
        criteria: {
          clarity: { description: "How legible, comprehensible, and structurally clear the text is on first reading." },
          pacing: { description: "How well the narrative tempo holds without dragging or becoming abruptly compressed." },
          tension: { description: "How strongly the text sustains narrative pressure, conflict, anticipation, or friction." },
          canon_coherence: { description: "How well the text stays coherent with canon, chronology, reveals, and internal continuity." },
          stylistic_force: { description: "How precise, vivid, and project-appropriate the prose feels." },
        },
      };

  return renderMarkdown(
    {
      type: "guideline",
      id: "guideline:evaluation-style",
      title: localized.title,
      scope: "evaluation-style",
      criteria: localized.criteria,
    },
    localized.body,
  );
}

export function defaultEvaluationCriteria(language: string | undefined): Record<string, string> {
  const raw = defaultEvaluationGuidelinesMarkdown(language);
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return {};
  const frontmatter = (parseDocument(match[1]).toJSON() as Record<string, unknown> | null) ?? {};
  const rawCriteria = frontmatter.criteria;
  if (!rawCriteria || typeof rawCriteria !== "object" || Array.isArray(rawCriteria)) return {};
  return Object.fromEntries(Object.entries(rawCriteria as Record<string, unknown>).map(([key, value]) => [
    key,
    value && typeof value === "object" && typeof (value as Record<string, unknown>).description === "string"
      ? String((value as Record<string, unknown>).description)
      : String(value ?? ""),
  ]));
}

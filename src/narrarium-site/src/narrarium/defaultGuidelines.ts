import { stringify } from "yaml";

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

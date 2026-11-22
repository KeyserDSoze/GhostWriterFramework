import { normalizeScore } from "../ai/structured.js";
import type { AiJsonSchema } from "../ai/types.js";
import { asRecord, asString, asStringList } from "../util/json.js";
import { stripFrontmatter } from "../util/text.js";

/** Structured opinion of one simulated reader (same shape the web app stores). */
export interface ReaderEvaluationOutput {
  generalImpression: string;
  strengths: string[];
  weaknesses: string[];
  mostEffectiveMoment: string;
  mainProblem: string;
  prioritySuggestion: string;
  score: number;
  additionalNotes?: string;
}

export const READER_EVALUATION_TOOL: AiJsonSchema = {
  name: "reader_evaluation",
  description: "Return a concise simulated-reader evaluation from the configured reader's point of view.",
  parameters: {
    type: "object",
    properties: {
      generalImpression: { type: "string" },
      strengths: { type: "array", items: { type: "string" } },
      weaknesses: { type: "array", items: { type: "string" } },
      mostEffectiveMoment: { type: "string" },
      mainProblem: { type: "string" },
      prioritySuggestion: { type: "string" },
      score: { type: "number", minimum: 1, maximum: 10 },
      additionalNotes: { type: "string" },
    },
    required: ["generalImpression", "strengths", "weaknesses", "mostEffectiveMoment", "mainProblem", "prioritySuggestion", "score"],
    additionalProperties: false,
  },
};

export const READER_SUMMARY_TOOL: AiJsonSchema = {
  name: "reader_evaluation_summary",
  description: "Compare separate simulated-reader evaluations and return a concise panel summary.",
  parameters: {
    type: "object",
    properties: {
      consensus: { type: "array", items: { type: "string" } },
      disagreements: { type: "array", items: { type: "string" } },
      recurringStrengths: { type: "array", items: { type: "string" } },
      recurringProblems: { type: "array", items: { type: "string" } },
      prioritySuggestions: { type: "array", items: { type: "string" } },
      isolatedObservations: { type: "array", items: { type: "string" } },
      revisionPriorities: { type: "array", items: { type: "string" } },
      overallScore: { type: "number", minimum: 1, maximum: 10 },
    },
    required: ["consensus", "disagreements", "recurringStrengths", "recurringProblems", "prioritySuggestions", "isolatedObservations", "revisionPriorities", "overallScore"],
    additionalProperties: false,
  },
};

export function normalizeReaderEvaluationOutput(value: unknown): ReaderEvaluationOutput {
  const record = asRecord(value);
  const additionalNotes = asString(record.additionalNotes);
  return {
    generalImpression: asString(record.generalImpression),
    strengths: asStringList(record.strengths, 12),
    weaknesses: asStringList(record.weaknesses, 12),
    mostEffectiveMoment: asString(record.mostEffectiveMoment),
    mainProblem: asString(record.mainProblem),
    prioritySuggestion: asString(record.prioritySuggestion),
    score: Math.round(Math.max(1, normalizeScore(record.score) ?? 5) * 10) / 10,
    ...(additionalNotes ? { additionalNotes } : {}),
  };
}

export function renderReaderEvaluationBody(output: ReaderEvaluationOutput, language: string): string {
  const it = language.toLowerCase().startsWith("it");
  const labels = it
    ? ["Valutazione", "Impressione generale", "Punti di forza", "Punti di debolezza", "Momento più efficace", "Problema principale", "Suggerimento prioritario", "Punteggio", "Osservazioni aggiuntive"]
    : ["Evaluation", "General impression", "Strengths", "Weaknesses", "Most effective moment", "Main problem", "Priority suggestion", "Score", "Additional notes"];
  return [
    `# ${labels[0]}`,
    `\n## ${labels[1]}\n\n${output.generalImpression}`,
    `\n## ${labels[2]}\n\n${output.strengths.map((value) => `- ${value}`).join("\n")}`,
    `\n## ${labels[3]}\n\n${output.weaknesses.map((value) => `- ${value}`).join("\n")}`,
    `\n## ${labels[4]}\n\n${output.mostEffectiveMoment}`,
    `\n## ${labels[5]}\n\n${output.mainProblem}`,
    `\n## ${labels[6]}\n\n${output.prioritySuggestion}`,
    `\n## ${labels[7]}\n\n${output.score}/10`,
    output.additionalNotes ? `\n## ${labels[8]}\n\n${output.additionalNotes}` : "",
  ].filter(Boolean).join("\n").trim() + "\n";
}

export function renderReaderSummaryBody(output: Record<string, unknown>, language: string): string {
  const it = language.toLowerCase().startsWith("it");
  const sections: Array<[string, string]> = it
    ? [["consensus", "Convergenze"], ["disagreements", "Disaccordi"], ["recurringStrengths", "Punti di forza ricorrenti"], ["recurringProblems", "Problemi ricorrenti"], ["prioritySuggestions", "Suggerimenti prioritari"], ["isolatedObservations", "Osservazioni isolate"], ["revisionPriorities", "Priorità di revisione"]]
    : [["consensus", "Consensus"], ["disagreements", "Disagreements"], ["recurringStrengths", "Recurring strengths"], ["recurringProblems", "Recurring problems"], ["prioritySuggestions", "Priority suggestions"], ["isolatedObservations", "Isolated observations"], ["revisionPriorities", "Revision priorities"]];
  const lines = [`# ${it ? "Sintesi dei lettori simulati" : "Simulated readers summary"}`];
  for (const [key, label] of sections) {
    const values = Array.isArray(output[key]) ? output[key] as unknown[] : [];
    lines.push(`\n## ${label}\n\n${values.map((value) => `- ${String(value)}`).join("\n") || "-"}`);
  }
  lines.push(`\n## ${it ? "Punteggio complessivo" : "Overall score"}\n\n${Number(output.overallScore ?? 0)}/10`);
  return lines.join("\n").trim() + "\n";
}

/**
 * The chapter text simulated readers evaluate. Built exactly like the web app's Reader
 * evaluations page so the saved `sourceContentHash` is recognized as current there.
 */
export function chapterReaderText(paragraphs: Array<{ title: string; raw: string }>): string {
  return paragraphs.map((paragraph) => `## ${paragraph.title}\n\n${stripFrontmatter(paragraph.raw)}`).join("\n\n");
}

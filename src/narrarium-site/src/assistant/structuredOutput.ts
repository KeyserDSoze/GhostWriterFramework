import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const strings = z.array(z.string());

export const chapterOutputSchema = z.object({ title: nonEmpty, summary: z.string(), body: nonEmpty }).strict();
export const paragraphOutputSchema = chapterOutputSchema;
export const entityOutputSchema = z.object({ label: nonEmpty, summary: z.string(), body: nonEmpty, extraFrontmatter: z.record(z.string(), z.unknown()) }).strict();
export const scriptOutputSchema = z.object({ title: nonEmpty, location: nonEmpty }).strict();
export const importedScriptOutputSchema = z.object({ title: nonEmpty, location: nonEmpty, body: nonEmpty }).strict();
export const importedDraftOutputSchema = z.object({ title: nonEmpty, body: nonEmpty }).strict();
export const readerOutputSchema = z.object({ name: nonEmpty, description: nonEmpty, profile: nonEmpty, aspects: strings, preferredGenres: strings, dislikedGenres: strings, experienceLevel: nonEmpty, severity: z.number().int().min(1).max(10), audienceAge: nonEmpty, interests: strings, appreciatedElements: strings, frequentCriticisms: strings, customPrompt: z.string() }).strict();
export const multiFileOutputSchema = z.object({ summary: nonEmpty, updates: z.array(z.object({ path: nonEmpty.refine((path) => !path.startsWith("/") && !path.includes("..") && path.endsWith(".md"), "must be a safe relative Markdown path"), content: nonEmpty, reason: nonEmpty }).strict()).min(1).max(8).refine((updates) => new Set(updates.map((entry) => entry.path)).size === updates.length, "duplicate update paths") }).strict();

export class StructuredOutputError extends Error {
  constructor(message: string) { super(message); this.name = "StructuredOutputError"; }
}

export function parseStructuredOutput<T>(raw: string, schema: z.ZodType<T>): T {
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let value: unknown;
  try { value = JSON.parse(clean); } catch (error) { throw new StructuredOutputError(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StructuredOutputError("Structured response must be one JSON object.");
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new StructuredOutputError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; "));
  return parsed.data;
}

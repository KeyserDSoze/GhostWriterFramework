// ─── Create From Research Engine ─────────────────────────────────────────────
// Takes a saved research document and generates a Narrarium canon entity from it.

import type { AppSettings, BookEntry } from "@/types/settings";
import { completeText } from "@/assistant/llm";
import { completeTextRouted } from "@/assistant/router";
import { createCanonEntity } from "@/narrarium/canon";
import type { EntityKind } from "@/narrarium/canon";

export { EntityKind };

export interface CreateFromResearchInput {
  settings: AppSettings;
  book: BookEntry;
  branch: string;
  token: string;
  /** Full Markdown content of the research file */
  researchMarkdown: string;
  /** The entity type to create */
  entityKind: EntityKind;
  /** Optional custom prompt from Book Settings; if absent, uses the default */
  customPrompt?: string;
  /** Language for the generated entity */
  language: string;
  /** Optional: bypass the router and use a specific integration+model */
  overrideIntegrationId?: string;
  overrideModelName?: string;
  signal?: AbortSignal;
}

export interface CreateFromResearchResult {
  path: string;
  id: string;
  slug: string;
  /** Generated Markdown body (after frontmatter) */
  generatedBody: string;
  /** Suggested name/title extracted from LLM output */
  suggestedName: string;
}

/** Default system prompts per entity kind. */
export const DEFAULT_CREATE_PROMPTS: Record<EntityKind, string> = {
  character: [
    "You are a creative writing assistant. Given research material, create a Narrarium character entity.",
    "Generate a JSON object with these fields:",
    "{ \"name\": string, \"role_tier\": string, \"story_role\": string, \"function_in_book\": string, \"body\": string }",
    "\"body\" must be a rich Markdown description of the character (voice, background, motivations, appearance, arc).",
    "Base the character on the research, adapting facts into fiction where appropriate.",
    "Respond with only the JSON object.",
  ].join(" "),

  location: [
    "You are a creative writing assistant. Given research material, create a Narrarium location entity.",
    "Generate a JSON object with these fields:",
    "{ \"name\": string, \"kind\": string, \"region\": string, \"atmosphere\": string, \"body\": string }",
    "\"body\" must be a rich Markdown description (sensory details, history, story function, dangers).",
    "Base the location on the research material.",
    "Respond with only the JSON object.",
  ].join(" "),

  faction: [
    "You are a creative writing assistant. Given research material, create a Narrarium faction entity.",
    "Generate a JSON object with these fields:",
    "{ \"name\": string, \"kind\": string, \"mission\": string, \"ideology\": string, \"body\": string }",
    "\"body\" must be a rich Markdown description (history, methods, alliances, internal conflicts).",
    "Base the faction on the research material.",
    "Respond with only the JSON object.",
  ].join(" "),

  item: [
    "You are a creative writing assistant. Given research material, create a Narrarium item entity.",
    "Generate a JSON object with these fields:",
    "{ \"name\": string, \"kind\": string, \"purpose\": string, \"significance\": string, \"body\": string }",
    "\"body\" must be a rich Markdown description (appearance, history, powers, ownership).",
    "Base the item on the research material.",
    "Respond with only the JSON object.",
  ].join(" "),

  secret: [
    "You are a creative writing assistant. Given research material, create a Narrarium secret entity.",
    "Generate a JSON object with these fields:",
    "{ \"title\": string, \"stakes\": string, \"body\": string }",
    "\"body\" must describe the secret: what it is, who holds it, and how it could be revealed.",
    "Base the secret on the research material.",
    "Respond with only the JSON object.",
  ].join(" "),

  "timeline-event": [
    "You are a creative writing assistant. Given research material, create a Narrarium timeline event.",
    "Generate a JSON object with these fields:",
    "{ \"title\": string, \"date\": string, \"significance\": string, \"body\": string }",
    "\"body\" must describe the event: participants, causes, consequences, narrative role.",
    "Base the event on the research material.",
    "Respond with only the JSON object.",
  ].join(" "),
};

function extractJson(raw: string): Record<string, unknown> {
  // Try to parse a JSON object from the response (possibly wrapped in markdown fences)
  const clean = raw.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("LLM did not return a JSON object.");
  return JSON.parse(match[0]) as Record<string, unknown>;
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return "";
}

export async function createEntityFromResearch(input: CreateFromResearchInput): Promise<CreateFromResearchResult> {
  const systemPrompt = input.customPrompt ?? DEFAULT_CREATE_PROMPTS[input.entityKind];

  const messages = [
    { role: "system" as const, content: `${systemPrompt}\n\nAlways write in ${input.language}.` },
    {
      role: "user" as const,
      content: `Research material:\n\n${input.researchMarkdown}\n\nCreate a ${input.entityKind} entity based on this research.`,
    },
  ];

  let raw: string;
  if (input.overrideIntegrationId && input.overrideModelName) {
    const integration = (input.settings.aiIntegrations ?? []).find((i) => i.id === input.overrideIntegrationId);
    if (integration) {
      raw = await completeText(integration, messages, "writing", {
        modelName: input.overrideModelName,
        capability: "create-from-research",
        signal: input.signal,
        label: `create-from-research:${input.entityKind}`,
      });
    } else {
      raw = await completeTextRouted(input.settings, messages, "create-from-research", {
        signal: input.signal,
        label: `create-from-research:${input.entityKind}`,
      });
    }
  } else {
    raw = await completeTextRouted(input.settings, messages, "create-from-research", {
      signal: input.signal,
      label: `create-from-research:${input.entityKind}`,
    });
  }

  const parsed = extractJson(raw);

  const name = str(parsed.name ?? parsed.title);
  if (!name) throw new Error("LLM did not return a name or title for the entity.");

  const body = str(parsed.body) || `# ${name}\n\nGenerated from research.\n`;

  // Build extra frontmatter fields per kind
  const extra: Record<string, unknown> = {};
  if (input.entityKind === "character") {
    if (parsed.role_tier) extra.role_tier = str(parsed.role_tier);
    if (parsed.story_role) extra.story_role = str(parsed.story_role);
    if (parsed.function_in_book) extra.function_in_book = str(parsed.function_in_book);
  } else if (input.entityKind === "location") {
    if (parsed.kind) extra.kind = str(parsed.kind);
    if (parsed.region) extra.region = str(parsed.region);
    if (parsed.atmosphere) extra.atmosphere = str(parsed.atmosphere);
  } else if (input.entityKind === "faction") {
    if (parsed.kind) extra.kind = str(parsed.kind);
    if (parsed.mission) extra.mission = str(parsed.mission);
    if (parsed.ideology) extra.ideology = str(parsed.ideology);
  } else if (input.entityKind === "item") {
    if (parsed.kind) extra.kind = str(parsed.kind);
    if (parsed.purpose) extra.purpose = str(parsed.purpose);
    if (parsed.significance) extra.significance = str(parsed.significance);
  } else if (input.entityKind === "timeline-event") {
    if (parsed.date) extra.date = str(parsed.date);
    if (parsed.significance) extra.significance = str(parsed.significance);
  }

  const created = await createCanonEntity(input.token, input.book.owner, input.book.repo, input.branch, {
    kind: input.entityKind,
    label: name,
    body,
    extraFrontmatter: extra,
  });

  return { ...created, generatedBody: body, suggestedName: name };
}

// ─── Regenerate Canon Entity ──────────────────────────────────────────────────
// Generates a proposed new body for an existing canon entity based on today's
// knowledge, selected deep-research documents, and an optional custom prompt.
// Does NOT write to GitHub – returns the proposed body for the user to review.

import type { AppSettings, BookEntry } from "@/types/settings";
import { completeText } from "@/assistant/llm";
import { completeTextRouted } from "@/assistant/router";
import type { EntityKind } from "@/narrarium/canon";
import { DEFAULT_CREATE_PROMPTS } from "./createFromResearch";

export interface RegenerateEntityInput {
  settings: AppSettings;
  book: BookEntry;
  /** Full current markdown content of the entity file (frontmatter + body). */
  currentContent: string;
  /** Array of full markdown content of selected research files. */
  researchMarkdowns: string[];
  entityKind: EntityKind;
  /** Custom user instruction appended to the system prompt. */
  customPrompt?: string;
  language: string;
  overrideIntegrationId?: string;
  overrideModelName?: string;
  signal?: AbortSignal;
}

export interface RegenerateEntityResult {
  /** Proposed Markdown body (without frontmatter). */
  proposedBody: string;
  /** Optional frontmatter patches suggested by the LLM (e.g. updated name/summary). */
  proposedFrontmatterPatches: Record<string, unknown>;
}

const REGEN_SYSTEM_SUFFIX = [
  "You are rewriting an existing Narrarium canon entity from scratch.",
  "Use the provided current entity content as reference, the research documents for factual accuracy,",
  "and the custom instructions if any. Return a JSON object:",
  "{ \"frontmatterPatches\": { ...optional updated fields... }, \"body\": \"...full new markdown body...\" }",
  "The body must be rich, narrative Markdown. Only patch frontmatter fields that genuinely need updating.",
  "Respond with only the JSON object.",
].join(" ");

function extractJson(raw: string): Record<string, unknown> {
  const clean = raw.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("LLM did not return a JSON object.");
  return JSON.parse(match[0]) as Record<string, unknown>;
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return "";
}

export async function regenerateEntity(input: RegenerateEntityInput): Promise<RegenerateEntityResult> {
  const basePrompt = input.customPrompt
    ? `${DEFAULT_CREATE_PROMPTS[input.entityKind]}\n\nAdditional instructions: ${input.customPrompt}`
    : DEFAULT_CREATE_PROMPTS[input.entityKind];

  const researchSection = input.researchMarkdowns.length > 0
    ? `\n\nResearch documents (${input.researchMarkdowns.length}):\n\n` +
      input.researchMarkdowns.map((doc, i) => `--- Research ${i + 1} ---\n${doc}`).join("\n\n")
    : "";

  const messages = [
    {
      role: "system" as const,
      content: `${basePrompt}\n\n${REGEN_SYSTEM_SUFFIX}\n\nAlways write in ${input.language}.`,
    },
    {
      role: "user" as const,
      content: `Current entity content:\n\n${input.currentContent}${researchSection}\n\nRewrite this ${input.entityKind} entity from scratch.`,
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
        label: `regenerate-entity:${input.entityKind}`,
      });
    } else {
      raw = await completeTextRouted(input.settings, messages, "create-from-research", {
        signal: input.signal,
        label: `regenerate-entity:${input.entityKind}`,
      });
    }
  } else {
    raw = await completeTextRouted(input.settings, messages, "create-from-research", {
      signal: input.signal,
      label: `regenerate-entity:${input.entityKind}`,
    });
  }

  const parsed = extractJson(raw);
  const body = str(parsed.body) || "# Entity\n\nGenerated from research.\n";
  const frontmatterPatches = (typeof parsed.frontmatterPatches === "object" && parsed.frontmatterPatches !== null)
    ? parsed.frontmatterPatches as Record<string, unknown>
    : {};

  return { proposedBody: body, proposedFrontmatterPatches: frontmatterPatches };
}

import { z } from "zod";
import { OUTLINE_BRIEF_FILE, parseOutlineBrief } from "narrarium-engine";
import { toolData, type ScopedToolOutcome } from "@/assistant/scopedTools";
import { readPageFiles } from "@/assistant/pages/proposal";
import type { PageCapability, PageEnv, PageTool } from "@/assistant/pages/types";

/**
 * The autopilot's Configuration page with the Copilot: it sees the settings of the autopilot of the book (how it reviews, its budgets, its pauses, where it
 * publishes) and the brief of the Synopsis, and reads them whole. It never changes them: the configuration is saved on its page, through the autopilot, so the
 * Copilot says what to change and where. What the autopilot planned and the secrets of its concept are not part of what it sees.
 */

const STATE_FILE = "autopilot/state.json";

const PROMPT = [
  "The author is on the Configuration page of the book's autopilot: its settings (the simulated readers and specialists it uses, the pauses, the chapters per session, the money and token budgets, how it reviews — the score to reach and the rounds — and where it publishes), and the brief it reads from the Synopsis (genre, audience, words per scene).",
  "You do not change the configuration yourself: it is saved on this page (its tabs Overview, Review, Retries, Publishing, Permanent rules, Profiles used), through the autopilot. Say what to change and in which tab.",
].join(" ");

function flatten(value: unknown, prefix = ""): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return [`${prefix}: ${value.map(String).join(", ") || "none"}`];
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => flatten(entry, prefix ? `${prefix}.${key}` : key));
  return [`${prefix}: ${String(value)}`];
}

/** What the Copilot sees of the autopilot: its state and its options, never its plan, its concept or its secrets. */
export function autopilotSettingsText(stateJson: string | null, brief: string | null): string {
  let state: Record<string, unknown> | null = null;
  try {
    state = stateJson ? (JSON.parse(stateJson) as Record<string, unknown>) : null;
  } catch {
    state = null;
  }
  const options = state && typeof state.options === "object" && state.options ? (state.options as Record<string, unknown>) : null;
  const rules = Array.isArray(state?.rules) ? state!.rules.length : 0;
  const reading = brief !== null ? parseOutlineBrief(brief) : null;
  return [
    state ? `Autopilot: ${String(state.status ?? "idle")}${typeof state.phase === "string" ? `, phase ${state.phase}` : ""}; ${rules} permanent rule${rules === 1 ? "" : "s"}.` : "The autopilot of this book was never configured: the page shows its defaults.",
    options ? `Settings:\n${flatten(options).map((entry) => `- ${entry}`).join("\n")}` : "",
    reading ? `Brief of the Synopsis: genre ${reading.brief.genre || "-"}; audience ${reading.brief.audience || "-"}; words per scene ${reading.brief.wordsPerScene}.` : "",
  ].filter(Boolean).join("\n");
}

async function load(env: PageEnv): Promise<string> {
  const files = await readPageFiles(env, [STATE_FILE, OUTLINE_BRIEF_FILE]);
  return autopilotSettingsText(files.get(STATE_FILE)?.content ?? null, files.get(OUTLINE_BRIEF_FILE)?.content ?? null);
}

const readSettings: PageTool = {
  id: "read_autopilot_settings",
  description: "the settings of the book's autopilot whole, and the brief it reads from the Synopsis",
  args: "{}",
  schema: z.object({}).strict() as never,
  async run(_args: Record<string, never>, env: PageEnv): Promise<ScopedToolOutcome> {
    return toolData("read_autopilot_settings", await load(env));
  },
};

export const autopilotSettingsPage: PageCapability = {
  id: "autopilot-settings",
  prompt: PROMPT,
  state: load,
  tools: [readSettings],
};

import { z } from "zod";
import type { ScopedToolOutcome } from "@/assistant/scopedTools";
import type { AssistantMessage } from "@/assistant/store";

/**
 * The assistant's tool loop, as Brainstorming and the page-aware Copilot run it: the model answers with a turn (its reply and the tools it calls), the results of
 * the tools that read come back to it in the next round, and a proposal, or a tool that answers the author itself, ends the turn. The last round is told to
 * answer. How a turn is asked is the caller's: Brainstorming asks for one JSON object in the text, which any model can write; the Copilot asks a model that
 * calls tools for one forced function.
 */

export interface ToolTurn {
  reply: string;
  calls: Array<{ tool: string; args: unknown }>;
}

/** The rounds a turn may take (the last one is told to answer), the calls of a round, and how much the results may weigh. */
export const MAX_TOOL_ROUNDS = 4;
export const MAX_TOOL_CALLS = 6;
export const TOOL_RESULTS_CHARS = 48_000;

const turnSchema = z.object({
  reply: z.string().max(40_000).default(""),
  calls: z.array(z.object({ tool: z.string().max(80), args: z.unknown().optional() })).max(16).default([]),
});

function turnFrom(value: unknown): ToolTurn | null {
  const parsed = turnSchema.safeParse(value);
  return parsed.success ? { reply: parsed.data.reply.trim(), calls: parsed.data.calls.map((call) => ({ tool: call.tool, args: argsOf(call.args) })) } : null;
}

/** The arguments of a call: an object, or the same object written as text (some models put JSON in a string). */
function argsOf(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

/** The model's answer: its JSON (in a fence or among words), or, from a model that answered in plain words, those words and no call. */
export function parseToolTurn(raw: string): ToolTurn {
  const text = raw.trim();
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  for (const candidate of [unfenced, ...(first >= 0 && last > first ? [unfenced.slice(first, last + 1)] : [])]) {
    try {
      const turn = turnFrom(JSON.parse(candidate));
      if (turn) return turn;
    } catch {
      // Not this one.
    }
  }
  return { reply: text, calls: [] };
}

/** A turn as a forced function delivers it: its arguments as an object (or as text, from a model that answered in words). */
export function toolTurnOf(value: unknown): ToolTurn {
  if (typeof value === "string") return parseToolTurn(value);
  return turnFrom(value) ?? { reply: "", calls: [] };
}

/** What one call made: a tool of the scope (what it read, a proposal, a refusal), or a tool that answered the author itself (the turn ends with its message). */
export type ToolLoopOutcome = ScopedToolOutcome | { tool: string; kind: "answer"; message: AssistantMessage };

export interface ToolLoopResult {
  /** The model's last reply. */
  answer: string;
  /** The proposal of the turn, which waits for the author. */
  proposal: AssistantMessage | null;
  /** The message of a tool that answered the author itself. */
  final: AssistantMessage | null;
  /** The lines the tools wrote for the author, once each. */
  notes: string[];
  /** The tools the model called that the scope does not have. */
  refused: string[];
}

export async function runToolLoop(input: {
  ask(results: readonly string[], last: boolean): Promise<ToolTurn>;
  run(call: { tool: string; args: unknown }): Promise<ToolLoopOutcome>;
  /** How a reply is read back (the prompt's escaping undone). */
  unescape?: (text: string) => string;
  maxRounds?: number;
  maxCalls?: number;
}): Promise<ToolLoopResult> {
  const maxRounds = input.maxRounds ?? MAX_TOOL_ROUNDS;
  const results: string[] = [];
  const notes: string[] = [];
  const refused = new Set<string>();
  let proposal: AssistantMessage | null = null;
  let final: AssistantMessage | null = null;
  let answer = "";
  for (let round = 0; round < maxRounds; round += 1) {
    const last = round === maxRounds - 1;
    const turn = await input.ask(results, last);
    answer = (input.unescape ? input.unescape(turn.reply) : turn.reply) || answer;
    if (!turn.calls.length || last) break;
    let read = false;
    for (const call of turn.calls.slice(0, input.maxCalls ?? MAX_TOOL_CALLS)) {
      const outcome = await input.run(call);
      if (outcome.kind === "answer") {
        final = outcome.message;
        break;
      }
      if (outcome.kind === "proposal") {
        if (proposal) {
          results.push(`${outcome.tool}: not proposed, one proposal at a time: the author decides about the first one before another.`);
          continue;
        }
        proposal = outcome.message;
        results.push(`${outcome.tool}: ${outcome.text}`);
        continue;
      }
      read = true;
      results.push(`${outcome.tool}${outcome.kind === "refused" ? " (refused)" : ""}: ${outcome.text}`);
      if (outcome.kind === "refused" && outcome.unknown) refused.add(outcome.tool);
      if (outcome.kind === "data" && outcome.note) notes.push(outcome.note);
    }
    // A proposal waits for the author, a tool that answered has answered, and a round that only refused what it asked has nothing new to read.
    if (final || proposal || !read) break;
  }
  return { answer, proposal, final, notes: [...new Set(notes)], refused: [...refused] };
}

export function clipToolResults(text: string, max = TOOL_RESULTS_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cut)` : text;
}

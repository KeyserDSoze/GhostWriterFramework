import type { z } from "zod";
import type { AssistantMessage } from "@/assistant/store";

/**
 * The tools of a scope of the assistant (Brainstorming on the Synopsis, the Copilot on a page of the book): each says what it does and what it takes as the model
 * reads it, checks its arguments with its own schema, and answers with what it read (for the model's next round), a proposal the author decides about (the
 * turn ends with it), or a refusal. A call to a tool the scope does not have is refused here, in code, whatever the model writes.
 */

export type ScopedToolOutcome<Id extends string = string> =
  /** What the tool read or found, for the model's next round; `note` is a line for the author too. */
  | { tool: Id; kind: "data"; text: string; note?: string }
  /** A change the author sees and applies, or not: the turn ends with it. */
  | { tool: Id; kind: "proposal"; message: AssistantMessage; text: string }
  /** Not run: a tool the scope does not have (`unknown`), arguments that are not valid, or a refusal of the tool itself. */
  | { tool: string; kind: "refused"; text: string; unknown: boolean };

export interface ScopedTool<A, E, Id extends string = string> {
  id: Id;
  /** What the tool does and what it takes, as the model reads it. */
  description: string;
  args: string;
  schema: z.ZodType<A>;
  run(args: A, env: E): Promise<ScopedToolOutcome<Id>>;
}

export const toolData = <Id extends string>(tool: Id, text: string, note?: string): ScopedToolOutcome<Id> => ({ tool, kind: "data", text, ...(note ? { note } : {}) });
export const toolRefused = (tool: string, text: string, unknown = false): ScopedToolOutcome<never> => ({ tool, kind: "refused", text, unknown });

/** The tools as the model reads them in its instructions. */
export function scopedToolLines(tools: ReadonlyArray<Pick<ScopedTool<unknown, unknown>, "id" | "args" | "description">>): string[] {
  return tools.map((tool) => `- ${tool.id} ${tool.args}: ${tool.description}.`);
}

/** Runs one call of the model: a tool of the scope with valid arguments, or nothing at all (a refusal the model and the author are told). */
export async function runScopedTool<E>(
  registry: ReadonlyMap<string, ScopedTool<never, E>>,
  call: { tool: string; args?: unknown },
  env: E,
  unknownTool: (tool: string) => string,
): Promise<ScopedToolOutcome> {
  const tool = registry.get(call.tool) as ScopedTool<unknown, E> | undefined;
  if (!tool) return toolRefused(call.tool, unknownTool(call.tool), true);
  const parsed = tool.schema.safeParse(call.args ?? {});
  if (!parsed.success) return toolRefused(tool.id, `${tool.id}: the arguments are not valid (${parsed.error.issues.map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`).join("; ")}), so nothing was run. It takes ${tool.args}.`);
  try {
    return await tool.run(parsed.data, env);
  } catch (error) {
    return toolRefused(tool.id, `${tool.id} could not be run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

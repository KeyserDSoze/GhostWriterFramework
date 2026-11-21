import { parseJsonReply, StructuredReplyError } from "../util/json.js";
import { AiReplyRejectedError, type AiJsonSchema } from "./types.js";

/** Top-level keys the schema marks as required. */
export function schemaRequiredKeys(schema: AiJsonSchema | undefined): string[] {
  const required = (schema?.parameters as { required?: unknown } | undefined)?.required;
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === "string" && key.length > 0) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseMaybe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A JSON string, also encoded twice, becomes the value it contains. */
function decodeJsonString(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 2 && typeof current === "string"; depth += 1) {
    const parsed = parseMaybe(current.trim());
    if (parsed === undefined) break;
    current = parsed;
  }
  return current;
}

function hasEvery(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Tool arguments as models really send them, made usable: a JSON string (also double-encoded)
 * is parsed, and a single-key wrapper such as `{"arguments": {...}}` or `{"result": "{...}"}`
 * is unwrapped only when the outer object lacks the schema's required keys and the inner one
 * has them all. Anything else is returned unchanged, so the function is idempotent.
 */
export function normalizeStructuredValue(value: unknown, required: string[]): unknown {
  const current = decodeJsonString(value);
  if (!required.length || !isRecord(current) || hasEvery(current, required)) return current;
  const inner = Object.values(current);
  if (inner.length !== 1) return current;
  const candidate = decodeJsonString(inner[0]);
  return hasEvery(candidate, required) ? candidate : current;
}

/** True for empty function-call arguments: nothing, whitespace or `{}`. */
export function isEmptyToolArguments(args: string | null | undefined): boolean {
  const text = (args ?? "").trim();
  if (!text) return true;
  const parsed = parseMaybe(text);
  return isRecord(parsed) && Object.keys(parsed).length === 0;
}

/** Remove a leading reasoning block some local models leave in the reply content. */
export function stripReasoningBlock(text: string): string {
  return splitReasoningBlock(text).reply;
}

/**
 * Separate a leading `<think>` (or `<thinking>`, `<reasoning>`) block from the reply, also when
 * it is unterminated because the output limit cut it. Only its length is reported.
 */
export function splitReasoningBlock(text: string): { reply: string; reasoningCharacters: number } {
  const match = /^\s*<(think|thinking|reasoning)>([\s\S]*?)(?:<\/\1>|$)/i.exec(text ?? "");
  if (!match) return { reply: text ?? "", reasoningCharacters: 0 };
  return { reply: (text ?? "").slice(match[0].length).replace(/^\s+/, ""), reasoningCharacters: match[2].length };
}

function acceptor(required: string[], mode: "all" | "any"): (value: unknown) => boolean {
  return (value) => {
    const normalized = normalizeStructuredValue(value, required);
    if (!isRecord(normalized) || Object.keys(normalized).length === 0) return false;
    if (!required.length) return true;
    return mode === "all" ? hasEvery(normalized, required) : required.some((key) => Object.prototype.hasOwnProperty.call(normalized, key));
  };
}

function expectedFields(required: string[]): string {
  if (!required.length) return "";
  const shown = required.slice(0, 8).map((key) => `"${key}"`).join(", ");
  return ` Expected fields: ${shown}${required.length > 8 ? ", ..." : ""}.`;
}

/**
 * The structured value of a plain-text reply: the first JSON object with every required key,
 * else the first with at least one of them (the task then names what is missing). A JSON
 * schema the model echoes before answering is never mistaken for the answer.
 */
export function parseStructuredText(text: string, schema: AiJsonSchema): unknown {
  const required = schemaRequiredKeys(schema);
  const source = stripReasoningBlock(text);
  const passes = required.length ? [acceptor(required, "all"), acceptor(required, "any")] : [acceptor(required, "all")];
  let lastError: unknown = null;
  for (const accept of passes) {
    try {
      return normalizeStructuredValue(parseJsonReply(source, accept), required);
    } catch (error) {
      lastError = error;
    }
  }
  const reason = lastError instanceof StructuredReplyError ? lastError.message : "The model reply is not valid JSON.";
  throw new AiReplyRejectedError(`${reason}${expectedFields(required)}`);
}

/** Fields the schema declares as lists or objects but the model sent as JSON strings are decoded. */
function decodeStringifiedFields(record: Record<string, unknown>, schema: AiJsonSchema): Record<string, unknown> {
  const properties = (schema.parameters as { properties?: Record<string, { type?: unknown } | undefined> }).properties ?? {};
  let output = record;
  for (const [key, definition] of Object.entries(properties)) {
    const value = record[key];
    const type = definition?.type;
    if (typeof value !== "string" || (type !== "array" && type !== "object")) continue;
    const parsed = parseMaybe(value.trim());
    if (type === "array" ? !Array.isArray(parsed) : !isRecord(parsed)) continue;
    if (output === record) output = { ...record };
    output[key] = parsed;
  }
  return output;
}

/** Reject what must never be treated as an answer: anything but a non-empty JSON object. */
export function structuredReply(value: unknown, schema: AiJsonSchema): Record<string, unknown> {
  const normalized = normalizeStructuredValue(value, schemaRequiredKeys(schema));
  if (!isRecord(normalized)) throw new AiReplyRejectedError(`The structured reply (${schema.name}) is not a JSON object.${expectedFields(schemaRequiredKeys(schema))}`);
  if (Object.keys(normalized).length === 0) throw new AiReplyRejectedError(`The structured reply (${schema.name}) is empty ("{}").${expectedFields(schemaRequiredKeys(schema))}`);
  return decodeStringifiedFields(normalized, schema);
}

/**
 * The structured value of a provider reply: the forced function call's arguments or, when the
 * model answered in text (or called the function with empty arguments), the JSON in the content.
 * Throws a retryable `AiReplyRejectedError` that never quotes the reply.
 */
export function structuredFromReply(input: { toolArguments?: string | null; content?: string | null; schema: AiJsonSchema }): Record<string, unknown> {
  const required = schemaRequiredKeys(input.schema);
  const args = (input.toolArguments ?? "").trim();
  const content = (input.content ?? "").trim();
  let argumentsError: unknown = null;
  if (args && !isEmptyToolArguments(args)) {
    const direct = parseMaybe(args);
    try {
      return structuredReply(direct !== undefined ? normalizeStructuredValue(direct, required) : parseStructuredText(args, input.schema), input.schema);
    } catch (error) {
      argumentsError = error;
    }
  }
  if (content) {
    try {
      return structuredReply(parseStructuredText(content, input.schema), input.schema);
    } catch (error) {
      throw argumentsError ?? error;
    }
  }
  if (argumentsError) throw argumentsError;
  if (args) throw new AiReplyRejectedError(`The model called ${input.schema.name} with empty arguments ("{}").${expectedFields(required)}`);
  throw new AiReplyRejectedError(`The model returned an empty reply where JSON was expected.${expectedFields(required)}`);
}

export type StructuredFieldRule = "present" | "text" | "number" | "list";

const RULE_NAMES: Record<Exclude<StructuredFieldRule, "present">, string> = { text: "text", number: "a number", list: "a list" };

function satisfies(value: unknown, rule: StructuredFieldRule): boolean {
  if (rule === "list") return Array.isArray(value);
  if (rule === "text") return typeof value === "string";
  if (rule === "number") return Number.isFinite(typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : Number.NaN);
  return true;
}

/**
 * Require the fields a task really depends on. A missing, empty or mistyped field rejects the
 * reply with a retryable error that names the field, so the engine never turns an incomplete
 * reply into defaults (an approval, "no problems", an ignored rewrite...).
 */
export function requireStructuredFields(value: unknown, rules: Record<string, StructuredFieldRule>, subject = "The reply"): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  const problems: string[] = [];
  for (const [key, rule] of Object.entries(rules)) {
    const field = record[key];
    if (field === undefined || field === null || (typeof field === "string" && !field.trim())) problems.push(`the field "${key}" is missing`);
    else if (!satisfies(field, rule)) problems.push(`the field "${key}" is not ${RULE_NAMES[rule as Exclude<StructuredFieldRule, "present">]}`);
  }
  if (problems.length) throw new AiReplyRejectedError(`${subject} was rejected: ${problems.join("; ")}.`);
  return record;
}

/**
 * `tool_choice` forcing the only tool sent. llama.cpp and LM Studio ignore the named form and
 * fall back to "auto" without their grammar, while "required" is understood by them and by the
 * hosted OpenAI-compatible APIs. Azure OpenAI API versions before 2024-06-01 only know the named form.
 */
export function forcedToolChoice(provider: string, apiVersion: string | undefined, toolName: string): "required" | { type: "function"; function: { name: string } } {
  if (provider === "azure_openai") {
    const version = (apiVersion ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(version) && version.slice(0, 10) < "2024-06-01") return { type: "function", function: { name: toolName } };
  }
  return "required";
}

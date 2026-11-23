export type JsonType = "object" | "string" | "integer" | "number" | "boolean" | "array" | "null";

/**
 * The part of JSON Schema that the tools of the MCP endpoint use. One object is both what `tools/list` publishes to a model and what a call's
 * arguments are checked against, so what a tool says it takes and what it takes cannot drift apart.
 */
export interface JsonSchema {
  /** One type, or a type and `"null"` (`["string", "null"]`: a value that may be taken away by sending null), as JSON Schema writes it. */
  type?: JsonType | readonly JsonType[];
  description?: string;
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  /** `false` (what the tools use): nothing but the named properties. `true`: any other property, whose value the tool itself judges. */
  additionalProperties?: boolean;
}

export const string = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "string", description, ...extra });
export const integer = (description: string, minimum: number, maximum: number): JsonSchema => ({ type: "integer", description, minimum, maximum });
export const boolean = (description: string): JsonSchema => ({ type: "boolean", description });
export const choice = (description: string, values: readonly string[]): JsonSchema => ({ type: "string", description, enum: values });
export const list = (description: string, items: JsonSchema, maxItems: number): JsonSchema => ({ type: "array", description, items, maxItems });
export const free = (description: string): JsonSchema => ({ type: "object", description, additionalProperties: true });
/** A property that may also be `null` (a way to take its value away). */
export const nullable = (schema: JsonSchema): JsonSchema => ({ ...schema, type: [(Array.isArray(schema.type) ? schema.type[0] : schema.type) as JsonType, "null"] });

/** An object that takes the properties it names and nothing else. */
export function shape(properties: Record<string, JsonSchema>, required: readonly string[] = [], description?: string): JsonSchema {
  return { type: "object", ...(description ? { description } : {}), properties, required: [...required], additionalProperties: false };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const quoted = (path: string) => `\`${path}\``;

/** What is wrong with `value` as seen by `schema`, in a sentence that names the property (`path`), or `undefined` when it is fine. */
export function problemWith(schema: JsonSchema, value: unknown, path = "arguments"): string | undefined {
  if (Array.isArray(schema.type)) {
    const types = schema.type as readonly JsonType[];
    if (value === null) return types.includes("null") ? undefined : `${quoted(path)} must not be null.`;
    return problemWith({ ...schema, type: types.find((type) => type !== "null") }, value, path);
  }
  switch (schema.type as JsonType | undefined) {
    case "object": {
      if (!isObject(value)) return `${quoted(path)} must be an object.`;
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) if (value[key] === undefined) return `${quoted(path === "arguments" ? key : `${path}.${key}`)} is required.`;
      for (const [key, entry] of Object.entries(value)) {
        const property = properties[key];
        const name = path === "arguments" ? key : `${path}.${key}`;
        if (!property) {
          if (schema.additionalProperties === true) continue;
          return `${quoted(name)} is not a property of this tool. It takes: ${Object.keys(properties).join(", ") || "nothing"}.`;
        }
        const problem = problemWith(property, entry, name);
        if (problem) return problem;
      }
      return undefined;
    }
    case "string": {
      if (typeof value !== "string") return `${quoted(path)} must be a string.`;
      if (schema.enum && !schema.enum.includes(value)) return `${quoted(path)} must be one of: ${schema.enum.join(", ")}.`;
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${quoted(path)} must have at least ${schema.minLength} character${schema.minLength === 1 ? "" : "s"}.`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${quoted(path)} must have at most ${schema.maxLength} characters (it has ${value.length}).`;
      return undefined;
    }
    case "integer":
    case "number": {
      const whole = schema.type === "integer";
      if (typeof value !== "number" || !Number.isFinite(value) || (whole && !Number.isInteger(value))) return `${quoted(path)} must be ${whole ? "an integer" : "a number"}.`;
      if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) return `${quoted(path)} must be ${whole ? "an integer" : "a number"} from ${schema.minimum ?? "any"} to ${schema.maximum ?? "any"}.`;
      return undefined;
    }
    case "boolean":
      return typeof value === "boolean" ? undefined : `${quoted(path)} must be true or false.`;
    case "array": {
      if (!Array.isArray(value)) return `${quoted(path)} must be a list.`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${quoted(path)} may have at most ${schema.maxItems} items.`;
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${quoted(path)} must have at least ${schema.minItems} items.`;
      for (let index = 0; index < value.length; index += 1) {
        const problem = schema.items ? problemWith(schema.items, value[index], `${path}[${index}]`) : undefined;
        if (problem) return problem;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

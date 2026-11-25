/**
 * What a provider says when it refuses or fails a request, read the same way whatever its shape: the HTTP status, and the words of the provider (its message, its type, the parameter it names, its
 * code) as it wrote them. The one place that reads an error body (the engine's client, for an HTTP failure and for an error inside a stream); nothing here is a key, and nothing is the request.
 */

/** How the body of an error was read: the shape it had, or why it has no words (`empty`), or what it was instead (`html`: the page of a gateway; `text`: words that are not in a known shape). */
export type AiErrorShape = "openai" | "azure" | "anthropic" | "gemini" | "message" | "detail" | "text" | "html" | "empty";

/**
 * The normalized body of an error response. `message` is the provider's own words, never shortened except with an ellipsis; `type`, `param` and `code` are its own fields when it has them (a
 * Gemini `status` is a `type`, an Azure `innererror.code` the `type` it lacks). `raw` is the body itself when it was not a known shape: its text, cut at `MAX_ERROR_RAW_CHARACTERS` with an ellipsis. Every
 * word has been cleaned of credentials. A response with no body says only its status (`shape: "empty"`).
 */
export interface AiErrorBody {
  status: number;
  message?: string;
  type?: string;
  param?: string;
  code?: string;
  raw?: string;
  shape: AiErrorShape;
}

/** The most characters of what a provider said that a body keeps (its message, and each of its type, param and code up to a tenth of it). */
export const MAX_ERROR_MESSAGE_CHARACTERS = 2000;
/** The most characters of a body that was not a known shape that `raw` keeps: about two kilobytes. */
export const MAX_ERROR_RAW_CHARACTERS = 2048;
/** The most of a body that is read at all. */
const MAX_BODY_READ = 50_000;
const FIELD_CHARACTERS = 200;

/** The text cut at `limit` characters, with an ellipsis where it was cut (and never in the middle of a pair of UTF-16 units). */
export function clipWithEllipsis(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = Math.max(0, limit - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

function wordOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** The title of a page, or the first words of its text: what a gateway's page says of itself, for one line. */
function pageTitle(html: string): string | undefined {
  return /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || undefined;
}

const HTML_PAGE = /^\s*<(?:!doctype\s+html|html)\b/i;

/** What a FastAPI-style `detail` (a text, or a list of validation problems with their place) says, in one text. */
function detailText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const lines = value.map((entry) => {
    if (typeof entry === "string") return entry.trim();
    if (!entry || typeof entry !== "object") return "";
    const { loc, msg, message } = entry as { loc?: unknown; msg?: unknown; message?: unknown };
    const where = Array.isArray(loc) ? loc.filter((part) => typeof part === "string" || typeof part === "number").join(".") : "";
    const said = typeof msg === "string" ? msg : typeof message === "string" ? message : "";
    return said ? `${where ? `${where}: ` : ""}${said.trim()}` : "";
  }).filter(Boolean);
  return lines.length ? lines.join("; ") : undefined;
}

interface ReadFields {
  shape: AiErrorShape;
  message?: string;
  type?: string;
  param?: string;
  code?: string;
}

/** The fields of the error object of a provider (`{ message, type, param, code }` and the variants of Azure, Anthropic and Gemini), or nothing when it says no words. */
function fieldsOfObject(source: Record<string, unknown>, root: Record<string, unknown> | undefined): ReadFields | undefined {
  const inner = source.innererror && typeof source.innererror === "object" ? source.innererror as Record<string, unknown> : undefined;
  const message = wordOf(source.message) ?? wordOf(inner?.message);
  if (!message) return undefined;
  const typed = wordOf(source.type);
  const status = wordOf(source.status);
  // `{ error: { message } }` is the OpenAI shape that every compatible gateway speaks; Azure's own has a code (a text) and no type, or an inner error.
  const shape: AiErrorShape = root?.type === "error" && typed ? "anthropic" : inner ? "azure" : status && !typed && typeof source.code === "number" ? "gemini" : typed || typeof source.code !== "string" ? "openai" : "azure";
  // Gemini says its kind in `status` («INVALID_ARGUMENT»), Azure in the code of its inner error: they are the `type` that the error has no field for.
  const type = typed ?? (shape === "gemini" ? status : undefined) ?? wordOf(inner?.code);
  return {
    shape,
    message,
    ...(type ? { type } : {}),
    ...(wordOf(source.param) ? { param: wordOf(source.param) } : {}),
    ...(wordOf(source.code) ? { code: wordOf(source.code) } : {}),
  };
}

/** Reads the parsed JSON of a body: the known shapes, or nothing (the body is then shown as it is). */
function fieldsOfJson(parsed: unknown): ReadFields | undefined {
  const root = Array.isArray(parsed) ? parsed.find((entry) => entry && typeof entry === "object") : parsed;
  if (!root || typeof root !== "object") return undefined;
  const source = root as Record<string, unknown>;
  const error = source.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const read = fieldsOfObject(error as Record<string, unknown>, source);
    if (read) return read;
  }
  if (typeof error === "string" && error.trim()) return { shape: "message", message: error.trim(), ...(wordOf(source.code) ? { code: wordOf(source.code) } : {}), ...(wordOf(source.type) ? { type: wordOf(source.type) } : {}) };
  const detail = detailText(source.detail);
  if (detail) return { shape: "detail", message: detail };
  const message = wordOf(source.message) ?? wordOf(source.error_description) ?? wordOf(source.msg);
  if (message) return { shape: "message", message, ...(wordOf(source.type) ? { type: wordOf(source.type) } : {}), ...(wordOf(source.param) ? { param: wordOf(source.param) } : {}), ...(wordOf(source.code) ? { code: wordOf(source.code) } : {}) };
  return undefined;
}

/**
 * The body of an error response, normalized. `redact` cleans every word of credentials (the integrations' keys, bearer tokens, signatures and the keys of a query: `redactSecrets` with the secrets of the
 * configuration). A JSON body in a shape that is known gives its message, type, param and code; anything else (a text, a page, a JSON in a shape nobody knows) is kept as it is, cut at about two kilobytes
 * with an ellipsis; a body that is empty says so. The status is always kept.
 */
export function parseErrorBody(status: number, text: string, redact: (text: string) => string = (value) => value): AiErrorBody {
  const body = (text ?? "").length > MAX_BODY_READ ? text.slice(0, MAX_BODY_READ) : text ?? "";
  const trimmed = body.trim();
  if (!trimmed) return { status, shape: "empty" };
  const clean = (value: string, limit: number): string => clipWithEllipsis(redact(value), limit);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    const read = parsed === undefined ? undefined : fieldsOfJson(parsed);
    if (read) {
      return {
        status,
        shape: read.shape,
        ...(read.message ? { message: clean(read.message, MAX_ERROR_MESSAGE_CHARACTERS) } : {}),
        ...(read.type ? { type: clean(read.type, FIELD_CHARACTERS) } : {}),
        ...(read.param ? { param: clean(read.param, FIELD_CHARACTERS) } : {}),
        ...(read.code ? { code: clean(read.code, FIELD_CHARACTERS) } : {}),
      };
    }
  }
  if (HTML_PAGE.test(trimmed)) {
    const title = pageTitle(trimmed);
    return { status, shape: "html", message: clean(`an HTML page from a gateway or a proxy${title ? ` ("${title}")` : ""}, not an answer of the provider`, 400), raw: clean(trimmed, MAX_ERROR_RAW_CHARACTERS) };
  }
  return { status, shape: "text", raw: clean(trimmed, MAX_ERROR_RAW_CHARACTERS) };
}

/**
 * The body of the error object that a provider puts inside a stream that answered 200 (`{ error: { message, type, code } }` or the error itself, or a text): the same fields, the status the stream
 * had. `undefined` when it says nothing.
 */
export function errorBodyOfObject(value: unknown, status: number, redact: (text: string) => string = (text) => text): AiErrorBody | undefined {
  if (typeof value === "string") return value.trim() ? parseErrorBody(status, JSON.stringify({ message: value }), redact) : undefined;
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const read = fieldsOfJson(source.error && typeof source.error === "object" ? source : { error: source });
  if (!read) return Object.keys(source).length ? parseErrorBody(status, JSON.stringify(source), redact) : undefined;
  return parseErrorBody(status, JSON.stringify({ error: { message: read.message, ...(read.type ? { type: read.type } : {}), ...(read.param ? { param: read.param } : {}), ...(read.code ? { code: read.code } : {}) } }), redact);
}

/** What the provider said, on one line, for the text of an error: `HTTP 400 — the message [type: …, param: …, code: …]`, or `HTTP 400, no body`. */
export function describeErrorBody(body: AiErrorBody): string {
  if (body.shape === "empty") return `HTTP ${body.status}, no body`;
  const said = (body.message ?? body.raw ?? "").replace(/\s+/g, " ").trim();
  const fields = [body.type ? `type: ${body.type}` : "", body.param ? `param: ${body.param}` : "", body.code ? `code: ${body.code}` : ""].filter(Boolean);
  return `HTTP ${body.status}${said ? ` — ${said}` : ""}${fields.length ? ` [${fields.join(", ")}]` : ""}`;
}

/** A body read from elsewhere (a detail of a file, a record, a host that is not this one): only the known fields that are valid, cleaned, cut. `undefined` when it says nothing about itself. */
export function normalizeErrorBody(value: unknown, redact: (text: string) => string = (text) => text): AiErrorBody | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const status = typeof source.status === "number" && Number.isInteger(source.status) && source.status >= 100 && source.status < 600 ? source.status : undefined;
  const shape = (["openai", "azure", "anthropic", "gemini", "message", "detail", "text", "html", "empty"] as const).find((entry) => entry === source.shape);
  if (status === undefined || !shape) return undefined;
  const text = (entry: unknown, limit: number): string | undefined => (typeof entry === "string" && entry.trim() ? clipWithEllipsis(redact(entry), limit) : undefined);
  const message = text(source.message, MAX_ERROR_MESSAGE_CHARACTERS);
  const type = text(source.type, FIELD_CHARACTERS);
  const param = text(source.param, FIELD_CHARACTERS);
  const code = text(source.code, FIELD_CHARACTERS);
  const raw = text(source.raw, MAX_ERROR_RAW_CHARACTERS);
  return { status, shape, ...(message ? { message } : {}), ...(type ? { type } : {}), ...(param ? { param } : {}), ...(code ? { code } : {}), ...(raw ? { raw } : {}) };
}

/** What a refusal of the thinking level names: the OpenAI field, or the chat-template argument that some models take it in. */
const THINKING_PARAMETER = /reasoning[\s_-]?effort|reasoning[\s_-]?strength|chat[\s_-]?template[\s_-]?kwargs/i;
/** Function tools, in the words providers use for them. */
const TOOLS_WORDS = /\b(?:tools?|functions?|function[\s_-]?call(?:s|ing)?|tool[\s_-]?(?:calls?|calling|use|choice))\b/i;
/** A refusal, in the words providers use for it. */
const REFUSAL_WORDS = /not supported|unsupported|not allowed|not available|not compatible|incompatible|not permitted|cannot|can't|can not|(?:does not|doesn't|do not|don't) support|only supported/i;
/** A refusal of the value of a level, not of the level together with tools: «Unsupported value: 'xhigh'…». */
const VALUE_REFUSAL = /unsupported value|invalid value|supported values|must be one of|is not one of|invalid (?:reasoning|effort|level)/i;

/**
 * Whether a provider refuses the thinking level because the request also carries function tools («Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use
 * function tools, use /v1/responses or set reasoning_effort to 'none'.»): a 400 or a 422 whose words name the level (or whose `param` is the level), speak of tools and say that it is refused. A refusal of the
 * value of the level is another thing, so is a model that takes no level at all (the words say nothing of tools), and so is any other 400. It reads the words and the parameter, never the name of the model.
 */
export function refusesThinkingWithTools(body: AiErrorBody | undefined): boolean {
  if (!body || (body.status !== 400 && body.status !== 422)) return false;
  const said = `${body.message ?? ""} ${body.raw ?? ""}`;
  const named = THINKING_PARAMETER.test(said) || (typeof body.param === "string" && THINKING_PARAMETER.test(body.param));
  if (!named || VALUE_REFUSAL.test(said)) return false;
  return TOOLS_WORDS.test(said) && REFUSAL_WORDS.test(said);
}

/** Whether the provider's words tell to use the Responses API (`/v1/responses`) instead: what a notice offers first. */
export function suggestsResponsesApi(body: AiErrorBody | undefined): boolean {
  return /\/(?:openai\/)?(?:v1\/)?responses\b/i.test(`${body?.message ?? ""} ${body?.raw ?? ""}`);
}

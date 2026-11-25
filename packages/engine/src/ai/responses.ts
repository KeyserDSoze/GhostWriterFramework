/**
 * The reading side of the Responses API: what its events and its bodies say, told in the shape the client already reads a reply in (the chunk of a Chat Completions stream: a piece of text, a piece of a function
 * call, the reason a reply ended, the tokens it used, an error). A reply of the Responses API is then read, judged and reported by the very code that reads the other: the deadlines, the progress, the live JSON of a
 * structured reply, the usage and the failures are the same for both protocols, and nothing in the client knows two ways of doing them.
 *
 * Pure: it calls nothing and keeps nothing but what it has read of one stream. Every field of a provider's JSON is read defensively: what is not what it should be is as if it were not there.
 */

/** What a piece of a reply is, in the form the client reads (see the module's description). */
export interface ResponsesChunk {
  choices: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{ index: number; function: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  /** The tokens of the response, as the provider reports them (`input_tokens`, `output_tokens` and their details). */
  usage?: unknown;
  /** The failure the provider reports, in the shape of its error (`code`, `type`, `message`, `param`). */
  error?: unknown;
  /** What the model said when it refused to answer instead of answering. */
  refusal?: string;
  /** The characters of reasoning that this piece shows (only their number is kept, never the reasoning). */
  reasoningCharacters?: number;
  /** The tokens the model spent reasoning, as the provider counts them: its reasoning is not shown, so this is all there is to tell that it reasoned. */
  reasoningTokens?: number;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const position = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** What `incomplete_details.reason` says, as a finish reason of the client's vocabulary (`classifyFinishReason`): the output limit is `length`, a content filter is `content_filter`; any other reason is `incomplete`, which is no end that can be trusted. */
function incompleteReason(details: unknown): string {
  const reason = text(record(details).reason).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (reason === "max_output_tokens" || reason === "max_tokens" || reason === "length") return "length";
  if (reason === "content_filter") return "content_filter";
  return "incomplete";
}

/** The text of the `output_text` parts of a message item, and what its `refusal` parts say, by the position of the part. */
function messageParts(item: Record<string, unknown>): Array<{ text: string; refusal: string }> {
  const parts = Array.isArray(item.content) ? item.content : [];
  return parts.map((part) => {
    const entry = record(part);
    return { text: entry.type === "output_text" ? text(entry.text) : "", refusal: entry.type === "refusal" ? text(entry.refusal) : "" };
  });
}

/** The characters of the reasoning that a reasoning item shows (its summary, and the reasoning itself when the model gives it): none for a reasoning that is encrypted. */
function reasoningLength(item: Record<string, unknown>): number {
  let characters = 0;
  for (const list of [item.summary, item.content]) {
    for (const entry of Array.isArray(list) ? list : []) characters += text(record(entry).text).length;
  }
  return characters;
}

/** What a whole response says, told as one reply: used by a reply that is not streamed, and by the last event of a stream for what its pieces did not bring. */
export interface ResponsesReading {
  /** The `output_text` of its messages, joined. */
  text: string;
  refusal: string;
  /** The function calls of its output, by the position of the item in it. */
  calls: Array<{ index: number; name: string; arguments: string }>;
  reasoningCharacters: number;
  reasoningTokens?: number;
  /** How the reply ended, as a finish reason of the client's vocabulary. */
  finishReason: string;
  usage?: unknown;
  /** The failure of a response whose status is `failed`. */
  error?: unknown;
}

/**
 * A response read as one reply. Its status decides how it ended (`status` is the one the event that carried it says, else the response's own): `completed` is `stop`, or `tool_calls` when it has a function call,
 * `incomplete` says why in `incomplete_details` (the output limit is `length`), `failed` brings its error, `cancelled` is an end that no reply survives, and a refusal with no text and no call is `refusal`. A response
 * that says no status is what a server that only sends the output gives: it is read for the output it has.
 */
export function readResponse(value: unknown, status?: "completed" | "incomplete" | "failed"): ResponsesReading {
  const response = record(value);
  const output = Array.isArray(response.output) ? response.output : [];
  const pieces: string[] = [];
  const refusals: string[] = [];
  const calls: ResponsesReading["calls"] = [];
  let reasoningCharacters = 0;
  output.forEach((entry, at) => {
    const item = record(entry);
    if (item.type === "message") {
      for (const part of messageParts(item)) {
        if (part.text) pieces.push(part.text);
        if (part.refusal) refusals.push(part.refusal);
      }
    } else if (item.type === "function_call") {
      calls.push({ index: at, name: text(item.name), arguments: text(item.arguments) });
    } else if (item.type === "reasoning") {
      reasoningCharacters += reasoningLength(item);
    }
  });
  const body = pieces.join("");
  const refusal = refusals.join(" ").trim();
  const state = status ?? text(response.status).trim().toLowerCase();
  const usage = record(response.usage);
  const reasoningTokens = count(record(usage.output_tokens_details).reasoning_tokens);
  let finishReason: string;
  let error: unknown;
  if (state === "failed") {
    finishReason = "failed";
    error = response.error ?? undefined;
  } else if (state === "cancelled" || state === "canceled") {
    finishReason = "cancelled";
  } else if (state === "incomplete") {
    finishReason = incompleteReason(response.incomplete_details);
  } else if (refusal && !body.trim() && !calls.length) {
    finishReason = "refusal";
  } else {
    finishReason = calls.length ? "tool_calls" : "stop";
  }
  return {
    text: body,
    refusal,
    calls,
    reasoningCharacters,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    finishReason,
    ...(response.usage && typeof response.usage === "object" ? { usage: response.usage } : {}),
    ...(error ? { error } : {}),
  };
}

/** A response that is not streamed, told in the form the client reads a Chat Completions body in (`choices[0].message`), so that the same code reads it. */
export interface ResponsesAsChat {
  choices: Array<{ message: { content: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }>;
  usage?: unknown;
  error?: unknown;
  refusal?: string;
  reasoningCharacters: number;
  reasoningTokens?: number;
}

export function responseAsChat(value: unknown): ResponsesAsChat {
  const reading = readResponse(value);
  return {
    choices: [{
      message: {
        content: reading.text,
        ...(reading.calls.length ? { tool_calls: reading.calls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })) } : {}),
      },
      finish_reason: reading.finishReason,
    }],
    ...(reading.usage ? { usage: reading.usage } : {}),
    ...(reading.error ? { error: reading.error } : {}),
    ...(reading.refusal ? { refusal: reading.refusal } : {}),
    reasoningCharacters: reading.reasoningCharacters,
    ...(reading.reasoningTokens !== undefined ? { reasoningTokens: reading.reasoningTokens } : {}),
  };
}

/**
 * The events of one stream of the Responses API, one after the other, each told as the chunk the client reads (or as nothing, for an event that says nothing the client needs: the response is created, a part of
 * a message begins, an annotation, a tool of the provider's own). It keeps what it has already told, so that a server that sends the same words twice (as deltas and again whole, in a `done` event or in the
 * last event) is read once, and one that sends them only whole is read too. A stream that has no `response.completed`, `response.incomplete` or `response.failed` (nor an `error`) did not end properly (`finished`).
 */
export class ResponsesStreamReader {
  private done = false;
  /** The pieces of text that arrived, by the output item and the part of it. */
  private readonly texts = new Set<string>();
  /** The function calls whose arguments arrived (as deltas, or whole), by the position of the item in the output. */
  private readonly callsWithArguments = new Set<number>();
  private reasoned = false;
  private called = false;

  /** The stream ended properly: the provider sent its last event. */
  get finished(): boolean {
    return this.done;
  }

  /** One event: its data, parsed, and the name of its `event:` line (the data's own `type` says the same, and is read first). */
  read(data: unknown, event = ""): ResponsesChunk | undefined {
    const value = record(data);
    const type = text(value.type) || event;
    switch (type) {
      case "response.output_text.delta": {
        const delta = text(value.delta);
        if (!delta) return undefined;
        this.texts.add(this.key(value));
        return { choices: [{ delta: { content: delta } }] };
      }
      case "response.output_text.done": {
        const key = this.key(value);
        const whole = text(value.text);
        if (this.texts.has(key) || !whole) return undefined;
        this.texts.add(key);
        return { choices: [{ delta: { content: whole } }] };
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const delta = text(value.delta);
        if (!delta) return undefined;
        this.reasoned = true;
        return { choices: [], reasoningCharacters: delta.length };
      }
      case "response.output_item.added":
      case "response.output_item.done": {
        const item = record(value.item);
        return item.type === "function_call" ? this.call(position(value.output_index), text(item.name), text(item.arguments)) : undefined;
      }
      case "response.function_call_arguments.delta": {
        const delta = text(value.delta);
        return delta ? this.call(position(value.output_index), "", delta, true) : undefined;
      }
      case "response.function_call_arguments.done":
        return this.call(position(value.output_index), text(value.name), text(value.arguments));
      case "response.completed":
        return this.last(record(value.response), "completed");
      case "response.incomplete":
        return this.last(record(value.response), "incomplete");
      case "response.failed":
        return this.last(record(value.response), "failed");
      case "error":
        this.done = true;
        return { choices: [], error: value.error ?? value };
      default:
        return undefined;
    }
  }

  private key(value: Record<string, unknown>): string {
    return `${position(value.output_index)}:${position(value.content_index)}`;
  }

  /**
   * A function call, or a piece of one: its name, and its arguments. The arguments that come whole (in the event that adds the item, in the one that ends its arguments or in the one that ends the item) are
   * told only when none arrived before: the deltas are the arguments, and what is said again is not added to them.
   */
  private call(index: number, name: string, args: string, piece = false): ResponsesChunk | undefined {
    this.called = true;
    const arguments_ = piece || !this.callsWithArguments.has(index) ? args : "";
    if (arguments_) this.callsWithArguments.add(index);
    if (!name && !arguments_) return undefined;
    return { choices: [{ delta: { tool_calls: [{ index, function: { ...(name ? { name } : {}), ...(arguments_ ? { arguments: arguments_ } : {}) } }] } }] };
  }

  /** The last event: the end of the reply, its usage, its failure, and whatever the pieces did not bring (a server that streams nothing and says everything here). */
  private last(response: Record<string, unknown>, status: "completed" | "incomplete" | "failed"): ResponsesChunk {
    this.done = true;
    const reading = readResponse(response, status);
    // What the pieces did not bring is read from the output only when they brought nothing of its kind: an output that a server numbers in another way than its events could be read twice.
    const delta = {
      ...(this.texts.size === 0 && reading.text ? { content: reading.text } : {}),
      ...(this.callsWithArguments.size === 0 ? { tool_calls: reading.calls.filter((call) => call.arguments).map((call) => ({ index: call.index, function: { name: call.name, arguments: call.arguments } })) } : {}),
    };
    if (!delta.tool_calls?.length) delete delta.tool_calls;
    // The calls that the stream told are calls the reply has, even when its last event leaves them out.
    const finishReason = reading.finishReason === "stop" && this.called ? "tool_calls" : reading.finishReason;
    return {
      choices: [{ ...(Object.keys(delta).length ? { delta } : {}), finish_reason: finishReason }],
      ...(reading.usage ? { usage: reading.usage } : {}),
      ...(reading.refusal ? { refusal: reading.refusal } : {}),
      ...(!this.reasoned && reading.reasoningCharacters ? { reasoningCharacters: reading.reasoningCharacters } : {}),
      ...(reading.reasoningTokens !== undefined ? { reasoningTokens: reading.reasoningTokens } : {}),
      ...(finishReason === "failed" ? { error: reading.error ?? { code: "failed", message: "The provider reported that the response failed." } } : {}),
    };
  }
}

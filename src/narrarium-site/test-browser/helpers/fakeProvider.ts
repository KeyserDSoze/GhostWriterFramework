import { expect } from "vitest";

/** One integration the fake provider knows: where its key may go and how it is sent. */
export interface ProviderEndpoint {
  id: string;
  apiKey: string;
  /** Origin and path every request to this integration starts with: the only place its key may be sent. */
  base: string;
  auth: "bearer" | "api-key";
}

export interface ProviderCall {
  url: string;
  method: string;
  /** Header names in lower case. */
  headers: Record<string, string>;
  rawBody: string;
  body: any;
  signal: AbortSignal | null;
}

export type ProviderReply = (call: ProviderCall) => Response | Promise<Response>;

const encoder = new TextEncoder();

export const USAGE = { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } };

export const data = (value: unknown) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
export const DONE = "data: [DONE]\n\n";

export function eventStream(chunks: string[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function textReply(text = "The scene.", usage: object | null = USAGE, finishReason = "stop"): Response {
  return Response.json({ choices: [{ message: { content: text }, finish_reason: finishReason }], ...(usage ? { usage } : {}) });
}

export function streamedReply(text = "The scene.", usage: object | null = USAGE): Response {
  const middle = Math.max(1, Math.floor(text.length / 2));
  return eventStream([
    data({ choices: [{ delta: { content: text.slice(0, middle) } }] }),
    data({ choices: [{ delta: { content: text.slice(middle) } }] }),
    data({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ...(usage ? [data({ choices: [], usage })] : []),
    DONE,
  ]);
}

export function toolReply(value: unknown, usage: object | null = USAGE): Response {
  return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "result", arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }], ...(usage ? { usage } : {}) });
}

export const failReply = (status: number, message = "failed", headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json", ...headers } });

/** Never answers: it only ends when the request is aborted (a pause, a timeout, a changed account). */
export function hang(signal: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** The answer a healthy provider gives to whatever it was asked: a forced call, JSON in the text, a stream or plain text. */
export function answer(call: ProviderCall): Response {
  const body = call.body ?? {};
  if (body.tools) return toolReply({ ok: true });
  if (/Reply with ONLY one JSON object/.test(String(body.messages?.[0]?.content ?? ""))) return textReply(JSON.stringify({ ok: true }));
  return body.stream ? streamedReply() : textReply();
}

function formsOf(secret: string): string[] {
  return [...new Set([secret, encodeURIComponent(secret)])];
}

/** Whether `text` holds the secret, as it is or URL-encoded. */
export function holdsSecret(text: string, secret: string): boolean {
  return secret.length >= 6 && formsOf(secret).some((form) => text.includes(form));
}

/** `text` with every secret hidden, safe to put in a failure message. */
export function maskSecrets(text: string, secrets: string[]): string {
  let output = text;
  for (const secret of secrets) if (secret.length >= 6) for (const form of formsOf(secret)) output = output.split(form).join("***");
  return output;
}

const created: FakeProvider[] = [];

export interface FakeProvider {
  fetch: typeof fetch;
  calls: ProviderCall[];
  /** What the security guard found wrong in the traffic (empty when every key went where it should). */
  violations: string[];
}

/**
 * A `fetch` that plays the AI providers and records every call. It is also the security guard: API keys and tokens must
 * appear only in the authorization header of a request to the endpoint of their own integration, never in a URL, a
 * body, another header or another integration's request. `forbidden` lists secrets that belong to no provider at all
 * (a GitHub token): they must not be in any request. Call `assertProvidersClean` after the test to see the findings:
 * a failed `fetch` is turned into a provider error by the code under test, so throwing here could go unseen.
 */
export function createFakeProvider(endpoints: ProviderEndpoint[], reply: ProviderReply, forbidden: string[] = []): FakeProvider {
  const calls: ProviderCall[] = [];
  const violations: string[] = [];
  const secrets = [...endpoints.map((endpoint) => endpoint.apiKey), ...forbidden];
  const mask = (text: string) => maskSecrets(text, secrets);

  const inspect = (call: ProviderCall) => {
    const owner = endpoints.find((endpoint) => call.url.startsWith(`${endpoint.base}/`));
    if (!owner) violations.push(`${call.method} ${mask(call.url)} is not an endpoint of any configured integration`);
    else if (owner.apiKey) {
      const expected = owner.auth === "api-key" ? { "api-key": owner.apiKey } : { authorization: `Bearer ${owner.apiKey}` };
      for (const [name, value] of Object.entries(expected)) if (call.headers[name] !== value) violations.push(`the request to ${owner.id} does not carry its credentials in the ${name} header`);
    }
    for (const endpoint of endpoints) {
      if (!endpoint.apiKey) continue;
      if (holdsSecret(call.url, endpoint.apiKey)) violations.push(`the key of ${endpoint.id} is in the URL ${mask(call.url)}`);
      if (holdsSecret(call.rawBody, endpoint.apiKey)) violations.push(`the key of ${endpoint.id} is in the body of a request to ${mask(call.url)}`);
      for (const [name, value] of Object.entries(call.headers)) {
        if (!holdsSecret(value, endpoint.apiKey)) continue;
        if (owner?.id !== endpoint.id) violations.push(`the key of ${endpoint.id} was sent to ${owner?.id ?? mask(call.url)}`);
        else if (name !== (endpoint.auth === "api-key" ? "api-key" : "authorization")) violations.push(`the key of ${endpoint.id} is in the ${name} header`);
      }
    }
    for (const secret of forbidden) {
      const where = holdsSecret(call.url, secret) ? "URL" : holdsSecret(call.rawBody, secret) ? "body" : Object.entries(call.headers).find(([, value]) => holdsSecret(value, secret))?.[0];
      if (where) violations.push(`a secret that belongs to no provider is in the ${where} of a request to ${mask(call.url)}`);
    }
  };

  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name.toLowerCase()] = value; });
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const call: ProviderCall = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      rawBody,
      body: rawBody ? JSON.parse(rawBody) : undefined,
      signal: init?.signal ?? null,
    };
    calls.push(call);
    inspect(call);
    return reply(call);
  }) as typeof fetch;

  const provider = { fetch: fetchFake, calls, violations };
  created.push(provider);
  return provider;
}

/** Fails when the guard of any fake provider created since the last call found a key or token out of place. */
export function assertProvidersClean(): void {
  const findings = created.splice(0).flatMap((provider) => provider.violations);
  expect(findings).toEqual([]);
}

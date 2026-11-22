import { vi } from "vitest";

/** Fake Worker origin used by every test: nothing here ever reaches a real network. */
export const BROKER_BASE = "http://127.0.0.1:8787";

/** Distinct sentinels: if one of them shows up in a log, an error or a stored record, a secret leaked. */
export const SECRETS = {
  refresh: "rt-SENTINEL-refresh-7d1c9a4e5b",
  refreshRotated: "rt-SENTINEL-rotated-3b8e6f0a21",
  access: "at-SENTINEL-access-91c0d7e3aa",
  accessFresh: "at-SENTINEL-fresh-5e2f4b8c19",
  code: "cd-SENTINEL-code-0a6d3f9b72",
  verifier: "vf-SENTINEL-verifier-c4e8a1d5",
  idToken: "id-SENTINEL-idtoken-b7f3e2a094",
} as const;

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  init: RequestInit;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** A `fetch` replacement that answers only what a test registers; anything else fails like a dead network. */
export function createFakeNetwork() {
  const calls: RecordedCall[] = [];
  const handlers = new Map<string, Handler>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key.toLowerCase()] = value; });
    const call: RecordedCall = { url, method, headers, init, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body };
    calls.push(call);
    if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const handler = handlers.get(`${method} ${url}`);
    if (!handler) throw new TypeError(`fake network: no handler for ${method} ${url}`);
    return handler(call);
  });
  return {
    fetch: fetchMock,
    calls,
    on(method: string, url: string, handler: Handler) { handlers.set(`${method.toUpperCase()} ${url}`, handler); },
    reply(method: string, url: string, body: unknown, status = 200, headers: Record<string, string> = {}) {
      handlers.set(`${method.toUpperCase()} ${url}`, () => jsonResponse(body, status, headers));
    },
    callsTo(method: string, url: string) { return calls.filter((call) => call.method === method.toUpperCase() && call.url === url); },
    broker(path: string) { return calls.filter((call) => call.url === `${BROKER_BASE}${path}`); },
    reset() { calls.length = 0; handlers.clear(); fetchMock.mockClear(); },
  };
}

export type FakeNetwork = ReturnType<typeof createFakeNetwork>;

export interface FakeLocks {
  requests: Array<{ name: string; mode?: string }>;
  /** Runs once, right after the lock has been granted and before the callback starts. */
  onGranted?: (name: string) => void | Promise<void>;
  uninstall(): void;
}

/** A minimal exclusive Web Locks implementation (jsdom has none). */
export function installFakeLocks(): FakeLocks {
  const queues = new Map<string, Promise<unknown>>();
  const state: FakeLocks = {
    requests: [],
    uninstall() { delete (navigator as unknown as { locks?: unknown }).locks; },
  };
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (name: string, options: { mode?: string } | (() => unknown), callback?: () => unknown) => {
        const run = (typeof options === "function" ? options : callback) as () => Promise<unknown>;
        const mode = typeof options === "function" ? undefined : options.mode;
        state.requests.push({ name, mode });
        const previous = queues.get(name) ?? Promise.resolve();
        const result = previous.catch(() => undefined).then(async () => {
          await state.onGranted?.(name);
          return run();
        });
        queues.set(name, result.catch(() => undefined));
        return result;
      },
    },
  });
  return state;
}

export interface FakePopup {
  location: { href: string; replace: ReturnType<typeof vi.fn> };
  close: ReturnType<typeof vi.fn>;
  closed: boolean;
  focus: ReturnType<typeof vi.fn>;
}

export function createFakePopup(): FakePopup {
  const popup: FakePopup = {
    location: { href: "about:blank", replace: vi.fn((url: string) => { popup.location.href = url; }) },
    close: vi.fn(() => { popup.closed = true; }),
    closed: false,
    focus: vi.fn(),
  };
  return popup;
}

/** Delivers a `message` event the way the browser would, with a chosen source and origin. */
export function dispatchWindowMessage(data: unknown, options: { source?: unknown; origin?: string } = {}): void {
  const event = new MessageEvent("message", { data, origin: options.origin ?? window.location.origin });
  Object.defineProperty(event, "source", { value: options.source ?? null });
  window.dispatchEvent(event);
}

/** Every record of every store of a database, as one searchable string (binary values as latin1). */
export async function dumpIndexedDb(name: string): Promise<string> {
  const names = (await indexedDB.databases()).map((entry) => entry.name);
  if (!names.includes(name)) return "";
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const parts: string[] = [];
    for (const store of Array.from(db.objectStoreNames)) {
      const tx = db.transaction(store, "readonly");
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const request = tx.objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      parts.push(`${store}:${stringifyRecord(records)}`);
    }
    return parts.join("\n");
  } finally {
    db.close();
  }
}

function stringifyRecord(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry instanceof ArrayBuffer) return `bin:${Buffer.from(entry).toString("latin1")}`;
    if (ArrayBuffer.isView(entry)) return `bin:${Buffer.from(entry.buffer, entry.byteOffset, entry.byteLength).toString("latin1")}`;
    if (typeof CryptoKey !== "undefined" && entry instanceof CryptoKey) return `cryptokey:${entry.algorithm.name}:${entry.extractable}`;
    return entry;
  });
}

export async function deleteDatabases(...names: string[]): Promise<void> {
  for (const name of names) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
}

/** Fails the test if anything was written to the console: the credential code must stay silent. */
export function spyOnConsole() {
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
  return {
    output(): string {
      return spies.flatMap((spy) => spy.mock.calls.map((args) => args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}\n${arg.stack ?? ""}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))).join("\n");
    },
    count(): number { return spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0); },
  };
}

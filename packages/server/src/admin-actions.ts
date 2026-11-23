import type { AdminAction, AdminLogInput } from "./admin-log.js";
import type { McpBookState } from "./mcp-books.js";
import { SERVER_VERSION } from "./version.js";

/**
 * What a call of a client's API is in the admin log. Most calls of the API read, or sync the book, or steer the autopilot a step at a time: they are not events of the
 * server, and are not here. What is here changes what the server holds or does at the owner's expense (a book added or removed, the AI configuration, a book's MCP switch,
 * an app disconnected, an update, a run), and each leaves its line with the name of the client that did it.
 */

export type LoggedEntry = Omit<AdminLogInput, "actor" | "ok" | "source">;

export interface ClientAction {
  /** What a call that was refused is logged as. */
  failure: AdminAction;
  /** The book (or what else the call is about), when the address says. */
  object?: string;
  label?: string;
  /** What the call that worked did: one line, or more when it did more than one thing (a switch and an address). */
  done(payload: unknown): LoggedEntry[];
}

/** What the server knows that a call changes, read before it does: the MCP switch of a book, and which app a grant is. */
export interface ClientActionWorld {
  mcpState(bookId: string): McpBookState | undefined;
  grant(grantId: string): { bookId: string; name: string } | undefined;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});

/** What changed in a book's MCP: switched on or off, and the address (its slug) when it moved. Nothing when nothing changed. */
export function mcpChanges(bookId: string, before: Pick<McpBookState, "enabled" | "slug"> | undefined, after: { enabled?: unknown; slug?: unknown }): LoggedEntry[] {
  const changes: LoggedEntry[] = [];
  const enabled = after.enabled === true;
  if (enabled !== (before?.enabled ?? false)) changes.push({ action: enabled ? "mcp.on" : "mcp.off", object: bookId });
  if (before && typeof after.slug === "string" && after.slug !== before.slug) changes.push({ action: "mcp.address", object: bookId, detail: after.slug });
  return changes;
}

/** A refusal is worth a line when somebody who was let in was told no for a reason of the server's (a permission, a limit, a state); a request that is wrong in itself is not an event. */
export function refusalIsLogged(status: number): boolean {
  return status === 403 || status === 409 || status === 412 || status === 429 || status >= 500;
}

/** One request never writes more than this many lines (a form that approves fifty addresses is one thing the owner did). */
const MAX_LINES_PER_CHANGE = 10;

const sameSet = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((entry) => right.includes(entry));

/** What the form of the approved network changed: the addresses, the origins, the public addresses, the switch of the remote panel, and the AI endpoints approved or taken away. */
export function networkChanges(
  before: { origins: readonly string[]; allowedAiBases: readonly string[]; publicUrl?: string; adminPublicUrl?: string; allowRemoteAdmin: boolean },
  after: { origins: readonly string[]; allowedAiBases: readonly string[]; publicUrl?: string; adminPublicUrl?: string; allowRemoteAdmin: boolean },
): LoggedEntry[] {
  const entries: LoggedEntry[] = [];
  const changed: string[] = [];
  if (!sameSet(before.origins, after.origins)) changed.push("origins");
  if (before.publicUrl !== after.publicUrl) changed.push(`publicUrl=${after.publicUrl ?? "none"}`);
  if (before.adminPublicUrl !== after.adminPublicUrl) changed.push(`adminPublicUrl=${after.adminPublicUrl ?? "none"}`);
  if (changed.length) entries.push({ action: "network.change", detail: changed.join("; ") });
  if (before.allowRemoteAdmin !== after.allowRemoteAdmin) entries.push({ action: "network.remote", detail: after.allowRemoteAdmin ? "on" : "off" });
  for (const base of after.allowedAiBases.filter((entry) => !before.allowedAiBases.includes(entry))) entries.push({ action: "ai.approve", object: base });
  for (const base of before.allowedAiBases.filter((entry) => !after.allowedAiBases.includes(entry))) entries.push({ action: "ai.revoke", object: base });
  return entries.slice(0, MAX_LINES_PER_CHANGE);
}

/** The AI endpoints a request approved (the ones that were not approved before), one line each. */
export function approvedBases(before: readonly string[], asked: readonly string[]): LoggedEntry[] {
  return [...new Set(asked)].filter((base) => !before.includes(base)).slice(0, MAX_LINES_PER_CHANGE).map((base) => ({ action: "ai.approve" as const, object: base }));
}

/** The switch of the owner's spending and the limits that a request changed, from what to what. */
export function spendChanges(
  before: { paused: boolean; maxTokensPerDay: number; maxCostPerDay: number; maxTokensPerRun: number; maxCostPerRun: number },
  after: { paused: boolean; maxTokensPerDay: number; maxCostPerDay: number; maxTokensPerRun: number; maxCostPerRun: number },
): LoggedEntry[] {
  const entries: LoggedEntry[] = [];
  if (before.paused !== after.paused) entries.push({ action: after.paused ? "spend.pause" : "spend.resume" });
  const limits = (["maxTokensPerDay", "maxCostPerDay", "maxTokensPerRun", "maxCostPerRun"] as const).filter((field) => before[field] !== after[field]);
  if (limits.length) entries.push({ action: "spend.limits", detail: limits.map((field) => `${field} ${before[field]}->${after[field]}`).join("; ") });
  return entries;
}

const whole = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

interface Rule {
  method: string;
  pattern: RegExp;
  build(match: string[], world: ClientActionWorld): ClientAction;
}

const book = (action: AdminAction) => ([, id]: string[]): ClientAction => ({ failure: action, object: decode(id), done: () => [{ action, object: decode(id) }] });

const RULES: Rule[] = [
  { method: "PUT", pattern: /^\/api\/v1\/ai$/, build: () => ({ failure: "ai.config", done: () => [{ action: "ai.config" }] }) },
  {
    method: "PUT",
    pattern: /^\/api\/v1\/books\/([^/]+)$/,
    build: ([, id]) => ({ failure: "book.register", object: decode(id), done: (payload) => [{ action: "book.register", object: decode(id), detail: String(record(record(payload).storage).kind ?? "") }] }),
  },
  { method: "DELETE", pattern: /^\/api\/v1\/books\/([^/]+)$/, build: book("book.remove") },
  {
    method: "PUT",
    pattern: /^\/api\/v1\/books\/([^/]+)\/mcp$/,
    build: ([, id], world) => {
      const bookId = decode(id);
      const before = world.mcpState(bookId);
      return { failure: "mcp.change", object: bookId, done: (payload) => mcpChanges(bookId, before, record(payload)) };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/v1\/books\/([^/]+)\/mcp\/clients\/([^/]+)$/,
    build: ([, id, grant], world) => {
      const bookId = decode(id);
      const found = world.grant(decode(grant));
      const label = found && found.bookId === bookId ? found.name : undefined;
      return { failure: "oauth.revoke", object: bookId, ...(label ? { label } : {}), done: () => [{ action: "oauth.revoke", object: bookId, ...(label ? { label } : {}) }] };
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/calls$/,
    build: ([, id]) => ({ failure: "ai-calls.delete", object: decode(id), done: (payload) => [{ action: "ai-calls.delete", object: decode(id), detail: `${whole(record(payload).tasks)} tasks, ${whole(record(payload).calls)} calls` }] }),
  },
  { method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/start$/, build: book("run.start") },
  { method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/pause$/, build: book("run.pause") },
  { method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/reset$/, build: book("run.reset") },
  {
    method: "POST",
    pattern: /^\/api\/v1\/updates$/,
    build: () => ({ failure: "update.request", done: (payload) => [{ action: "update.request", object: String(record(payload).version ?? ""), detail: SERVER_VERSION }] }),
  },
];

/** The admin-log meaning of a call of a client, or `undefined` for a call that is not an event. Read what the call will change before it is made. */
export function clientAction(method: string, pathname: string, world: ClientActionWorld): ClientAction | undefined {
  for (const rule of RULES) {
    if (rule.method !== method) continue;
    const match = rule.pattern.exec(pathname);
    if (match) return rule.build([...match], world);
  }
  return undefined;
}

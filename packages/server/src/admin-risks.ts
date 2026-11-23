import { cleanText } from "./admin-log.js";

/**
 * What the owner should know about how this server is set up, and what to do about it: remote administration, clients and apps that may change the server or the books or spend
 * the owner's AI credits, no passkey while apps can connect from the internet, AI endpoints that are not on this computer, spending with no limit. Each risk is a fact of this
 * server (it is there while the fact is true and goes when it is not), carried as an id and the numbers or names the page needs: the sentences, and what to do, are in the page
 * (both languages). Nothing here is a secret: a name or a count, never a token, a code, a key or a client id.
 */

/** From what needs action to what is only good to know. */
export const RISK_LEVELS = ["high", "medium", "note"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** The risks, in the order a person reads them (so, by level, then the order the owner is most likely to act in). */
export const RISK_IDS = ["remote-admin", "client-update", "oauth-write", "spend-unlimited", "no-passkey", "client-run", "ai-remote", "device-remember"] as const;
export type RiskId = (typeof RISK_IDS)[number];

const LEVEL_OF: Record<RiskId, RiskLevel> = {
  "remote-admin": "high",
  "client-update": "medium",
  "oauth-write": "medium",
  "spend-unlimited": "medium",
  "no-passkey": "medium",
  "client-run": "note",
  "ai-remote": "note",
  "device-remember": "note",
};

/** How many names a risk lists: the count is of all of them. */
export const RISK_LIST_MAX = 5;

export interface Risk {
  id: RiskId;
  level: RiskLevel;
  facts: Record<string, unknown>;
}

export interface RiskReport {
  risks: Risk[];
  counts: Record<RiskLevel, number>;
}

/** What is known of the server, as the builder reads it: nothing is trusted to be there, or to be what it says. */
export interface RiskInput {
  /** Whether the panel is served on a public address, and which. */
  remoteAdmin?: { on?: boolean; address?: string };
  /** The clients of the API (the apps and tools that hold a token), by their name and what they may do. */
  clients?: unknown[];
  /** The apps connected to a book through OAuth. */
  apps?: unknown[];
  mcp?: { booksOn?: number; passkeys?: number; publicUrl?: string; canAddPasskey?: boolean };
  /** The AI endpoints the owner approved. */
  aiBases?: unknown[];
  spend?: { unlimited?: boolean; paused?: boolean };
  /** An AI is set up, so there is something to spend. */
  aiConfigured?: boolean;
  /** The browsers that the owner asked the panel to remember: how many. */
  devices?: { count?: number };
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const scopesOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === "string") : []);
const whole = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);

interface Holder {
  label: string;
  scopes: string[];
}

function holders(list: unknown): Holder[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const source = record(entry);
    const label = cleanText(source.label, 80);
    return label ? [{ label, scopes: scopesOf(source.scopes) }] : [];
  });
}

interface App {
  name: string;
  bookId: string;
  scopes: string[];
}

function apps(list: unknown): App[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const source = record(entry);
    const name = cleanText(source.name, 80);
    const bookId = cleanText(source.bookId, 120);
    return name && bookId ? [{ name, bookId, scopes: scopesOf(source.scopes) }] : [];
  });
}

/** An address that is this computer's own: a model that runs here sends nothing away. */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** The AI endpoints that are not on this computer: how many, and at which hosts (each once). */
function remoteBases(list: unknown): { count: number; hosts: string[] } {
  let count = 0;
  const hosts: string[] = [];
  if (!Array.isArray(list)) return { count, hosts };
  for (const base of list) {
    if (typeof base !== "string") continue;
    let url: URL;
    try {
      url = new URL(base.trim());
    } catch {
      continue;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || isLoopback(url.hostname)) continue;
    count += 1;
    if (!hosts.includes(url.host)) hosts.push(url.host);
  }
  return { count, hosts: hosts.slice(0, RISK_LIST_MAX) };
}

/** The risks of a server from what is known of it. Pure, and never throws: facts that are missing or odd make no risk. */
export function buildRisks(input: RiskInput): RiskReport {
  const source = record(input);
  const found = new Map<RiskId, Record<string, unknown>>();

  const remote = record(source.remoteAdmin);
  const address = cleanText(remote.address, 200);
  if (remote.on === true && address) found.set("remote-admin", { address });

  const clients = holders(source.clients);
  const updaters = clients.filter((client) => client.scopes.includes("update"));
  if (updaters.length) found.set("client-update", { count: updaters.length, labels: updaters.slice(0, RISK_LIST_MAX).map((client) => client.label) });
  const runners = clients.filter((client) => client.scopes.includes("run"));

  const connected = apps(source.apps);
  const writers = connected.filter((app) => app.scopes.includes("write") || app.scopes.includes("run"));
  if (writers.length) found.set("oauth-write", { count: writers.length, apps: writers.slice(0, RISK_LIST_MAX).map((app) => ({ name: app.name, bookId: app.bookId, scopes: app.scopes })) });
  const runningApps = connected.filter((app) => app.scopes.includes("run"));

  const spend = record(source.spend);
  if (source.aiConfigured === true && spend.unlimited === true && spend.paused !== true && (runners.length || runningApps.length)) {
    found.set("spend-unlimited", { clients: runners.length, apps: runningApps.length });
  }

  const mcp = record(source.mcp);
  const publicUrl = cleanText(mcp.publicUrl, 200);
  if (whole(mcp.booksOn) > 0 && whole(mcp.passkeys) === 0 && publicUrl) found.set("no-passkey", { books: whole(mcp.booksOn), publicUrl, canAddPasskey: mcp.canAddPasskey === true });

  if (runners.length) found.set("client-run", { count: runners.length, labels: runners.slice(0, RISK_LIST_MAX).map((client) => client.label) });

  const bases = remoteBases(source.aiBases);
  if (bases.count) found.set("ai-remote", { count: bases.count, hosts: bases.hosts });

  // A remembered browser signs in without the code: how many there are, and whether the panel is open to the internet, which is what makes a stolen one matter.
  const devices = whole(record(source.devices).count);
  if (devices > 0) found.set("device-remember", { count: devices, remote: found.has("remote-admin") });

  const risks: Risk[] = RISK_IDS.flatMap((id) => {
    const facts = found.get(id);
    return facts ? [{ id, level: LEVEL_OF[id], facts }] : [];
  });
  const counts: Record<RiskLevel, number> = { high: 0, medium: 0, note: 0 };
  for (const risk of risks) counts[risk.level] += 1;
  return { risks, counts };
}

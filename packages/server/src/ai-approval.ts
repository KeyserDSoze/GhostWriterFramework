import { applySameBoundaryPolicy, effectiveAiBase, resolveAiCandidates, type AiCandidate, type AiRuntimeConfig } from "narrarium-engine";
import { normalizeOrigin } from "./config.js";

/**
 * An AI base as the owner and the server compare it: the origin and the path (no query, no fragment, no trailing slash), written the way
 * `new URL` writes them (host in lower case, default port dropped, dot segments resolved). `null` for what cannot be one: an address that
 * does not parse, is not http(s), or carries credentials.
 */
export function canonicalAiBase(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** An approval the owner types or approves: an origin, or an origin and a path (https; plain http only for this computer). Refused with 422 when it cannot be one. */
export function normalizeAiBase(value: string): string {
  const origin = normalizeOrigin(value);
  return `${origin}${new URL(value.trim()).pathname.replace(/\/+$/, "")}`;
}

/**
 * Whether one approval covers a base: the same origin and, when the approval has a path, the same path or one below it (by whole segments:
 * `/v1` covers `/v1/x`, never `/v10`). An approval of an origin, which is what every owner saved so far, covers every base on it.
 */
export function approvalCovers(approval: string, base: string): boolean {
  const allowed = canonicalAiBase(approval);
  const wanted = canonicalAiBase(base);
  if (!allowed || !wanted) return false;
  return wanted === allowed || wanted.startsWith(`${allowed}/`);
}

export function baseIsApproved(base: string, approvals: readonly string[]): boolean {
  return approvals.some((approval) => approvalCovers(approval, base));
}

/** Where one integration sends its requests, and so its API key. */
export interface AiDestination {
  integrationId: string;
  integrationName: string;
  base: string;
}

/**
 * The base of every integration of a configuration, the providers' defaults included (`https://api.openai.com/v1`,
 * `https://models.github.ai/inference`): the engine says what every request starts with (`effectiveAiBase`). An integration that cannot be
 * called (no address, no chat) has none.
 */
export function aiDestinations(config: Pick<AiRuntimeConfig, "aiIntegrations">): AiDestination[] {
  const destinations: AiDestination[] = [];
  for (const integration of config.aiIntegrations) {
    const base = canonicalAiBase(effectiveAiBase(integration));
    if (base) destinations.push({ integrationId: integration.id, integrationName: integration.name, base });
  }
  return destinations;
}

/** The bases of a configuration that no approval covers, each once: what waits for the owner. */
export function unapprovedAiBases(config: Pick<AiRuntimeConfig, "aiIntegrations">, approvals: readonly string[]): string[] {
  return [...new Set(aiDestinations(config).map((destination) => destination.base).filter((base) => !baseIsApproved(base, approvals)))];
}

/**
 * The candidates a call for `capability` may try, in the engine's order. A fallback outside the primary's account is never one when the policy
 * keeps content inside it, nor when the policy asks first: this host cannot ask, so it never crosses (the engine fails closed).
 */
export function callableCandidates(config: AiRuntimeConfig, capability: string): AiCandidate[] {
  const policy = config.fallbackDisclosure;
  const sameAccount = policy !== undefined && (policy.sameBoundaryOnly || policy.requireAcknowledgement);
  return applySameBoundaryPolicy({ fallbackDisclosure: sameAccount ? { sameBoundaryOnly: true, requireAcknowledgement: false } : policy }, resolveAiCandidates(config, capability));
}

/** A call that would send the owner's API key to an AI endpoint the owner has not approved: it is not made, and the run stops with this. */
export class AiNotApprovedError extends Error {
  /** The engine's retry rule reads this flag: nothing is repeated that the owner has to allow first. */
  readonly retryable = false;

  constructor(readonly bases: readonly string[], message: string) {
    super(message);
    this.name = "AiNotApprovedError";
  }
}

/**
 * Before a call: every endpoint its route can reach must be approved (the guard in the network layer stays as it is, by origin, behind this).
 * Refusing the whole call, not just the endpoint, keeps the rule simple and says everything the owner has to approve at once.
 */
export function assertAiApproved(config: AiRuntimeConfig, capability: string, approvals: readonly string[]): void {
  const missing = new Map<string, Set<string>>();
  for (const candidate of callableCandidates(config, capability)) {
    const base = canonicalAiBase(effectiveAiBase(candidate.integration));
    if (!base || baseIsApproved(base, approvals)) continue;
    const names = missing.get(base) ?? new Set<string>();
    names.add(`"${candidate.integration.name.slice(0, 60)}"`);
    missing.set(base, names);
  }
  if (!missing.size) return;
  const list = [...missing].map(([base, names]) => `${base} (${[...names].join(", ")})`).join(", ");
  const many = missing.size > 1;
  throw new AiNotApprovedError([...missing.keys()], `The server owner has not approved the AI ${many ? "endpoints" : "endpoint"} ${list}, so nothing (your API key included) was sent there. Approve ${many ? "them" : "it"} in the server's admin panel (AI endpoints), then resume.`);
}

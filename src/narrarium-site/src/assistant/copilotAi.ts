import {
  AiProviderError,
  pickAiRuntimeConfig,
  requestOutputLimit,
  resolveAiCandidates,
  type AiJsonSchema,
  type AiResponse,
  type AiRuntimeConfig,
  type FetchAiAttemptEnd,
} from "narrarium-engine";
import type { BrowserAiRoute } from "@/autopilot/browserAi";
import { chatDelta } from "@/costs/costsStore";
import type { ForcedToolDefinition, LlmMessage, LlmRunMetadata, LlmUsageReport } from "@/assistant/llm";
import { resolveModelTokenBudgets, textTokenUpperBound } from "@/assistant/promptBudget";
import { pause, QUIET_RETRY_ATTEMPTS, quietRetryWait } from "@/assistant/quietRetry";
import type { RetryNotice } from "@/assistant/retryNotice";
import type { TaskCandidate } from "@/assistant/router";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings, type ChatCapability } from "@/types/settings";
import type { UsageTask } from "@/costs/usageTasks";

/**
 * The Copilot's way to the language models: the engine's client (`createFetchAi`, through `createBrowserAi`), the same that the autopilot and the personal server use, so a model
 * gets the same request and the same deadlines whoever asks. The Copilot keeps what is its own: it resolves the route (`resolveTaskCandidates`), cuts the prompt of each candidate
 * to the window of that candidate, and judges a reply with the checks of its callers, which a reply that was refused sends to the next candidate. So it gives the engine one
 * candidate at a time, in a route of one, and the engine applies to that attempt what is the engine's: the request, the streaming, the three deadlines and the reading of the reply.
 */

/** A candidate that can be asked: it has an integration and a model. */
export type ChatCandidate = TaskCandidate & { integration: AIIntegration; model: string };

/** The models of a route that "Tools only" leaves out of a structured request: the engine's own words for them. */
export type SkippedModels = NonNullable<BrowserAiRoute["skipped"]>;

const NO_SCHEMA_FIELDS: AiJsonSchema = { name: "result", description: "", parameters: {} };

/**
 * The engine's configuration for one call to one candidate: the author's, with a route that holds only that candidate (its thinking being the one the Copilot resolved, which
 * the engine would otherwise take from the target and then from the integration) and without the limits of a route, which the Copilot applied itself to the whole of it.
 */
function singleCandidateConfig(base: AiRuntimeConfig, candidate: ChatCandidate, capability: ChatCapability): AiRuntimeConfig {
  const { routingExecution: _limits, ...rest } = base;
  return {
    ...rest,
    taskRouting: { ...rest.taskRouting, [capability]: { primary: { integrationId: candidate.integration.id, model: candidate.model, ...(candidate.thinking ? { thinking: candidate.thinking } : {}) }, fallbacks: [] } },
  };
}

/** What the engine asks of a candidate as the limit of the reply: the one the Copilot asked for, with the floor of a structured reply and the room that a reasoning model needs. */
export function engineOutputLimit(settings: AppSettings, candidate: ChatCandidate, capability: ChatCapability, requested: number, structured: boolean): number {
  const [engineCandidate] = resolveAiCandidates(singleCandidateConfig(pickAiRuntimeConfig(settings), candidate, capability), capability);
  if (!engineCandidate) return requested;
  return requestOutputLimit({ ...(structured ? { json: NO_SCHEMA_FIELDS } : {}), maxOutputTokens: requested }, engineCandidate) ?? requested;
}

/** The output that the Copilot asks of a candidate before the engine adds its floor and its margin: the model's own limit, else the caller's, else the default. */
export function requestedOutput(candidate: ChatCandidate, fallbackMaxOutputTokens?: number): number {
  return resolveModelTokenBudgets(candidate.maxInputTokens, candidate.maxOutputTokens ?? fallbackMaxOutputTokens).outputTokens;
}

/** The tokens that a forced call's schema takes in a request, as the engine sends it (`tools: [{ type: "function", function }]`), at most and at about. */
export function toolTokens(tool: ForcedToolDefinition): { atMost: number; about: number } {
  const wire = JSON.stringify([{ type: "function", function: tool }]);
  return { atMost: textTokenUpperBound(wire) + 8, about: Math.ceil(wire.length / 4) + 8 };
}

/**
 * What a model that cannot call a function receives in place of the call, when "Tools only" is off: the instruction to answer in JSON, with the schema, added to its first system
 * message. About as long as the schema and a sentence; the Copilot keeps room for it when it cuts the prompt.
 */
export function jsonInstructionTokens(tool: ForcedToolDefinition): number {
  return textTokenUpperBound(JSON.stringify(tool)) + 300;
}

/** Whether "Tools only" is on for the Copilot, as it is for the run: it is unless the author turned it off in the AI Router. */
export function toolsOnly(settings: AppSettings): boolean {
  return settings.aiToolsOnly !== false;
}

/**
 * The error of a structured request whose every model is marked as without tool calls while "Tools only" is on: the engine's, with its words (the models, and the two ways out),
 * made by asking the engine to plan a call to these candidates. Nothing is sent: the plan is refused before. The client is loaded when it is needed, which is almost never.
 */
export async function toolsRequiredError(settings: AppSettings, capability: ChatCapability, candidates: ChatCandidate[], tool: ForcedToolDefinition): Promise<Error> {
  const { toolsRequiredReason } = await import("@/autopilot/browserAi");
  return toolsRequiredReason(settings, capability, candidates.map((candidate) => ({ integrationId: candidate.integration.id, model: candidate.model })), tool);
}

// ─── The routing time ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RoutingClock {
  /**
   * An attempt is about to begin: the milliseconds of the routing time that are left for it, and the attempt is counted. There are none for the first attempt of a call, which runs for
   * its own deadlines whatever the total; the attempts after it (a fallback, or the same candidate again after a wait) run for what is left.
   */
  begin(): number | undefined;
  /** Why no more attempts are made, once the routing time is used up (never before the first attempt). */
  usedUp(): string | undefined;
  /** Whether a wait of `milliseconds` still leaves routing time for the attempt after it. */
  allows(milliseconds: number): boolean;
  /** The author took this long to decide on a fallback in another account: it is not the call's time. */
  excuse(milliseconds: number): void;
  /** The total, in milliseconds, when there is one. */
  readonly totalMs: number | undefined;
}

/** The routing time of a call (`routingExecution.maxTotalDurationMs`), as the engine counts it: it never interrupts the first attempt, and a later one starts only while time remains. */
export function startRoutingClock(settings: AppSettings): RoutingClock {
  const configured = (settings.routingExecution ?? DEFAULT_SETTINGS.routingExecution).maxTotalDurationMs;
  const totalMs = typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : undefined;
  let startedAt = Date.now();
  let began = 0;
  const remaining = (): number | undefined => (began > 0 && totalMs !== undefined ? totalMs - (Date.now() - startedAt) : undefined);
  return {
    totalMs,
    begin() {
      const value = remaining();
      began += 1;
      return value === undefined ? undefined : Math.max(1, Math.ceil(value));
    },
    usedUp() {
      const value = remaining();
      return value !== undefined && value <= 0 && totalMs !== undefined ? `Fallbacks were not tried: the total routing time (maxTotalDurationMs, ${Math.round(totalMs / 1000)} s) was used up.` : undefined;
    },
    allows(milliseconds) {
      return totalMs === undefined || began === 0 || totalMs - (Date.now() - startedAt) - milliseconds > 0;
    },
    excuse(milliseconds) {
      startedAt += Math.max(0, milliseconds);
    },
  };
}

/** A duration as a person says it, as the engine writes the deadlines it reports: `150 ms`, `30 s`, `1.5 s`, `4 h`. */
function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds >= 3_600_000 && milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000} h`;
  const seconds = milliseconds / 1000;
  return `${Number.isInteger(seconds) ? seconds : Math.round(seconds * 10) / 10} s`;
}

/** What a later candidate ends with when the routing time that was left runs out: an error of the engine's kind (it timed out, for the total), in the engine's words. */
function routingTimeError(candidate: ChatCandidate, leftMs: number): AiProviderError {
  return new AiProviderError(
    `${candidate.integration.provider} ${candidate.model}: request timed out: the provider did not finish within the ${formatDuration(leftMs)} left of the total routing time (maxTotalDurationMs)`,
    undefined,
    true,
    { transient: true, timedOut: true, timeout: { phase: "total", ms: leftMs }, model: candidate.model, provider: candidate.integration.provider, integrationId: candidate.integration.id },
  );
}

/** The signal of a call, with the routing time that is left for it when it is not the first: the author's Stop (or a change of account) always wins, and is never a timeout. */
function limitedSignal(signal: AbortSignal, candidate: ChatCandidate, leftMs: number | undefined): { signal: AbortSignal; dispose: () => void } {
  if (leftMs === undefined) return { signal, dispose: () => undefined };
  const controller = new AbortController();
  const follow = () => controller.abort(signal.reason);
  if (signal.aborted) follow();
  else signal.addEventListener("abort", follow, { once: true });
  const timer = setTimeout(() => {
    if (!signal.aborted && !controller.signal.aborted) controller.abort(routingTimeError(candidate, leftMs));
  }, leftMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal.removeEventListener("abort", follow);
    },
  };
}

// ─── One attempt ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CopilotAttempt {
  settings: AppSettings;
  /** The account the call belongs to, as the operation of the routed call resolved it. */
  accountScope: string | null;
  /** The signal of the routed call (the author's Stop, and a change of account). */
  signal: AbortSignal;
  capability: ChatCapability;
  candidate: ChatCandidate;
  /** Where the candidate stands in the route the Copilot resolved, and what it left out: what the debug panel says. */
  route: BrowserAiRoute;
  label: string;
  messages: LlmMessage[];
  /** The function of a structured request, forced. */
  json?: ForcedToolDefinition;
  maxOutputTokens: number;
  onText?: (text: string) => void;
  onEnd?: (end: FetchAiAttemptEnd, debugId: string | undefined) => void;
  /** The routing time of the call: it counts every attempt, those that ask the same candidate again included, and every wait between them. */
  clock: RoutingClock;
  /** The candidate is about to be asked again, after a wait: what the Copilot kept of the attempt that failed (the text that had streamed) is dropped, so the reply starts over. */
  onRestart?: () => void;
  /** A wait begins before the next attempt of the same candidate: what the chat says about it. */
  onRetry?: (notice: RetryNotice) => void;
  /** The task the call is part of for the costs: the turn of the Copilot that made it (`usageTaskOf` of the caller's signal); absent, the call is a task of its own. */
  usageTask?: UsageTask;
}

type BrowserAiFactory = typeof import("@/autopilot/browserAi").createBrowserAi;

/** One request to the candidate, on the routing time that is left for it when it is not the first of the call. */
async function once(createBrowserAi: BrowserAiFactory, attempt: CopilotAttempt): Promise<AiResponse> {
  const { candidate, capability } = attempt;
  const limited = limitedSignal(attempt.signal, candidate, attempt.clock.begin());
  try {
    return await createBrowserAi({
      settings: attempt.settings,
      accountScope: attempt.accountScope,
      configure: (config) => singleCandidateConfig(config, candidate, capability),
      route: attempt.route,
      ...(attempt.onEnd ? { onEnd: attempt.onEnd } : {}),
      ...(attempt.usageTask ? { usage: () => attempt.usageTask } : {}),
    }).complete({
      capability,
      label: attempt.label,
      system: "",
      user: "",
      ...(attempt.messages.length ? { messages: attempt.messages } : {}),
      ...(attempt.json ? { json: attempt.json } : {}),
      maxOutputTokens: attempt.maxOutputTokens,
      signal: limited.signal,
      ...(attempt.onText ? { onText: attempt.onText } : {}),
    });
  } finally {
    limited.dispose();
  }
}

/**
 * One call to one candidate: the request, the streaming, the deadlines and the reading of the reply are the engine's. Throws what the engine throws. When the provider answers with a
 * passing error (a 503, a 500, a 429, a connection that dropped: see `quietRetryWait`) the same candidate is asked again, up to two more times, after a wait that the author's Stop ends
 * at once and that the routing time must leave room for; the chat is told, once for each retry. After the last attempt the error goes on as it is, to the next candidate or to the author.
 */
export async function runCopilotAttempt(attempt: CopilotAttempt): Promise<AiResponse> {
  const { candidate } = attempt;
  if (candidate.integration.provider === "m365_copilot") {
    throw new Error(attempt.json ? "Microsoft 365 Copilot does not support browser tool calls." : "Microsoft 365 Copilot is not yet wired into the in-browser assistant.");
  }
  // The engine's client is loaded with the first call, as it is for the autopilot: the pages that never ask a model do not carry it.
  const { createBrowserAi } = await import("@/autopilot/browserAi");
  for (let made = 1; ; made += 1) {
    try {
      return await once(createBrowserAi, attempt);
    } catch (error) {
      // The author's Stop wins over everything, even over an error that came in the same moment.
      if (attempt.signal.aborted) throw attempt.signal.reason instanceof Error ? attempt.signal.reason : error;
      const wait = quietRetryWait(error, made);
      if (wait === null || !attempt.clock.allows(wait)) throw error;
      attempt.onRestart?.();
      attempt.onRetry?.({ attempt: made + 1, of: QUIET_RETRY_ATTEMPTS, waitMs: wait });
      await pause(wait, attempt.signal);
    }
  }
}

// ─── What an attempt reports ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The tokens an attempt used, as the provider counted them: none when it counted none (an estimate is not a measurement). */
function usageOf(end: FetchAiAttemptEnd | undefined): { inputTokens: number; cachedInputTokens: number; outputTokens: number } {
  const usage = end?.usageKnown && end.usage ? end.usage : undefined;
  return { inputTokens: usage?.inputTokens ?? 0, cachedInputTokens: usage?.cachedInputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 };
}

function costOf(candidate: ChatCandidate, usage: ReturnType<typeof usageOf>): number | undefined {
  return candidate.pricing ? chatDelta({ inputTokens: usage.inputTokens, cachedTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens }, candidate.pricing).chatCost : undefined;
}

/** What `onUsage` hears of an attempt: the model, the tokens and their cost at the price of the model. */
export function usageReport(candidate: ChatCandidate, end: FetchAiAttemptEnd): LlmUsageReport {
  const usage = usageOf(end);
  return { model: candidate.model, provider: candidate.integration.provider, integrationId: candidate.integration.id, ...usage, cost: costOf(candidate, usage) };
}

/** What a forced call says of the attempt that served it: which entry of the debug panel it is, the model, the tokens, their cost and the currency of the settings. */
export function runMetadata(input: { candidate: ChatCandidate; capability: ChatCapability; end: FetchAiAttemptEnd | undefined; debugId: string | undefined; settings: AppSettings }): LlmRunMetadata {
  const { candidate, capability, end, debugId, settings } = input;
  const usage = usageOf(end);
  return {
    requestId: debugId ?? "",
    task: capability,
    provider: candidate.integration.provider,
    integrationId: candidate.integration.id,
    model: candidate.model,
    ...usage,
    cost: costOf(candidate, usage),
    currency: settings.costCurrency,
  };
}

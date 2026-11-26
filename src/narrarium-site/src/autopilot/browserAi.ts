import {
  createFetchAi,
  integrationChatModels,
  pickAiRuntimeConfig,
  planAttempts,
  type AiPort,
  type AiPricingConfig,
  type AiRequest,
  type AiResponse,
  type AiRuntimeConfig,
  type FetchAiAttempt,
  type FetchAiAttemptEnd,
  type FetchAiFallbackTarget,
} from "narrarium-engine";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { beginAccountScopedAiOperation } from "@/assistant/accountScopedOperation";
import { acknowledgeCrossBoundaryFallback, type BoundaryCandidate } from "@/assistant/fallbackDisclosure";
import { pageEnding } from "@/autopilot/localRuns";
import { GITHUB_MODELS_BASE } from "@/config/githubModels";
import { chatDelta, useCostsStore } from "@/costs/costsStore";
import { inputOfLearning, rememberLearnedModel } from "@/autopilot/learnedModels";
import { flattenLlmContent, useLlmDebugStore } from "@/debug/llmDebugStore";
import { useSettingsStore } from "@/store/settingsStore";
import type { ForcedToolDefinition } from "@/assistant/llm";
import type { AppSettings, ChatCapability } from "@/types/settings";

function boundaryOf(target: FetchAiFallbackTarget): BoundaryCandidate {
  return { integration: { id: target.integrationId, name: target.integrationName, provider: target.provider } };
}

/** The price an attempt is billed at: its model's own, else its integration's. */
function pricingOf(config: AiRuntimeConfig, integrationId: string, model: string): AiPricingConfig | undefined {
  const integration = config.aiIntegrations.find((entry) => entry.id === integrationId);
  return integration ? integrationChatModels(integration).find((entry) => entry.name === model)?.pricing ?? integration.pricing : undefined;
}

/**
 * A pending entry in the debug panel for an attempt about to be sent: roles only, the store never keeps the content. It says how the engine asks: as a function call or as
 * JSON in the message (`structured` is whether a structured answer was asked for at all), whether it streams, the level of thinking, «Tools only», the models it left out
 * and the deadlines. Metadata, and nothing else: the store keeps only flags, numbers and a few words of the engine.
 */
function openDebugEntry(attempt: FetchAiAttempt, structured: boolean, route?: BrowserAiRoute): string {
  const index = route?.index ?? attempt.index;
  const skipped = [...(attempt.skipped ?? []), ...(route?.skipped ?? [])];
  const hasImage = attempt.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));
  return useLlmDebugStore.getState().begin({
    kind: "chat",
    contentKinds: hasImage ? ["text", "image"] : ["text"],
    label: attempt.label,
    task: attempt.capability as ChatCapability,
    model: attempt.model,
    provider: attempt.provider,
    integrationId: attempt.integrationId,
    routeCandidateIndex: index,
    usedFallback: index > 0,
    messages: attempt.messages.map((message) => ({ role: message.role, content: flattenLlmContent(message.content) })),
    structured,
    tools: attempt.tools,
    stream: attempt.stream,
    streamMode: attempt.streamMode,
    ...(attempt.apiVersion ? { apiVersion: attempt.apiVersion } : {}),
    ...(attempt.protocol ? { protocol: attempt.protocol } : {}),
    toolsOnly: attempt.toolsOnly,
    ...(attempt.thinking ? { thinking: attempt.thinking } : {}),
    ...(attempt.thinkingWhy ? { thinkingWhy: attempt.thinkingWhy } : {}),
    ...(attempt.reasoningParameter ? { reasoningParameter: attempt.reasoningParameter } : {}),
    ...(skipped.length ? { skipped } : {}),
    timeouts: { startMs: attempt.timeouts.startMs, idleMs: attempt.timeouts.idleMs, capMs: attempt.timeouts.capMs, ...(attempt.timeouts.raised ? { raisedFrom: attempt.timeouts.raised.from } : {}) },
  });
}

/**
 * Closes the panel entry of an attempt and records what the provider billed for it, failed attempts included. Only
 * tokens the provider reported are recorded: an estimate is not a measurement, and a model with no price has no cost.
 */
function closeAttempt(config: AiRuntimeConfig, debugId: string | undefined, end: FetchAiAttemptEnd): void {
  const pricing = pricingOf(config, end.integrationId, end.model);
  const usage = end.usageKnown && end.usage
    ? { inputTokens: end.usage.inputTokens, cachedTokens: end.usage.cachedInputTokens, outputTokens: end.usage.outputTokens }
    : undefined;
  const delta = usage ? chatDelta(usage, pricing) : undefined;
  const cost = pricing ? delta?.chatCost : undefined;
  if (debugId) {
    // What came back, whether it worked or not: read as a stream, how long the first byte took, whether the model called the function, which deadline ran out, what the transport saw
    // (the store keeps its figures and never the end of the stream, which is words of the model: this history keeps metadata only).
    const came = { streamed: end.streamed, firstByteMs: end.firstByteMs, toolCalled: end.toolCalled, transport: end.transport };
    useLlmDebugStore.getState().finish(debugId, end.outcome === "ok"
      ? { status: "done", response: end.text, ...came, ...usage, cost }
      : { status: "error", error: end.error, failureKind: end.failureKind, timeoutMs: end.timeoutMs, timeoutPhase: end.timeoutPhase, ...(end.errorBody ? { providerError: { status: end.errorBody.status, type: end.errorBody.type, param: end.errorBody.param, code: end.errorBody.code } } : {}), ...came, ...usage, cost });
  }
  if (usage && delta && pricing && (usage.inputTokens || usage.outputTokens)) useCostsStore.getState().recordCurrent(delta, end.model);
}

/** Where an attempt stands in a route that the caller resolved itself, and what it left out of that route: what the debug panel says of it. */
export interface BrowserAiRoute {
  /** Position of the candidate in the caller's route: 0 is the primary. It replaces the engine's, which only knows the one candidate it was given. */
  index: number;
  /** The models of the route that the caller did not ask, and why (a model without tool calls, with "Tools only" on). */
  skipped?: Array<{ model: string; reason: "no-tool-calls" }>;
}

export interface BrowserAiOptions {
  /** The settings the call is made with. Absent: the author's, read from the store when each call is made. */
  settings?: AppSettings;
  /**
   * The account the call belongs to, with the semantics of `beginAccountScopedAiOperation`: a name, or `null` for no account, must be the account that is signed in or the call
   * is abandoned before anything is sent; `undefined` goes with whichever is. Not said at all (the run): the local workspace.
   */
  accountScope?: string | null;
  /** Changes the configuration the engine is given for one call (the Copilot gives it a route of one candidate). */
  configure?: (config: AiRuntimeConfig, request: AiRequest) => AiRuntimeConfig;
  /** What the caller knows of the route of the attempts, for the debug panel. */
  route?: BrowserAiRoute;
  /** An attempt ended and its panel entry is closed: how it ended, and which entry it is. A listener that throws never breaks the call. */
  onEnd?: (end: FetchAiAttemptEnd, debugId: string | undefined) => void;
}

/**
 * The settings of a run of this tab: the tab's own, and the routing that another tab of this browser saved after this one loaded (see `settingsForRun`). The code that reads the device is loaded
 * with the first call, not with the page; a device that cannot be read leaves the settings of the tab.
 */
async function settingsOfRun(): Promise<AppSettings> {
  try {
    const { settingsForRun } = await import("@/autopilot/savedAiSettings");
    return await settingsForRun();
  } catch {
    return useSettingsStore.getState().settings;
  }
}

/**
 * The engine's `AiPort` in the browser: the same client as the personal server (`createFetchAi`), so a book gets the
 * same requests and the same outcomes in either host. The browser adds only what is its own: the account the call
 * belongs to, the debug panel, the costs, and the author's confirmation before content goes to another account.
 * Prompts arrive framed by the shared engine and go on unchanged; one that does not fit is refused, never cut.
 * The run uses it as it is. The Copilot says whose settings and account the call is made for, gives the engine a route of one
 * candidate at a time (it cuts the prompt of each to its own window and judges the replies itself), and hears how each attempt ended.
 */
export function createBrowserAi(options: BrowserAiOptions = {}): AiPort {
  return {
    async complete(request: AiRequest): Promise<AiResponse> {
      const settings = options.settings ?? await settingsOfRun();
      const picked = pickAiRuntimeConfig(settings);
      const config = options.configure ? options.configure(picked, request) : picked;
      const debugEntries = new Map<string, string>();
      const operation = beginAccountScopedAiOperation(request.signal, "accountScope" in options ? options.accountScope : localWorkspaceScope());
      try {
        const ai = createFetchAi(config, {
          fetch: (input, init) => fetch(input, init),
          githubModelsBaseUrl: GITHUB_MODELS_BASE,
          // A page that is reloaded or closed has its requests cut by the browser: that is not a failure of the provider, and the prompt must not go on to the fallback.
          interrupted: pageEnding,
          onAttempt: (attempt) => {
            debugEntries.set(attempt.attemptId, openDebugEntry(attempt, request.json !== undefined, options.route));
          },
          onAttemptEnd: (end) => {
            const debugId = debugEntries.get(end.attemptId);
            debugEntries.delete(end.attemptId);
            closeAttempt(config, debugId, end);
            try {
              options.onEnd?.(end, debugId);
            } catch {
              // A listener of the caller must never break a call.
            }
          },
          // A provider that refuses a thinking level because the request carries tools teaches the model's flag: kept in the settings of this browser, and said (a run says it as an event first, and the
          // page keeps it once). The next call reads the settings, so it needs no memory of its own.
          onLearned: (learning) => rememberLearnedModel(inputOfLearning(learning), { announce: true }),
          // The author refusing cancels the call (an AbortError: the run pauses); the engine only asks when the policy requires it.
          acknowledgeFallback: (from, to) => {
            acknowledgeCrossBoundaryFallback({ settings, kind: "text", from: boundaryOf(from), to: boundaryOf(to), accountScope: operation.accountScope });
            return true;
          },
        });
        return await ai.complete({ ...request, signal: operation.signal });
      } finally {
        operation.dispose();
      }
    },
  };
}

/**
 * The engine's refusal of a structured request that no model of a route can take, with its words: with "Tools only" on, every candidate is marked as without tool calls. The engine plans
 * the call, and ends it before anything is sent. The Copilot, which resolves its routes itself, asks it for the sentence it shows the author.
 */
export function toolsRequiredReason(settings: AppSettings, capability: ChatCapability, route: Array<{ integrationId: string; model: string }>, tool: ForcedToolDefinition): Error {
  const base = pickAiRuntimeConfig(settings);
  const [primary, ...fallbacks] = route;
  const config: AiRuntimeConfig = { ...base, toolsOnly: true, taskRouting: { ...base.taskRouting, [capability]: { primary, fallbacks } } };
  try {
    planAttempts(config, { capability, label: "copilot", system: "", user: "", json: tool });
  } catch (error) {
    if (error instanceof Error) return error;
  }
  return new Error("\"Tools only\" is on, and every model this task can use is marked as without tool calls, so a structured answer has nowhere to go. Nothing was sent.");
}

import {
  createFetchAi,
  integrationChatModels,
  pickAiRuntimeConfig,
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
import { GITHUB_MODELS_BASE } from "@/config/githubModels";
import { chatDelta, useCostsStore } from "@/costs/costsStore";
import { flattenLlmContent, useLlmDebugStore } from "@/debug/llmDebugStore";
import { useSettingsStore } from "@/store/settingsStore";

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
function openDebugEntry(attempt: FetchAiAttempt, structured: boolean): string {
  return useLlmDebugStore.getState().begin({
    kind: "chat",
    contentKinds: ["text"],
    label: attempt.label,
    model: attempt.model,
    provider: attempt.provider,
    integrationId: attempt.integrationId,
    routeCandidateIndex: attempt.index,
    usedFallback: attempt.index > 0,
    messages: attempt.messages.map((message) => ({ role: message.role, content: flattenLlmContent(message.content) })),
    structured,
    tools: attempt.tools,
    stream: attempt.stream,
    streamMode: attempt.streamMode,
    toolsOnly: attempt.toolsOnly,
    ...(attempt.thinking ? { thinking: attempt.thinking } : {}),
    ...(attempt.reasoningParameter ? { reasoningParameter: attempt.reasoningParameter } : {}),
    ...(attempt.skipped?.length ? { skipped: attempt.skipped } : {}),
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
    // What came back, whether it worked or not: read as a stream, how long the first byte took, whether the model called the function, which deadline ran out.
    const came = { streamed: end.streamed, firstByteMs: end.firstByteMs, toolCalled: end.toolCalled };
    useLlmDebugStore.getState().finish(debugId, end.outcome === "ok"
      ? { status: "done", response: end.text, ...came, ...usage, cost }
      : { status: "error", error: end.error, failureKind: end.failureKind, timeoutMs: end.timeoutMs, timeoutPhase: end.timeoutPhase, ...came, ...usage, cost });
  }
  if (usage && delta && pricing && (usage.inputTokens || usage.outputTokens)) useCostsStore.getState().recordCurrent(delta, end.model);
}

/**
 * The engine's `AiPort` in the browser: the same client as the personal server (`createFetchAi`), so a book gets the
 * same requests and the same outcomes in either host. The browser adds only what is its own: the account the call
 * belongs to, the debug panel, the costs, and the author's confirmation before content goes to another account.
 * Prompts arrive framed by the shared engine and go on unchanged; one that does not fit is refused, never cut.
 */
export function createBrowserAi(): AiPort {
  return {
    async complete(request: AiRequest): Promise<AiResponse> {
      const settings = useSettingsStore.getState().settings;
      const config = pickAiRuntimeConfig(settings);
      const debugEntries = new Map<string, string>();
      const operation = beginAccountScopedAiOperation(request.signal, localWorkspaceScope());
      try {
        const ai = createFetchAi(config, {
          fetch: (input, init) => fetch(input, init),
          githubModelsBaseUrl: GITHUB_MODELS_BASE,
          onAttempt: (attempt) => {
            debugEntries.set(attempt.attemptId, openDebugEntry(attempt, request.json !== undefined));
          },
          onAttemptEnd: (end) => {
            const debugId = debugEntries.get(end.attemptId);
            debugEntries.delete(end.attemptId);
            closeAttempt(config, debugId, end);
          },
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

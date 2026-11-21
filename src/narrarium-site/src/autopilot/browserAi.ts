import {
  AiProviderError,
  AiReplyRejectedError,
  AiUnavailableError,
  structuredReply,
  type AiPort,
  type AiProviderErrorDetails,
  type AiRequest,
  type AiResponse,
  type AiUsage,
} from "narrarium-engine";
import {
  completeTextRouted,
  completeToolRouted,
  NoCompletionCandidatesError,
  StaleRoutingConfigurationError,
} from "@/assistant/router";
import { CompletionFallbackError } from "@/assistant/completionFallback";
import type { LlmFinishReport } from "@/assistant/llm";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { useSettingsStore } from "@/store/settingsStore";
import type { ChatCapability } from "@/types/settings";

/** Failures that end the same way when repeated: retrying would only bill again (names set by their constructors). */
const FINAL_ERRORS = new Set([
  "PromptBudgetExceededError",
  "CandidateInputBudgetError",
  "RoutingExecutionBudgetError",
  "ContentFilteredCompletionError",
]);

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Everything the provider reported for this request, failed fallback attempts included. */
function spent(attempts: LlmFinishReport[]): AiProviderErrorDetails {
  if (!attempts.length) return {};
  const last = attempts[attempts.length - 1];
  const costs = attempts.map((attempt) => attempt.cost).filter((cost): cost is number => typeof cost === "number");
  return {
    usage: attempts.reduce<AiUsage>((total, attempt) => ({
      inputTokens: total.inputTokens + attempt.inputTokens,
      outputTokens: total.outputTokens + attempt.outputTokens,
      cachedInputTokens: total.cachedInputTokens + attempt.cachedInputTokens,
    }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }),
    cost: costs.length ? costs.reduce((total, cost) => total + cost, 0) : undefined,
    model: last.model,
    provider: last.provider,
    integrationId: last.integrationId,
  };
}

/**
 * The web app's failures in the engine's vocabulary, so the shared runner applies the same rules
 * as on the personal server: truncation and configuration problems are final, rejected replies
 * and transport failures are retried once, and what the attempts cost is never lost.
 */
export function toEngineError(error: unknown, capability: string, current: LlmFinishReport | null, attempts: LlmFinishReport[]): unknown {
  if (isAbort(error)) return error;
  if (error instanceof NoCompletionCandidatesError || error instanceof StaleRoutingConfigurationError) return new AiUnavailableError(capability);
  const details = spent(attempts);
  if (error instanceof AiProviderError) {
    if (error.usage === undefined) error.usage = details.usage;
    if (error.cost === undefined) error.cost = details.cost;
    if (error.model === undefined) error.model = details.model;
    if (error.provider === undefined) error.provider = details.provider;
    return error;
  }
  const label = current ? `${current.provider} ${current.model}: ` : "";
  if (current?.finishReason === "length") {
    return new AiProviderError(`${label}${current.replyCharacters === 0 && current.reasoningCharacters > 0 ? "the model used its output limit while reasoning, before writing the reply" : "the reply was cut by the output token limit"}. Nothing was applied.`, undefined, false, { ...details, truncated: true });
  }
  if (current && current.replyCharacters === 0) {
    return new AiProviderError(`${label}${current.reasoningCharacters > 0 ? "the model finished after reasoning without a reply" : "the provider returned an empty reply"}.`, undefined, true, details);
  }
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof CompletionFallbackError ? error.causes[error.causes.length - 1] : error instanceof Error ? { name: error.name, status: (error as { status?: unknown }).status } : undefined;
  const status = cause?.status;
  if (cause && FINAL_ERRORS.has(cause.name)) return new AiProviderError(message, undefined, false, details);
  if (typeof status === "number") return new AiProviderError(message, status, transientStatus(status), details);
  if (cause?.name === "SyntaxError") return new AiReplyRejectedError("The structured reply is not valid JSON.", details);
  // Network failures, timeouts and exhausted fallbacks: one more attempt, as before.
  return new AiProviderError(message, undefined, true, details);
}

/**
 * The engine's `AiPort` over the web app's AI router: routes, fallbacks, cost tracking and the
 * debug panel keep working for autopilot and director calls. Prompts arrive already framed by
 * the shared engine (`currentRequest` / `untrustedData`), so they are forwarded unchanged, and
 * never cut: a prompt that does not fit is refused with a clear message.
 */
export function createBrowserAi(): AiPort {
  return {
    async complete(request: AiRequest): Promise<AiResponse> {
      const settings = useSettingsStore.getState().settings;
      const messages = [
        { role: "system" as const, content: request.system },
        { role: "user" as const, content: request.user },
      ];
      const capability = request.capability as ChatCapability;
      const attempts: LlmFinishReport[] = [];
      let current: LlmFinishReport | null = null;
      const onAttempt = () => {
        current = null;
      };
      const onFinish = (report: LlmFinishReport) => {
        current = report;
        attempts.push(report);
      };
      try {
        if (request.json) {
          const schema = request.json;
          const result = await completeToolRouted<Record<string, unknown>>(settings, messages, capability, schema, {
            accountScope: localWorkspaceScope(),
            signal: request.signal,
            label: request.label,
            fallbackMaxOutputTokens: request.maxOutputTokens,
            validate: (output) => structuredReply(output, schema),
            onAttempt,
            onFinish,
            overflow: "fail",
          });
          const usage = spent(attempts);
          return {
            text: JSON.stringify(result.output),
            json: result.output,
            usage: usage.usage ?? { inputTokens: result.metadata.inputTokens, outputTokens: result.metadata.outputTokens, cachedInputTokens: result.metadata.cachedInputTokens },
            model: result.metadata.model,
            provider: result.metadata.provider,
            integrationId: result.metadata.integrationId,
            cost: usage.cost ?? result.metadata.cost,
            currency: result.metadata.currency ?? settings.costCurrency,
            truncated: (current as LlmFinishReport | null)?.finishReason === "length",
          };
        }
        const text = await completeTextRouted(settings, messages, capability, {
          accountScope: localWorkspaceScope(),
          signal: request.signal,
          label: request.label,
          onText: request.onText,
          onAttempt,
          onFinish,
          overflow: "fail",
          fallbackMaxOutputTokens: request.maxOutputTokens,
        });
        const last = current as LlmFinishReport | null;
        const usage = spent(attempts);
        return { text, usage: usage.usage, model: last?.model, provider: last?.provider, integrationId: last?.integrationId, cost: usage.cost, currency: settings.costCurrency, truncated: last?.finishReason === "length" };
      } catch (error) {
        throw toEngineError(error, capability, current, attempts);
      }
    },
  };
}

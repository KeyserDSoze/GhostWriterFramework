import { AiUnavailableError, type AiPort, type AiRequest, type AiResponse, type AiUsage } from "narrarium-engine";
import { completeTextRouted, completeToolRouted, NoCompletionCandidatesError, StaleRoutingConfigurationError } from "@/assistant/router";
import type { LlmUsageReport } from "@/assistant/llm";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { useSettingsStore } from "@/store/settingsStore";
import type { ChatCapability } from "@/types/settings";

/**
 * The engine's `AiPort` over the web app's AI router: routes, fallbacks, cost tracking and the
 * debug panel keep working for autopilot and director calls. Prompts arrive already framed by
 * the shared engine (`currentRequest` / `untrustedData`), so they are forwarded unchanged.
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
      try {
        if (request.json) {
          const result = await completeToolRouted<unknown>(settings, messages, capability, request.json, {
            accountScope: localWorkspaceScope(),
            signal: request.signal,
            label: request.label,
            fallbackMaxOutputTokens: request.maxOutputTokens,
          });
          return {
            text: JSON.stringify(result.output),
            json: result.output,
            usage: { inputTokens: result.metadata.inputTokens, outputTokens: result.metadata.outputTokens, cachedInputTokens: result.metadata.cachedInputTokens },
            model: result.metadata.model,
            provider: result.metadata.provider,
            integrationId: result.metadata.integrationId,
            cost: result.metadata.cost,
            currency: result.metadata.currency ?? settings.costCurrency,
          };
        }
        let report: LlmUsageReport | null = null;
        const text = await completeTextRouted(settings, messages, capability, {
          accountScope: localWorkspaceScope(),
          signal: request.signal,
          label: request.label,
          onText: request.onText,
          onUsage: (usage) => { report = usage; },
          fallbackMaxOutputTokens: request.maxOutputTokens,
        });
        const usage = report as LlmUsageReport | null;
        const normalized: AiUsage | undefined = usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens } : undefined;
        return { text, usage: normalized, model: usage?.model, provider: usage?.provider, integrationId: usage?.integrationId, cost: usage?.cost, currency: settings.costCurrency };
      } catch (error) {
        if (error instanceof NoCompletionCandidatesError || error instanceof StaleRoutingConfigurationError) throw new AiUnavailableError(capability);
        throw error;
      }
    },
  };
}

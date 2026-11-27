import { useTranslation } from "react-i18next";
import type { AutopilotRouteStep } from "narrarium-engine";
import { leftOutReason } from "@/autopilot/routeWords";
import { ProviderWords } from "@/components/autopilot/ProviderWords";
import { formatLimit } from "@/lib/formatLimit";

/** How an attempt ended, in words: what the provider answered, or which deadline ran out and whether it was the routing time that was left. */
function outcomeWords(t: ReturnType<typeof useTranslation>["t"], step: AutopilotRouteStep, language: string): string {
  const time = typeof step.timeoutMs === "number" && step.timeoutMs > 0 ? formatLimit(step.timeoutMs, language) : null;
  if (step.outcome === "ok") return t("autopilot.route.outcome.ok");
  if (step.outcome === "cancelled") return t("autopilot.route.outcome.cancelled");
  if (step.outcome === "timeout") return step.routing && time ? t("autopilot.route.outcome.timeoutRouting", { time }) : time ? t("autopilot.route.outcome.timeoutAfter", { time }) : t("autopilot.route.outcome.timeout");
  return typeof step.status === "number" ? t("autopilot.route.outcome.failedStatus", { status: step.status }) : t("autopilot.route.outcome.failed");
}

/**
 * Every candidate of the route of the call that failed, in the order the author wrote it: the integration and the model, how each attempt ended and how long it took (the provider's own words under it), and
 * each candidate that was left out with why. The primary that failed at once is the first line, and the fallback that ran out of time the second: the failure is never the last candidate's alone.
 */
export function RouteTrail({ route, integrationName }: { route: readonly AutopilotRouteStep[]; integrationName: (id: string) => string | undefined }) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <div data-error-route-box className="space-y-1">
      <p className="text-xs font-medium">{t("autopilot.route.title")}</p>
      <ol data-error-route className="list-decimal space-y-1.5 pl-5 text-xs">
        {route.map((step, index) => {
          const target = t("autopilot.route.target", { integration: integrationName(step.integrationId) ?? (step.integrationName || step.integrationId), model: step.model });
          const left = step.outcome === "left-out";
          const showDuration = !left && typeof step.durationMs === "number" && !(step.outcome === "timeout" && typeof step.timeoutMs === "number");
          return (
            <li key={`${index}:${step.position}:${step.integrationId}:${step.model}`} data-route-step={step.outcome} className="space-y-0.5">
              <p>
                <span className="font-medium">{target}</span>
                {" — "}
                {left ? t("autopilot.route.leftOut", { reason: leftOutReason(t, { reason: step.leftOut, why: step.why, promptTokens: step.promptTokens, windowTokens: step.windowTokens, windowDefault: step.windowDefault }) }) : outcomeWords(t, step, language)}
                {showDuration && <span className="text-muted-foreground"> · {t("autopilot.route.took", { time: formatLimit(step.durationMs as number, language) })}</span>}
              </p>
              {!left && (step.endpoint || step.apiVersion || step.protocol) && (
                <p className="break-all text-muted-foreground">
                  {[
                    step.endpoint ? <span key="address" data-route-address>{step.endpoint}{step.path}</span> : null,
                    step.protocol === "responses" ? <span key="protocol" data-route-protocol>{t("autopilot.route.protocolResponses")}</span> : null,
                    step.apiVersion ? <span key="version" data-route-api-version>{t("autopilot.route.apiVersion", { version: step.apiVersion })}</span> : null,
                  ].filter(Boolean).flatMap((part, at) => (at === 0 ? [part] : [" · ", part]))}
                </p>
              )}
              {!left && step.body && <ProviderWords body={step.body} className="text-muted-foreground" />}
              {!left && !step.body && step.message && <p className="whitespace-pre-wrap break-words text-muted-foreground [overflow-wrap:anywhere]">{step.message}</p>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

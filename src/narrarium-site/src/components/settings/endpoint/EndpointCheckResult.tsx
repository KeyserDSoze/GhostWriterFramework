import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import "@/i18n/endpoint";
import { cn } from "@/lib/utils";
import type { EndpointCheck } from "./useEndpointCheck";

/** The texts that say what to do about a status the endpoint answered with (`endpoint.remedy.*`). */
export function remedyOf(status: number): "key" | "forbidden" | "address" | "wait" | "busy" | "other" {
  if (status === 401) return "key";
  if (status === 403) return "forbidden";
  if (status === 404) return "address";
  if (status === 429) return "wait";
  return status >= 500 ? "busy" : "other";
}

type Tone = "idle" | "checking" | "ok" | "warning" | "error";

const ICON_CLASS = "mt-0.5 h-4 w-4 shrink-0";

/**
 * What a check found, in one status line that is there from the start, empty, and says the result when there is one: how fast the endpoint answered and how many models it lists, or the
 * status it answered with and what to do about it, or that it could not be reached (and that a browser cannot tell why). Every state has an icon and words, never a colour alone. The
 * engine's English words, with what to do, are in a disclosure beside the line and not in it, so that the line is short and what is read out is what the author needs.
 */
export function EndpointCheckResult({ state, id, className }: { state: EndpointCheck; id?: string; className?: string }) {
  const { t } = useTranslation();
  let tone: Tone = "idle";
  let text = "";
  let message: string | undefined;

  if (state.status === "checking") {
    tone = "checking";
    text = t("endpoint.checking");
  } else if (state.status === "failed") {
    tone = "error";
    text = t("endpoint.result.failed");
    message = state.message;
  } else if (state.status === "done") {
    const { probe } = state;
    const ms = Math.max(0, Math.round(probe.latencyMs));
    if (probe.outcome === "ok") {
      if (probe.models === undefined) {
        tone = "warning";
        text = t("endpoint.result.okNoList", { ms });
        message = probe.message;
      } else if (probe.models === 0) {
        tone = "warning";
        text = t("endpoint.result.okEmpty", { ms });
        message = probe.message;
      } else {
        tone = "ok";
        text = t("endpoint.result.ok", { ms, count: probe.models });
      }
    } else if (probe.outcome === "http-error") {
      tone = "error";
      const status = probe.httpStatus ?? 0;
      text = t("endpoint.result.error", { status, remedy: t(`endpoint.remedy.${remedyOf(status)}`) });
      message = probe.message;
    } else {
      tone = "error";
      text = t("endpoint.result.unreachable", { why: t("endpoint.why") });
      message = probe.message;
    }
  }

  const icon: ReactNode = tone === "checking"
    ? <Loader2 aria-hidden="true" className={cn(ICON_CLASS, "animate-spin text-muted-foreground motion-reduce:animate-none")} />
    : tone === "ok"
      ? <CheckCircle2 aria-hidden="true" className={cn(ICON_CLASS, "text-emerald-700 dark:text-emerald-400")} />
      : tone === "warning" || tone === "error"
        ? <AlertTriangle aria-hidden="true" className={cn(ICON_CLASS, tone === "error" ? "text-red-700 dark:text-red-400" : "text-amber-800 dark:text-amber-300")} />
        : null;

  return (
    <div className={cn("space-y-1", className)}>
      <p id={id} role="status" data-endpoint-status data-state={tone} className="flex items-start gap-2 text-sm">
        {tone !== "idle" && (
          <>
            {icon}
            <span className="min-w-0">{text}</span>
          </>
        )}
      </p>
      {message && (
        <details data-endpoint-details className="text-xs">
          <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("endpoint.checkDetails")}</summary>
          <p lang="en" className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono">{message}</p>
        </details>
      )}
    </div>
  );
}

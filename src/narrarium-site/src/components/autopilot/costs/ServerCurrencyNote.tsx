import { useTranslation } from "react-i18next";
import { Loader2, Send, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSendAiConfiguration } from "@/autopilot/sendAiConfiguration";
import { cn } from "@/lib/utils";
import "@/i18n/costs";

/**
 * A personal server prices the calls of its runs in the currency of the AI configuration it was last sent, never in the setting of a browser: after a change of
 * the currency (`recorded` absent), or where a run on the server records another currency than the setting (`recorded`), this says so and sends the current
 * configuration on request (`PUT /api/v1/ai`, as the note of the router does).
 */
export function ServerCurrencyNote({ currency, recorded, className }: { currency: string; recorded?: string; className?: string }) {
  const { t } = useTranslation();
  const { send, state, reason, online } = useSendAiConfiguration();
  return (
    <div data-server-currency-note role="note" className={cn("space-y-2 rounded-md border border-dashed p-3 text-xs", className)}>
      <p className="flex items-start gap-2">
        <Server className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span>{recorded ? t("costs.server.recorded", { recorded, currency }) : t("costs.server.changed", { currency })}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" disabled={state === "sending" || !online} onClick={() => void send()}>
          {state === "sending" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
          {state === "sending" ? t("costs.server.sending") : t("costs.server.send")}
        </Button>
        <p role="status" className="min-w-0">{state === "sent" ? t("costs.server.sent", { currency }) : state === "failed" ? t("costs.server.failed", { reason }) : !online ? t("costs.server.offline") : ""}</p>
      </div>
    </div>
  );
}

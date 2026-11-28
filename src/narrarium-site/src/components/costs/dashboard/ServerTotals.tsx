import { useTranslation } from "react-i18next";
import { Server } from "lucide-react";
import type { ServerSpend } from "@/costs/serverSpend";
import { useMoney } from "@/costs/useMoney";
import "@/i18n/costs";

/**
 * The books that run on the personal server, in a line of their own under the totals: the autopilot's own count of each, over all its runs, which the server does not split by month, so it is never
 * added to the months and days of this browser. It says what the figure holds (the autopilot's calls of the books that run there) and what it does not (a book whose count was not read yet, the calls
 * that have no price), in words.
 */
export function ServerTotals({ server }: { server: ServerSpend }) {
  const { t } = useTranslation();
  const money = useMoney();
  const read = server.books.length;
  return (
    <div data-server-totals className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      <p>
        <Server className="mr-1 inline h-3 w-3 align-[-1px]" aria-hidden="true" />
        <span className="font-medium text-foreground">{t("costs.dashboard.server.label")}</span>{" "}
        {read > 0 ? t("costs.dashboard.server.spend", { count: read, spend: money.totals(server.spend, { empty: "—" }) }) : t("costs.dashboard.server.none")}
      </p>
      <p data-server-includes>{t("costs.dashboard.server.includes")}</p>
      {server.unread.length > 0 && <p data-server-unread>{t("costs.dashboard.server.unread", { count: server.unread.length })}</p>}
      {server.unpricedCalls > 0 && <p data-server-unpriced>{t("costs.dashboard.server.unpriced", { count: server.unpricedCalls })}</p>}
    </div>
  );
}

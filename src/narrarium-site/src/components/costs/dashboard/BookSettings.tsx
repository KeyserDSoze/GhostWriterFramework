import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { isRecording } from "@/autopilot/calls/recording";
import { autoResumeOn } from "@/autopilot/resume";
import type { BookAutopilot } from "@/components/costs/dashboard/useBookAutopilots";
import { useMoney } from "@/costs/useMoney";
import type { AIIntegration, BookEntry } from "@/types/settings";

/**
 * The settings of a book at a glance, under its row (spec point 4): where it lives (GitHub or this device only), where its autopilot runs, its state and
 * where it publishes, the models of the period, «Retry later», the resume after a restart (this browser's, or the server's option), whether this device
 * keeps the calls of its autopilot, and its budget. Read-only: the link leads to the autopilot, where they are changed.
 */
export function BookSettings({ book, autopilot, models, integrations }: { book: BookEntry; autopilot: BookAutopilot | undefined; models: ReadonlyArray<{ integrationId: string; model: string }>; integrations: readonly AIIntegration[] }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const options = autopilot?.options ?? null;
  const server = book.autopilotHost === "server";
  const onOff = (value: boolean) => t(value ? "costs.dashboard.settings.on" : "costs.dashboard.settings.off");
  const status = autopilot?.read ? (autopilot.status ?? "never") : null;
  const unavailable = autopilot?.unavailable === true;
  const retry = options?.longRetry;
  const resume = server ? Boolean(options?.resumeAfterRestart) : autoResumeOn(book.id);
  const integrationName = (id: string) => integrations.find((entry) => entry.id === id)?.name ?? id;
  const tokens = new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language || "en", { notation: "compact", maximumFractionDigits: 1 });
  const budget = [
    (options?.budgetLimit ?? 0) > 0 ? money.amount(options!.budgetLimit, autopilot?.stats?.currency, { zero: "amount" }) : "",
    (options?.budgetTokens ?? 0) > 0 ? t("costs.dashboard.settings.tokens", { value: tokens.format(options!.budgetTokens!) }) : "",
  ].filter(Boolean).join(" · ");
  const entries: Array<[string, string]> = [
    [t("costs.dashboard.settings.github"), book.storageMode === "github" && book.owner && book.repo ? `${book.owner}/${book.repo}` : t("costs.dashboard.settings.localOnly")],
    [t("costs.dashboard.settings.host"), t(server ? "costs.dashboard.settings.hostServer" : "costs.dashboard.settings.hostBrowser")],
    [t("costs.dashboard.settings.autopilot"), unavailable ? t("costs.dashboard.budget.unavailable") : status === null ? t("costs.dashboard.budget.notRead") : [t(`costs.dashboard.settings.status.${status}`), autopilot?.limitReached ? t(`costs.dashboard.settings.limit.${autopilot.limitReached.kind}`) : "", autopilot?.publish ? t(`costs.dashboard.settings.publish.${autopilot.publish}`) : ""].filter(Boolean).join(" · ")],
    [t("costs.dashboard.settings.models"), models.length ? models.map((entry) => (entry.integrationId ? `${entry.model} (${integrationName(entry.integrationId)})` : entry.model)).join(", ") : t("costs.dashboard.settings.noModels")],
    [t("costs.dashboard.settings.retry"), retry ? t(retry.cycles === "unlimited" ? "costs.dashboard.settings.retryUnlimited" : "costs.dashboard.settings.retryEvery", { minutes: retry.everyMinutes, cycles: retry.cycles }) : onOff(false)],
    [t("costs.dashboard.settings.resume"), onOff(resume)],
    [t("costs.dashboard.settings.recording"), onOff(isRecording(book.id))],
    [t("costs.dashboard.settings.budget"), unavailable ? t("costs.dashboard.budget.unavailable") : !autopilot?.read ? t("costs.dashboard.budget.notRead") : budget || t("costs.dashboard.budget.none")],
  ];
  return (
    <div data-book-settings className="space-y-2 text-xs">
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map(([term, value]) => (
          <div key={term} className="flex min-w-0 flex-wrap gap-x-1.5">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="min-w-0 break-words font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <Link to={`/app/books/${encodeURIComponent(book.id)}/autopilot`} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 sm:min-h-6">{t("costs.dashboard.settings.open")}</Link>
    </div>
  );
}

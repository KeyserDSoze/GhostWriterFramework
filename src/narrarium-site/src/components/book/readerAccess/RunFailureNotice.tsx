import { useTranslation } from "react-i18next";
import { AlertTriangle, ExternalLink } from "lucide-react";
import "@/i18n/readerUpdate";
import type { BookEntry } from "@/types/settings";
import type { RepositoryInfo } from "@/readerAccess/api";
import { actionsSettingsUrl, billingUrl, type RunFailureInfo } from "@/readerAccess/runFailure";

/**
 * Why the latest publication failed, named from GitHub's own annotation: the Actions budget or billing (with the way to GitHub's billing page), Actions
 * disabled, a missing permission, or the message GitHub gave. A run that failed for the budget never built anything: the published site is what it was.
 */
export function RunFailureNotice({ failure, book, repository, compact = false }: { failure: RunFailureInfo; book: Pick<BookEntry, "owner" | "repo">; repository: RepositoryInfo | null; compact?: boolean }) {
  const { t } = useTranslation();
  const link = failure.cause === "budget"
    ? { href: billingUrl({ login: repository?.ownerLogin ?? book.owner, type: repository?.ownerType ?? "User" }), label: t("readerUpdate.runFailure.billingLink") }
    : failure.cause === "actions-disabled" ? { href: actionsSettingsUrl(book.owner, book.repo), label: t("readerUpdate.runFailure.actionsLink") } : null;
  return (
    <section role="note" aria-labelledby={`run-failure-${compact ? "c-" : ""}${failure.runId}`} className="space-y-2 rounded-md border border-destructive/60 bg-destructive/5 p-3 text-sm" data-testid={compact ? "reader-run-failure-compact" : "reader-run-failure"} data-cause={failure.cause}>
      <h3 id={`run-failure-${compact ? "c-" : ""}${failure.runId}`} className="flex items-start gap-2 font-semibold"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />{t(`readerUpdate.runFailure.${failure.cause}.title`)}</h3>
      {!compact && <p>{t(`readerUpdate.runFailure.${failure.cause}.body`, { message: failure.message ?? "" })}</p>}
      {!compact && failure.neverStarted && failure.cause !== "unreadable" && <p className="text-xs text-muted-foreground">{t("readerUpdate.runFailure.neverStarted")}</p>}
      {!compact && failure.cause === "budget" && <p className="text-xs">{t("readerUpdate.runFailure.publicWarning")}</p>}
      {link && (
        <a className="inline-flex min-h-6 items-center gap-1 font-medium underline underline-offset-2" href={link.href} target="_blank" rel="noopener noreferrer">
          {link.label}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /><span className="sr-only"> {t("readerAccess.opensNewTab")}</span>
        </a>
      )}
    </section>
  );
}

import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReaderResultText, ReaderText } from "@/readerAccess/messages";

const text = (t: (key: string, options?: Record<string, unknown>) => string, line: ReaderText) => t(line.key, line.params);

/**
 * What an operation did, in the words of `describeReaderResult`: what is done, why it stopped, what the published reader is doing, and a retry. A failure is an
 * alert (read out at once); a success is a status.
 */
export function ReaderResultNotice({ result, onRetry, onDismiss, busy }: { result: ReaderResultText; onRetry?: () => void; onDismiss: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const failed = result.tone === "error";
  return (
    <div role={failed ? "alert" : "status"} className={`space-y-2 rounded-md border p-3 text-sm ${failed ? "border-destructive/50 bg-destructive/5" : "border-primary/40 bg-primary/5"}`} data-testid="reader-result">
      <p className="flex items-start gap-2 font-medium">
        {failed ? <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
        <span>{text(t, result.headline)}</span>
      </p>
      {result.done.length > 0 && (
        <div>
          <p className="text-xs font-medium">{t("readerAccess.result.alreadyDone")}</p>
          <ul className="ml-4 list-disc text-xs text-muted-foreground">{result.done.map((line) => <li key={line.key}>{text(t, line)}</li>)}</ul>
        </div>
      )}
      {result.reason && <p><span className="font-medium">{t("readerAccess.result.reason")}:</span> {text(t, result.reason)}</p>}
      {result.effect && <p><span className="font-medium">{t("readerAccess.result.effect")}:</span> {text(t, result.effect)}</p>}
      <div className="flex flex-wrap gap-2">
        {failed && result.retry && onRetry && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRetry}>{t("readerAccess.retry")}</Button>}
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>{t("readerAccess.dismiss")}</Button>
      </div>
    </div>
  );
}

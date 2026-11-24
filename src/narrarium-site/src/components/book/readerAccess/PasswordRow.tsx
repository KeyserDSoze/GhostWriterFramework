import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Eye, EyeOff, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import type { ReaderPasswordRow } from "@/readerAccess/model";
import { LEGACY_READER_SECRET } from "@/readerAccess/contract";

/** A revealed password hides itself again after this long, so that a screen left open does not keep showing it. */
export const REVEAL_MS = 60_000;

interface Props {
  row: ReaderPasswordRow;
  busy: boolean;
  onRemove: () => void;
  onRetry: () => void;
}

/** One password: its name, when it was made, what state it is in (in words), the value masked until asked for, a copy button, and what can be done with it. */
export function PasswordRow({ row, busy, onRemove, onRetry }: Props) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<number | null>(null);
  const record = row.record;
  const label = record?.label || (row.secretName === LEGACY_READER_SECRET ? t("readerAccess.legacyLabel") : t("readerAccess.unlabelled"));

  useEffect(() => {
    if (!revealed) return undefined;
    timer.current = window.setTimeout(() => setRevealed(false), REVEAL_MS);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [revealed]);
  useEffect(() => { if (!copied) return undefined; const id = window.setTimeout(() => setCopied(false), 4_000); return () => window.clearTimeout(id); }, [copied]);

  async function copy() {
    if (!record) return;
    setCopyFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(record.value);
      setCopied(true);
    } catch { setCopyFailed(true); }
  }

  const retriable = row.state === "pending" || row.state === "out-of-sync";
  return (
    <li className="space-y-2 rounded-md border p-3" data-testid="reader-password">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-medium">{label}</p>
        <p className="text-xs font-medium" data-state={row.state}>{t(`readerAccess.state.${row.state}`)}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        <span>{t("readerAccess.secretName")}: <code>{row.secretName}</code></span>
        {record && <span> · {t("readerAccess.created")}: <LocalTime value={record.createdAt} /></span>}
      </p>
      {record ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-sm" aria-label={t("readerAccess.passwordValueFor", { label })}>
            {revealed ? record.value : "••••••••••••"}
          </span>
          <Button type="button" size="sm" variant="outline" aria-pressed={revealed} aria-label={revealed ? t("readerAccess.hideFor", { label }) : t("readerAccess.revealFor", { label })} onClick={() => setRevealed((value) => !value)}>
            {revealed ? <EyeOff aria-hidden="true" className="mr-1 h-4 w-4" /> : <Eye aria-hidden="true" className="mr-1 h-4 w-4" />}{revealed ? t("readerAccess.hide") : t("readerAccess.reveal")}
          </Button>
          <Button type="button" size="sm" variant="outline" aria-label={t("readerAccess.copyFor", { label })} onClick={() => void copy()}>
            {copied ? <Check aria-hidden="true" className="mr-1 h-4 w-4" /> : <Copy aria-hidden="true" className="mr-1 h-4 w-4" />}{t("readerAccess.copy")}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t(row.state === "legacy" ? "readerAccess.legacyNote" : row.state === "dangling" ? "readerAccess.danglingNote" : "readerAccess.unknownValueNote")}</p>
      )}
      <div role="status" aria-live="polite" className="min-h-0 text-xs">
        {copied && <p className="text-muted-foreground">{t("readerAccess.copied", { label })}</p>}
        {copyFailed && <p className="text-destructive">{t("readerAccess.copyFailed")}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {retriable && (
          <Button type="button" size="sm" variant="outline" disabled={busy} aria-label={t("readerAccess.retryFor", { label })} onClick={onRetry}>
            {busy ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />}{row.state === "out-of-sync" ? t("readerAccess.publishAgain") : t("readerAccess.retry")}
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={busy} aria-label={t("readerAccess.removeFor", { label })} onClick={onRemove}>
          <Trash2 aria-hidden="true" className="mr-1 h-4 w-4" />{row.state === "removing" ? t("readerAccess.finishRemoving") : t("readerAccess.remove")}
        </Button>
      </div>
    </li>
  );
}

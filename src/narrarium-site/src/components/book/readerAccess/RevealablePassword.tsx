import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import "@/i18n/readerAccess";
import { Button } from "@/components/ui/button";
import { REVEAL_MS } from "@/components/book/readerAccess/PasswordRow";

/** A password masked until asked for, with Show / Hide (it hides itself again after a minute) and Copy, named after what it is. The value is never in any text but its own. */
export function RevealablePassword({ value, label, className }: { value: string; label: string; className?: string }) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => {
    if (!revealed) return undefined;
    const id = window.setTimeout(() => setRevealed(false), REVEAL_MS);
    return () => window.clearTimeout(id);
  }, [revealed]);
  useEffect(() => { if (!copied) return undefined; const id = window.setTimeout(() => setCopied(false), 4_000); return () => window.clearTimeout(id); }, [copied]);

  async function copy() {
    setCopyFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch { setCopyFailed(true); }
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-sm" aria-label={t("readerAccess.passwordValueFor", { label })}>{revealed ? value : "••••••••••••"}</span>
        <Button type="button" size="sm" variant="outline" aria-pressed={revealed} aria-label={revealed ? t("readerAccess.hideFor", { label }) : t("readerAccess.revealFor", { label })} onClick={() => setRevealed((current) => !current)}>
          {revealed ? <EyeOff aria-hidden="true" className="mr-1 h-4 w-4" /> : <Eye aria-hidden="true" className="mr-1 h-4 w-4" />}{revealed ? t("readerAccess.hide") : t("readerAccess.reveal")}
        </Button>
        <Button type="button" size="sm" variant="outline" aria-label={t("readerAccess.copyFor", { label })} onClick={() => void copy()}>
          {copied ? <Check aria-hidden="true" className="mr-1 h-4 w-4" /> : <Copy aria-hidden="true" className="mr-1 h-4 w-4" />}{t("readerAccess.copy")}
        </Button>
      </div>
      <div role="status" aria-live="polite" className="min-h-0 text-xs">
        {copied && <p className="text-muted-foreground">{t("readerAccess.copied", { label })}</p>}
        {copyFailed && <p className="text-destructive">{t("readerAccess.copyFailed")}</p>}
      </div>
    </div>
  );
}

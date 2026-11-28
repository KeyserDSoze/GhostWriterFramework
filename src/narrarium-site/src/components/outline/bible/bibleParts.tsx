import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, Loader2, Save } from "lucide-react";
import { BookConflictError, type DesignFinding } from "narrarium-engine";
import "@/i18n/design";
import "@/i18n/bibleStudio";
import { Button } from "@/components/ui/button";
import type { OutlineSource } from "@/outline/outlineSource";
import { cn } from "@/lib/utils";

/** The small parts the Bible's sections share: a titled section, the icon of a finding, the save of a file of the book, a form that follows its file, the row that says how a save went. */

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm">
      <h3 id={`${id}-title`} className="text-lg font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export function FindingIcon({ finding }: { finding: DesignFinding }) {
  return finding.severity === "warning"
    ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
    : <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

/** Save a file of `bible/`, expecting it as it was read: what changed elsewhere is never overwritten. */
export function useBibleSave(source: OutlineSource | null, onSaved: () => void) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const save = async (path: string, content: string, expectedHash: string | null, label: string, okText?: string): Promise<boolean> => {
    if (!source) return false;
    setBusy(true);
    setMessage(null);
    try {
      await source.commit([{ path, content, expectedHash }], `Bible: ${label}`);
      setMessage({ tone: "ok", text: okText ?? t("design.bible.saved") });
      onSaved();
      return true;
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof BookConflictError ? t("design.bible.conflict") : t("design.bible.saveFailed") });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, save };
}

/** A form that follows what the file says while the author has not changed it (the autopilot, a sync, another tab may change the file). */
export function useFollowingForm<T>(initial: T): [T, (next: T) => void] {
  const key = JSON.stringify(initial);
  const [state, setState] = useState<{ key: string; value: T; edited: boolean }>({ key, value: initial, edited: false });
  if (state.key !== key && (!state.edited || JSON.stringify(state.value) === key)) setState({ key, value: initial, edited: false });
  return [state.value, (next) => setState({ key, value: next, edited: true })];
}

export function SaveRow({ busy, disabled, label, message }: { busy: boolean; disabled: boolean; label: string; message: { tone: "ok" | "error"; text: string } | null }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="submit" size="sm" disabled={busy || disabled}>{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}{label}</Button>
      <p role="status" className={cn("text-xs", message?.tone === "error" ? "font-medium text-destructive" : "text-muted-foreground")}>{message?.text ?? ""}</p>
    </div>
  );
}

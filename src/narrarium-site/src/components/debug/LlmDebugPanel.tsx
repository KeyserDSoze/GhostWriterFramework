import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, ChevronRight } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/store/uiStore";
import { useLlmDebugStore, type LlmDebugEntry, type LlmRequestKind } from "@/debug/llmDebugStore";

function eur(value?: number): string {
  if (value == null) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 5 }).format(value || 0);
}

function num(value?: number): string {
  return new Intl.NumberFormat().format(Math.round(value || 0));
}

const KIND_LABEL: Record<LlmRequestKind, string> = { chat: "Chat", tts: "TTS", stt: "STT", image: "Image" };

export function LlmDebugPanel() {
  const { t } = useTranslation();
  const entries = useLlmDebugStore((s) => s.entries);
  const clear = useLlmDebugStore((s) => s.clear);
  const debugOpen = useUiStore((s) => s.debugOpen);
  const setDebugOpen = useUiStore((s) => s.setDebugOpen);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const totalCost = useMemo(() => entries.reduce((sum, e) => sum + (e.cost ?? 0), 0), [entries]);
  const selected = useMemo(() => entries.find((e) => e.id === selectedId) ?? entries[0] ?? null, [entries, selectedId]);

  return (
    <>
      <Dialog open={debugOpen} onOpenChange={(next) => { setConfirmClear(false); setDebugOpen(next); }}>
        <DialogContent hideCloseButton className="left-1/2 top-1/2 flex h-[90dvh] max-h-[90dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 flex-col p-0 sm:w-[920px]">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <p className="font-semibold">{t("debug.title")}</p>
              <p className="text-xs text-muted-foreground">{t("debug.subtitle", { cost: eur(totalCost) })}</p>
            </div>
            {confirmClear ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("debug.clearConfirm")}</span>
                <Button variant="destructive" size="sm" onClick={() => { clear(); setConfirmClear(false); }}>{t("debug.clearYes")}</Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>{t("common.cancel")}</Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)} disabled={entries.length === 0}>
                <Trash2 className="mr-1 h-3.5 w-3.5" />{t("debug.clear")}
              </Button>
            )}
          </div>

          {entries.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t("debug.empty")}</div>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[300px_1fr]">
              <div className="min-h-0 overflow-auto border-b sm:border-b-0 sm:border-r">
                {entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setSelectedId(entry.id)}
                    className={`flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-left text-xs transition hover:bg-muted ${selected?.id === entry.id ? "bg-muted" : ""}`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <StatusDot entry={entry} />
                        <span className="font-medium">{KIND_LABEL[entry.kind]}</span>
                        <span className="truncate text-muted-foreground">{entry.label}</span>
                      </div>
                      <p className="truncate text-[11px] text-muted-foreground">{entry.model} · {new Date(entry.at).toLocaleTimeString()}</p>
                    </div>
                    <div className="flex items-center gap-1 whitespace-nowrap">
                      <span className="font-semibold">{eur(entry.cost)}</span>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </button>
                ))}
              </div>

              <div className="min-h-0 overflow-auto p-4">
                {selected ? <RequestDetail entry={selected} /> : null}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function StatusDot({ entry }: { entry: LlmDebugEntry }) {
  const color = entry.status === "pending" ? "bg-amber-500" : entry.status === "error" ? "bg-destructive" : "bg-emerald-500";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function RequestDetail({ entry }: { entry: LlmDebugEntry }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Stat label={t("debug.model")} value={entry.model} />
        <Stat label={t("debug.cost")} value={eur(entry.cost)} />
        <Stat label={t("debug.tokensIn")} value={num(entry.inputTokens)} />
        <Stat label={t("debug.tokensOut")} value={num(entry.outputTokens)} />
      </div>

      {entry.error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">{entry.error}</div>
      )}

      {entry.messages?.map((message, index) => (
        <div key={index} className="rounded-lg border bg-muted/20 p-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{message.role}</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">{message.content}</pre>
        </div>
      ))}

      {entry.response != null && (
        <div className="rounded-lg border bg-emerald-500/5 p-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("debug.response")}</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">{entry.response}</pre>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-medium">{value}</p>
    </div>
  );
}

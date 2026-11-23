import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Cloud, Github, HardDrive, Loader2, Server, ShieldCheck, Trash2 } from "lucide-react";
import { AI_CALL_BUDGETS } from "narrarium-engine";
import "@/i18n/autopilotCallsSettings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { LocalTime } from "@/components/ui/local-time";
import { Switch } from "@/components/ui/switch";
import { COPY_CHOICES, SERVICE_NAME, choiceStates, statusLine, type CopyChoice } from "@/components/autopilot/config/AiCallsModel";
import { chooseCopyTarget, useAiCallsCopy, useSavedCopyTarget } from "@/components/autopilot/config/useAiCallsCopy";
import { callsCopier, copyServices } from "@/autopilot/calls/copies/services";
import { setRecording, useRecording } from "@/autopilot/calls/recording";
import type { CopyTargetKind } from "@/autopilot/calls/copies/types";
import { formatSize } from "@/autopilot/format";
import { useConnectionStore } from "@/account/connectionStore";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookEntry } from "@/types/settings";

const GIB = 1024 * 1024 * 1024;
const ACCOUNT_LINK = "/app/account-sync";
const GITHUB_LINK = "/app/settings/github";

/** A size in the units a computer counts in: MiB below a gibibyte, GiB above. */
function sizeOf(bytes: number): string {
  if (bytes >= GIB) return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / GIB)} GiB`;
  return formatSize(bytes);
}

function ChoiceIcon({ choice }: { choice: CopyChoice }) {
  const className = "h-4 w-4 shrink-0 text-muted-foreground";
  if (choice === "github") return <Github aria-hidden="true" className={className} />;
  if (choice === "none") return <HardDrive aria-hidden="true" className={className} />;
  return <Cloud aria-hidden="true" className={className} />;
}

/**
 * The «AI calls» tab of the autopilot settings: where the records of the autopilot's messages are kept. This device is always on, and the personal
 * server when the book runs there; one more place can get a copy of every finished task (the book's GitHub repository, Google Drive or OneDrive),
 * through the connections the author already has. The choice is saved at once, per book, with the account's settings: it is not a run setting, so it
 * can change while the autopilot works, and there is no save bar. A place that cannot be used says why, with the way to fix it.
 */
export function AiCallsCard({ book }: { book: BookEntry }) {
  const { t } = useTranslation();
  const { save } = useSettings();
  const settings = useSettingsStore((state) => state.settings);
  const connections = useConnectionStore((state) => state.configuration);
  const saved = useSavedCopyTarget(book.id);
  const view = useAiCallsCopy(book.id, saved);
  const host = book.autopilotHost === "server" ? "server" : "browser";
  const states = choiceStates(book, settings, connections);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "copies"; target: CopyTargetKind } | { kind: "records" } | null>(null);
  const [busy, setBusy] = useState(false);
  const legendId = useId();
  const helpId = useId();
  const privacyId = useId();
  const recording = useRecording(book.id);
  const mounted = useRef(true);
  // The buttons that open the dialog are not its triggers: focus goes back to the one that was used (or to the tab when it is gone).
  const opener = useRef<HTMLElement | null>(null);
  const ask = (next: NonNullable<typeof confirm>) => (event: { currentTarget: HTMLElement }) => { opener.current = event.currentTarget; setConfirm(next); };
  useEffect(() => () => { mounted.current = false; }, []);

  const place = (target: CopyTargetKind) => t(`autopilot.callsSettings.place.${target}`);
  const current: CopyChoice = saved ?? "none";

  const choose = async (choice: CopyChoice) => {
    if (choice === current || !states.find((entry) => entry.choice === choice)?.available) return;
    const next = choice === "none" ? null : choice;
    try {
      await chooseCopyTarget(book.id, next, saved, save);
      setMessage({ text: next ? t("autopilot.callsSettings.copy.saved", { place: place(next) }) : t("autopilot.callsSettings.copy.savedNone"), tone: "ok" });
    } catch (error) {
      setMessage({ text: t("autopilot.callsSettings.copy.saveFailed", { error: error instanceof Error ? error.message : String(error) }), tone: "error" });
    }
  };

  const deleteCopies = async (target: CopyTargetKind) => {
    setBusy(true);
    try {
      await callsCopier().deleteCopies(book.id, target);
      if (mounted.current) setMessage({ text: t("autopilot.callsSettings.remove.copiesDone", { place: place(target) }), tone: "ok" });
    } catch (error) {
      if (mounted.current) setMessage({ text: t("autopilot.callsSettings.remove.copiesFailed", { place: place(target), error: error instanceof Error ? error.message : String(error) }), tone: "error" });
    } finally {
      if (mounted.current) { setBusy(false); setConfirm(null); view.refresh(); }
    }
  };

  const deleteRecords = async () => {
    setBusy(true);
    try {
      const services = copyServices();
      if (services.deleteRecords) await services.deleteRecords(book.id, host);
      else await services.store()?.deleteBook(book.id);
      if (mounted.current) setMessage({ text: t("autopilot.callsSettings.remove.recordsDone"), tone: "ok" });
    } catch (error) {
      if (mounted.current) setMessage({ text: t("autopilot.callsSettings.remove.recordsFailed", { error: error instanceof Error ? error.message : String(error) }), tone: "error" });
    } finally {
      if (mounted.current) { setBusy(false); setConfirm(null); view.refresh(); }
    }
  };

  const status = view.status;
  const line = status && saved ? statusLine(status) : null;
  const refused = saved && view.checked?.target === saved ? view.checked.code : null;
  const used = view.totals;
  const publicRefused = refused === "public-repository" || line?.kind === "public-repository";
  // What needs the author is marked with an icon as well as said in words.
  const needsAttention = publicRefused || line?.kind === "reconnect" || line?.kind === "archive-full" || refused === "reconnect";

  return (
    <div id="autopilot-calls" tabIndex={-1} className="space-y-5 focus:outline-none" aria-labelledby={`${legendId}-title`}>
      <div>
        <h2 id={`${legendId}-title`} className="text-lg font-semibold">{t("autopilot.callsSettings.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("autopilot.callsSettings.intro")}</p>
      </div>

      <section aria-labelledby={`${legendId}-device`} className="space-y-1 rounded-lg border p-3">
        <h3 id={`${legendId}-device`} className="flex items-center gap-2 text-sm font-medium"><HardDrive aria-hidden="true" className="h-4 w-4" />{t("autopilot.callsSettings.device.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("autopilot.callsSettings.device.fact", { budget: sizeOf(AI_CALL_BUDGETS.browserPerBookBytes) })}</p>
        {used && <p data-testid="ai-calls-device-used" className="text-xs text-muted-foreground">{used.tasks > 0 ? t("autopilot.callsSettings.device.used", { count: used.tasks, size: sizeOf(used.bytes) }) : t("autopilot.callsSettings.device.usedNone")}</p>}
        <div className="flex items-start justify-between gap-3 pt-2">
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${legendId}-recording`} className="text-sm font-medium">{t("autopilot.callsSettings.device.recording.label")}</Label>
            <p id={`${legendId}-recording-help`} className="text-xs text-muted-foreground">{recording ? t(host === "server" ? "autopilot.callsSettings.device.recording.helpServer" : "autopilot.callsSettings.device.recording.help") : t("autopilot.callsSettings.device.recording.off")}</p>
          </div>
          <Switch id={`${legendId}-recording`} className="mt-0.5" checked={recording} aria-describedby={`${legendId}-recording-help`} onCheckedChange={(on) => setRecording(book.id, on)} />
        </div>
      </section>

      {host === "server" && (
        <section aria-labelledby={`${legendId}-server`} className="space-y-1 rounded-lg border p-3">
          <h3 id={`${legendId}-server`} className="flex items-center gap-2 text-sm font-medium"><Server aria-hidden="true" className="h-4 w-4" />{t("autopilot.callsSettings.server.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("autopilot.callsSettings.server.fact")}</p>
        </section>
      )}

      <fieldset className="space-y-2" aria-describedby={`${helpId} ${privacyId}`}>
        <legend id={legendId} className="text-sm font-medium">{t("autopilot.callsSettings.copy.legend")}</legend>
        <p id={helpId} className="text-xs text-muted-foreground">{t("autopilot.callsSettings.copy.help")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {COPY_CHOICES.map((choice) => {
            const state = states.find((entry) => entry.choice === choice)!;
            const checked = current === choice;
            const unavailable = !state.available;
            const target = choice === "none" ? null : choice;
            const detailId = `${legendId}-${choice}`;
            const disabled = unavailable && !checked;
            return (
              <div key={choice} className={`rounded-lg border p-2 transition ${checked ? "border-primary/60 bg-primary/5" : disabled ? "opacity-90" : "hover:bg-muted/40"}`}>
                <label className={`flex items-center gap-2 text-sm font-medium ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
                  <input type="radio" name={`${legendId}-copy`} className="h-4 w-4 accent-primary" value={choice} checked={checked} disabled={disabled} aria-describedby={detailId} onChange={() => void choose(choice)} />
                  <ChoiceIcon choice={choice} />
                  {t(`autopilot.callsSettings.copy.choice.${choice}`)}
                </label>
                <div id={detailId} className="mt-1 space-y-1 text-xs text-muted-foreground">
                  <p>{t(`autopilot.callsSettings.copy.choiceHelp.${choice}`)}</p>
                  {unavailable && state.unavailable && (
                    <p className="flex flex-wrap items-center gap-x-2">
                      <span>{t(`autopilot.callsSettings.copy.unavailable.${state.unavailable}`)}</span>
                      {state.unavailable !== "noRepository" && (
                        <Link className="inline-flex min-h-6 items-center font-medium text-foreground underline underline-offset-2" to={state.unavailable === "noToken" ? GITHUB_LINK : ACCOUNT_LINK}>{t(state.unavailable === "noToken" ? "autopilot.callsSettings.copy.unavailable.tokenLink" : "autopilot.callsSettings.copy.unavailable.link")}</Link>
                      )}
                    </p>
                  )}
                  {target && state.reconnect && !unavailable && (
                    <p className="flex flex-wrap items-center gap-x-2">
                      <span>{t("autopilot.callsSettings.copy.reconnectNeeded")}</span>
                      <Link className="inline-flex min-h-6 items-center font-medium text-foreground underline underline-offset-2" to={ACCOUNT_LINK}>{t("autopilot.callsSettings.copy.reconnect", { service: SERVICE_NAME[target] })}</Link>
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p id={privacyId} className="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground"><ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /><span>{t("autopilot.callsSettings.privacy")}</span></p>
        <div role="status" aria-live="polite" className="text-xs" data-testid="ai-calls-message">
          {message && <p className={message.tone === "error" ? "font-medium text-destructive" : "text-muted-foreground"}>{message.text}</p>}
        </div>
      </fieldset>

      {saved && status && (
        <section aria-labelledby={`${legendId}-state`} className="space-y-2 rounded-lg border p-3">
          <h3 id={`${legendId}-state`} className="text-sm font-medium">{t("autopilot.callsSettings.status.title")}</h3>
          {view.checking && !refused && !line ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />{t("autopilot.callsSettings.status.checking", { place: place(saved) })}</p> : null}
          <p className="flex items-start gap-2 text-sm" data-testid="ai-calls-state">
            {needsAttention && <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />}
            <span>{publicRefused ? t("autopilot.callsSettings.status.public") : line ? <StatusText line={line} place={place(saved)} /> : null}</span>
          </p>
          {refused === "reconnect" && line?.kind !== "reconnect" && (
            <p className="text-sm">{t("autopilot.callsSettings.status.reconnectNone", { place: place(saved) })}</p>
          )}
          {(line?.kind === "reconnect" || refused === "reconnect") && !publicRefused && (
            <Button asChild size="sm" variant="outline"><Link to={ACCOUNT_LINK}>{t("autopilot.callsSettings.copy.reconnect", { service: SERVICE_NAME[saved] })}</Link></Button>
          )}
          <p className="text-xs text-muted-foreground">{t("autopilot.callsSettings.status.archive", { place: place(saved), size: sizeOf(status.bytes), cap: sizeOf(status.capBytes) })}{status.trimmedDays > 0 ? ` ${t("autopilot.callsSettings.status.trimmed", { count: status.trimmedDays })}` : ""}</p>
        </section>
      )}

      {(saved || view.kept.length > 0) && (
        <div className="space-y-2">
          {saved && <RemoveButton label={t("autopilot.callsSettings.remove.copies", { place: place(saved) })} disabled={busy} onClick={ask({ kind: "copies", target: saved })} />}
          {view.kept.map((entry) => (
            <div key={entry.target} className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("autopilot.callsSettings.status.kept", { place: place(entry.target) })}</p>
              <RemoveButton label={t("autopilot.callsSettings.remove.copies", { place: place(entry.target) })} disabled={busy} onClick={ask({ kind: "copies", target: entry.target })} />
            </div>
          ))}
        </div>
      )}

      <div className="border-t pt-3">
        <RemoveButton label={t("autopilot.callsSettings.remove.records")} disabled={busy} onClick={ask({ kind: "records" })} />
      </div>

      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open && !busy) setConfirm(null); }}>
        <DialogContent onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = opener.current?.isConnected ? opener.current : document.getElementById("autopilot-calls");
          target?.focus();
        }}>
          {confirm?.kind === "copies" && (
            <>
              <DialogHeader>
                <DialogTitle>{t("autopilot.callsSettings.remove.copiesTitle", { place: place(confirm.target) })}</DialogTitle>
                <DialogDescription>{t("autopilot.callsSettings.remove.copiesBody", { place: place(confirm.target) })}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>{t("autopilot.callsSettings.remove.cancel")}</Button>
                <Button variant="destructive" disabled={busy} onClick={() => void deleteCopies(confirm.target)}>{busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}{t("autopilot.callsSettings.remove.copiesConfirm")}</Button>
              </DialogFooter>
            </>
          )}
          {confirm?.kind === "records" && (
            <>
              <DialogHeader>
                <DialogTitle>{t("autopilot.callsSettings.remove.recordsTitle")}</DialogTitle>
                <DialogDescription>{host === "server" ? t("autopilot.callsSettings.remove.recordsBodyServer") : t("autopilot.callsSettings.remove.recordsBodyDevice")}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>{t("autopilot.callsSettings.remove.cancel")}</Button>
                <Button variant="destructive" disabled={busy} onClick={() => void deleteRecords()}>{busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}{t("autopilot.callsSettings.remove.recordsConfirm")}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RemoveButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: (event: { currentTarget: HTMLElement }) => void }): ReactNode {
  return <Button type="button" size="sm" variant="outline" className="text-destructive" disabled={disabled} onClick={onClick}><Trash2 aria-hidden="true" className="h-4 w-4" />{label}</Button>;
}

function StatusText({ line, place }: { line: ReturnType<typeof statusLine>; place: string }): ReactNode {
  const { t } = useTranslation();
  switch (line.kind) {
    case "archive-full": return t("autopilot.callsSettings.status.archiveFull", { place });
    case "public-repository": return t("autopilot.callsSettings.status.public");
    case "reconnect": return line.waiting > 0 ? t("autopilot.callsSettings.status.reconnect", { count: line.waiting, place }) : t("autopilot.callsSettings.status.reconnectNone", { place });
    case "waiting": {
      const base = t("autopilot.callsSettings.status.waiting", { count: line.waiting, place });
      const reason = line.reason === "offline" ? t("autopilot.callsSettings.status.offline")
        : line.reason === "rate-limited" ? t("autopilot.callsSettings.status.rateLimited", { place })
        : line.reason === "unavailable" ? t("autopilot.callsSettings.status.unavailable", { place })
        : line.reason === "failed" ? t("autopilot.callsSettings.status.failed") : null;
      return reason ? `${base} · ${reason}` : base;
    }
    case "idle": return line.copiedUpTo
      ? <>{t("autopilot.callsSettings.status.copiedUpTo")} <LocalTime value={line.copiedUpTo} /></>
      : t("autopilot.callsSettings.status.nothingCopied");
  }
}

export default AiCallsCard;

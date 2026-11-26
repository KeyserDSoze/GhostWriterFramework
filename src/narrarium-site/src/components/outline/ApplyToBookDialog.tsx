import { Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, BookOpen, CheckCircle2, Loader2, PenLine, Play, RefreshCcw, Wand2 } from "lucide-react";
import type { AutopilotState, ReviseChaptersInput } from "narrarium-engine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { changeKindText } from "@/components/outline/OutlineChanges";
import { withAutopilotTranslations } from "@/i18n/autopilot";
import { formatCount } from "@/autopilot/format";
import { reviseInput, toRewrite, type ApplyChoice, type ApplyModel, type ApplyRow } from "@/outline/applyModel";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

/** The estimate reads the files and the models of the book: it comes with the panel, and with the texts of the autopilot it shares with the setup form. */
const ApplyEstimate = lazy(withAutopilotTranslations(() => import("@/components/outline/ApplyEstimate")));

const CHOICES: readonly ApplyChoice[] = ["follow", "keep", "later"];

export interface ApplyToBookDialogProps {
  open: boolean;
  onClose: () => void;
  book: BookEntry;
  branch: string;
  structure: BookStructure | undefined;
  /** `null` while the records of the frozen chapters are read. */
  model: ApplyModel | null;
  state: AutopilotState | null;
  /** The autopilot of the book runs now (here, in another tab or on the server): it takes the choices at its next step, and nothing is started. */
  running: boolean;
  /** The book runs on a personal server that predates the campaigns: nothing can be applied from here. */
  unsupported: boolean;
  busy: boolean;
  /** Record the choices, and start the autopilot when `start` and it does not run then. Answers whether it was done. */
  onApply: (input: ReviseChaptersInput, start: boolean) => Promise<boolean>;
}

/**
 * «Apply to the book»: every written chapter whose entry changed, with what the setting of the autopilot would do with it and a choice (rewrite it to follow the
 * Synopsis, keep the text, decide later); the other changes, told; the words for the director; what it costs. Nothing is recorded before the author confirms
 * the chapters that will be rewritten, which are all written and closed. Then the autopilot rewrites them one at a time, in the order of the book, and goes on
 * with its plan. A chapter the author wrote is rewritten only when the author chooses it here.
 */
export function ApplyToBookDialog({ open, onClose, book, branch, structure, model, state, running, unsupported, busy, onApply }: ApplyToBookDialogProps) {
  const { t } = useTranslation();
  const say = (key: string, options?: Record<string, unknown>) => t(key, options) as string;
  const id = useId();
  const [choices, setChoices] = useState<Map<number, ApplyChoice>>(() => new Map());
  const [instructions, setInstructions] = useState<Map<number, string>>(() => new Map());
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLHeadingElement | null>(null);

  // A panel opened again starts from the choices the chapters have by default.
  useEffect(() => {
    if (!open) return;
    setChoices(new Map());
    setInstructions(new Map());
    setNote("");
    setConfirming(false);
  }, [open]);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const decide = model?.decide ?? [];
  const choiceOf = (row: ApplyRow) => choices.get(row.row.number) ?? row.initial;
  const rewriting = useMemo(() => (model ? toRewrite(model.decide, choices) : []), [model, choices]);
  const numbers = rewriting.map((row) => row.row.number);
  const start = !running && rewriting.length > 0;
  const applyLabel = start ? t("outline.apply.applyStart") : t("outline.apply.apply");
  const apply = async () => {
    if (!model) return;
    // The autopilot is started when it has chapters to rewrite: whether it already runs is known for sure only once they are recorded.
    const done = await onApply(reviseInput(model.decide, choices, { note, instructions }), rewriting.length > 0);
    if (done) onClose();
  };

  const statusOf = (row: ApplyRow): string[] => [
    row.row.approved ? t("outline.apply.status.approved") : "",
    row.frozenBy ? t(`outline.apply.status.frozen.${row.frozenBy}`) : "",
    row.authorWritten ? t("outline.apply.status.imported") : "",
  ].filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent data-outline-apply="" className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("outline.apply.title")}</DialogTitle>
          <DialogDescription>{t("outline.apply.intro")}</DialogDescription>
        </DialogHeader>
        {unsupported && <Alert variant="destructive"><AlertDescription>{t("outline.apply.oldServer")}</AlertDescription></Alert>}

        {!model ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("outline.apply.reading")}</p>
        ) : confirming ? (
          <section aria-labelledby={`${id}-confirm`} data-outline-apply-confirm="" className="space-y-3">
            <h3 id={`${id}-confirm`} ref={confirmRef} tabIndex={-1} className="text-base font-semibold focus:outline-none">{t("outline.apply.confirm.title", { count: rewriting.length })}</h3>
            <p className="text-sm">{t("outline.apply.confirm.body")}</p>
            <ul className="space-y-1.5">
              {rewriting.map((row) => (
                <li key={row.row.number} className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-sm">
                  <span className="font-medium">{t("outline.changes.chapter", { number: row.row.number })}{row.row.title ? ` — ${row.row.title}` : ""}</span>
                  {statusOf(row).length > 0 && <span className="text-muted-foreground"> · {statusOf(row).join(" · ")}</span>}
                  {row.authorWritten && <p className="mt-1 text-xs">{t("outline.apply.confirm.imported")}</p>}
                </li>
              ))}
            </ul>
            {decide.some((row) => choiceOf(row) === "later") && (
              <p className="text-sm text-muted-foreground">{t("outline.apply.confirm.untouched", { count: decide.filter((row) => choiceOf(row) === "later").length, numbers: decide.filter((row) => choiceOf(row) === "later").map((row) => formatCount(row.row.number)) })}</p>
            )}
            <p className="text-sm text-muted-foreground">{running ? t("outline.apply.confirm.running") : t("outline.apply.confirm.start")}</p>
          </section>
        ) : (
          <>
            {decide.length > 0 ? (
              <section aria-labelledby={`${id}-decide`} className="space-y-2">
                <h3 id={`${id}-decide`} className="text-sm font-semibold">{t("outline.apply.decideTitle", { count: decide.length })}</h3>
                <ol className="space-y-2">
                  {decide.map((row) => {
                    const number = row.row.number;
                    const choice = choiceOf(row);
                    const name = `${id}-choice-${number}`;
                    const describedBy = `${id}-without-${number}`;
                    return (
                      <li key={number} data-apply-chapter={number}>
                        <fieldset className="space-y-2 rounded-xl border border-layer p-3" aria-describedby={describedBy}>
                          <legend className="px-1 text-sm font-semibold">{t("outline.changes.chapter", { number })}{row.row.title ? ` — ${row.row.title}` : ""}</legend>
                          <p className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{changeKindText(say, row.row)}</span>
                            {statusOf(row).map((text) => <span key={text}>· {text}</span>)}
                          </p>
                          <p id={describedBy} className="text-xs">{t(`outline.apply.without.${row.outcome}`)}{row.row.held === "deferred" ? ` ${t("outline.apply.wasDeferred")}` : ""}</p>
                          {row.authorWritten && <p className="flex items-start gap-1.5 text-xs"><PenLine className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("outline.apply.imported")}</p>}
                          <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-4">
                            {CHOICES.map((value) => (
                              <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-8">
                                <input type="radio" name={name} value={value} checked={choice === value} onChange={() => setChoices((current) => new Map(current).set(number, value))} className="h-4 w-4 accent-primary" />
                                {t(`outline.apply.choice.${value}`)}
                              </label>
                            ))}
                          </div>
                          {choice === "follow" && (
                            <div className="space-y-1">
                              <Label htmlFor={`${id}-instruction-${number}`} className="text-xs text-muted-foreground">{t("outline.apply.instruction")}</Label>
                              <Input id={`${id}-instruction-${number}`} value={instructions.get(number) ?? ""} maxLength={2000} onChange={(event) => setInstructions((current) => new Map(current).set(number, event.target.value))} className="h-9" />
                            </div>
                          )}
                        </fieldset>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ) : (
              <p className="text-sm text-muted-foreground">{t("outline.apply.nothingToDecide")}</p>
            )}

            {model.told.length > 0 && (
              <section aria-labelledby={`${id}-told`} className="space-y-1.5">
                <h3 id={`${id}-told`} className="text-sm font-semibold">{t("outline.apply.toldTitle")}</h3>
                <ul className="space-y-1 text-sm">
                  {model.told.map((row) => (
                    <li key={row.number} data-apply-told={row.number} className="flex items-start gap-1.5">
                      <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span><span className="font-medium">{t("outline.changes.chapter", { number: row.number })}{row.title ? ` — ${row.title}` : ""}</span>: {changeKindText(say, row)}. {t(row.held ? `outline.changes.held.${row.held}` : `outline.changes.outcome.${row.outcome}`)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {decide.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor={`${id}-note`}>{t("outline.apply.note")}</Label>
                <Textarea id={`${id}-note`} value={note} maxLength={2000} rows={2} onChange={(event) => setNote(event.target.value)} aria-describedby={`${id}-note-hint`} />
                <p id={`${id}-note-hint`} className="text-xs text-muted-foreground">{t("outline.apply.noteHint")}</p>
              </div>
            )}

            {state?.plan && numbers.length > 0 && (
              <Suspense fallback={<p className="text-sm text-muted-foreground">{t("outline.apply.reading")}</p>}>
                <ApplyEstimate book={book} branch={branch} structure={structure} state={state} numbers={numbers} />
              </Suspense>
            )}
          </>
        )}

        <DialogFooter className="gap-2">
          {confirming ? (
            <>
              <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={busy}><ArrowLeft className="h-4 w-4" aria-hidden="true" />{t("outline.apply.confirm.back")}</Button>
              <Button type="button" onClick={() => void apply()} disabled={busy || unsupported}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCcw className="h-4 w-4" aria-hidden="true" />}
                {t(start ? "outline.apply.confirm.rewriteStart" : "outline.apply.confirm.rewrite", { count: rewriting.length })}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
              <Button type="button" disabled={busy || unsupported || !model || decide.length === 0} onClick={() => (rewriting.length ? setConfirming(true) : void apply())}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : start ? <Play className="h-4 w-4" aria-hidden="true" /> : rewriting.length ? <Wand2 className="h-4 w-4" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                {applyLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

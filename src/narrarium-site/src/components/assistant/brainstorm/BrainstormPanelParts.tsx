import { useEffect, useState } from "react";
import { ArrowLeft, Check, FileText, Loader2, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { OUTLINE_BRAINSTORM_FILE, groupOutlineChanges, type AutopilotState } from "narrarium-engine";
import "@/i18n/brainstorm";
import "@/i18n/outline";
import type { AssistantAction } from "@/assistant/store";
import { formatCount } from "@/autopilot/format";
import { BrainstormMark } from "@/components/assistant/brainstorm/BrainstormMark";
import { PageChangesTable } from "@/components/assistant/PageChangesReview";
import { FileDiff } from "@/components/diff/DiffView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { isToldOutcome } from "@/outline/outlineModel";
import { browserOutlineSource } from "@/outline/outlineSource";
import type { BookEntry } from "@/types/settings";

/**
 * Brainstorming's own parts of the Copilot panel: loaded the first time the panel is in that mode, which only the Synopsis page opens, so the panel
 * carries none of them.
 */

/** Who is speaking: Brainstorming's mark and name, on what. */
export function BrainstormIdentity({ book }: { book: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"><BrainstormMark className="h-4 w-4" /></div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold leading-tight">{t("brainstorm.name")}</p>
        <p className="truncate text-xs leading-tight text-muted-foreground">{book ? t("brainstorm.context", { book }) : t("brainstorm.tagline")}</p>
      </div>
    </div>
  );
}

/** The way back to the Copilot, always in the header: the Copilot's chat comes back as it was. */
export function BrainstormBack({ onBack, disabled }: { onBack: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <Button type="button" variant="outline" size="sm" className="h-8 gap-1 px-2" aria-label={t("brainstorm.back")} title={t("brainstorm.back")} onClick={onBack} disabled={disabled} data-brainstorm-back="">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      <span className="sm:hidden">{t("assistant.floatingButton")}</span>
      <span className="hidden sm:inline">{t("brainstorm.back")}</span>
    </Button>
  );
}

/** The starting points: to start a book from its premise, and to change one that has a Synopsis. Each fills in the request, which the author then sends. */
export const BRAINSTORM_STARTERS = {
  start: ["premise", "heart", "shapes", "arcs"],
  change: ["whatIf", "restructure", "subplot", "reorder", "middle", "check", "room"],
} as const;

/** What an empty chat of Brainstorming says it can do, with the starting points. */
export function BrainstormEmpty({ onPick }: { onPick: (prompt: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 rounded-2xl border border-dashed border-primary/60 p-4 text-sm">
      <p className="text-muted-foreground">{t("brainstorm.empty")}</p>
      <section aria-label={t("brainstorm.starters.label")} className="space-y-3" data-brainstorm-starters="">
        <p className="text-xs text-muted-foreground">{t("brainstorm.starters.hint")}</p>
        {(Object.keys(BRAINSTORM_STARTERS) as Array<keyof typeof BRAINSTORM_STARTERS>).map((group) => (
          <div key={group} className="space-y-1.5">
            <h3 className="text-xs font-semibold text-foreground">{t(`brainstorm.starters.${group}.title`)}</h3>
            <ul className="flex flex-wrap gap-2">
              {BRAINSTORM_STARTERS[group].map((item) => (
                <li key={item}>
                  <button
                    type="button"
                    data-brainstorm-starter={`${group}.${item}`}
                    className="min-h-9 rounded-full border border-primary bg-background px-3 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    onClick={() => onPick(t(`brainstorm.starters.${group}.${item}.prompt`))}
                  >
                    {t(`brainstorm.starters.${group}.${item}.label`)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

/** A proposal before it is applied (`apply-file-updates`) and once it is (`undo-file-updates`, which undoes it). */
type FileUpdates = Extract<AssistantAction, { kind: "apply-file-updates" | "undo-file-updates" }>;

const CHAPTER_FILE = /^outline\/chapters\/(\d+)\.md$/;

/**
 * A proposal of Brainstorming: what the autopilot will do about each chapter it touches (the engine's rule, `groupOutlineChanges`, said with the words
 * the Synopsis page says it with) and the difference of every file, shown before anything is applied; applying asks once more. The notes of a brainstorm
 * are saved with one press: they are not entries, and the autopilot does not follow them.
 */
export function BrainstormProposal({ action, book, branch, busy, enabled, onApply, onUndo, onIncludeOptional }: {
  action: FileUpdates;
  book: BookEntry | undefined;
  branch: string;
  busy: boolean;
  enabled: boolean;
  onApply: () => void;
  onUndo: () => void;
  /** Adds the author's own entries the proposal kept aside (`review.optional`) to what Apply writes. */
  onIncludeOptional?: () => void;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<{ files: Map<string, string>; state: AutopilotState | null } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const notes = action.updates.every((update) => update.path === OUTLINE_BRAINSTORM_FILE);
  const where = action.branch || branch;
  const paths = action.updates.map((update) => update.path).join("\n");

  useEffect(() => {
    if (!book) return;
    let active = true;
    const source = browserOutlineSource(book, where);
    void Promise.all([source.files(), source.readState().catch(() => null)])
      .then(([files, state]) => { if (active) setCurrent({ files: new Map(files.map((file) => [file.path, file.content])), state }); })
      .catch(() => { if (active) setCurrent({ files: new Map(), state: null }); });
    return () => { active = false; };
  }, [book, where, paths]);

  const applied = action.updates.some((update) => update.status === "applied");
  const pending = action.updates.some((update) => update.status !== "applied");
  const changes = action.updates.flatMap((update) => {
    const number = CHAPTER_FILE.exec(update.path)?.[1];
    return number ? [{ number: Number(number), entry: update.content === null ? ("removed" as const) : ("changed" as const) }] : [];
  });
  const remaining = new Set([...(current?.files.keys() ?? [])].filter((path) => CHAPTER_FILE.test(path)));
  for (const update of action.updates) if (CHAPTER_FILE.test(update.path)) (update.content === null ? remaining.delete(update.path) : remaining.add(update.path));
  const groups = current ? groupOutlineChanges(current.state, changes, { outlineEmpty: remaining.size === 0 }).filter((group) => group.outcome !== "none") : [];
  const consequences = groups.map((group) => {
    const options = { count: group.numbers.length, numbers: group.numbers.map(formatCount) };
    return { outcome: group.outcome, text: isToldOutcome(group.outcome) ? t(`outline.written.${group.outcome}`, options) : t(`brainstorm.proposal.outcome.${group.outcome}`, options) };
  });
  const consequenceList = !current
    ? <p className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{t("brainstorm.proposal.reading")}</p>
    : consequences.length
      ? <ul className="list-disc space-y-1 pl-4">{consequences.map((line) => <li key={line.outcome} data-outcome={line.outcome}>{line.text}</li>)}</ul>
      : <p className="text-muted-foreground">{t("brainstorm.proposal.noneTouched")}</p>;

  return (
    <section className="mt-2 space-y-3 rounded-xl border border-primary/60 bg-muted/30 p-3 text-xs" aria-label={notes ? t("brainstorm.proposal.notesTitle") : t("brainstorm.proposal.title")} data-brainstorm-proposal={notes ? "notes" : "synopsis"}>
      <p className="flex items-center gap-1.5 font-medium text-foreground"><FileText className="h-3.5 w-3.5" aria-hidden="true" />{notes ? t("brainstorm.proposal.notesTitle") : t("brainstorm.proposal.title")}<span className="font-normal text-muted-foreground">· {t("brainstorm.proposal.files", { count: action.updates.length })}</span></p>
      {/* A proposal of many chapters (a pasted synopsis) has its table: every chapter, whether it is new, updated or the author's and left as it is. */}
      {action.review && <PageChangesTable page={action.review.page} rows={action.review.rows} />}
      {notes ? <p className="text-muted-foreground">{t("brainstorm.proposal.notesHint")}</p> : (
        <div className="space-y-1" data-brainstorm-consequences="">
          <p className="font-medium text-foreground">{t("brainstorm.proposal.consequences")}</p>
          {consequenceList}
        </div>
      )}
      <div className="space-y-2">
        {action.updates.map((update) => (
          <details key={update.path} className="rounded border bg-background p-2" open={action.updates.length <= 3}>
            <summary className="cursor-pointer break-all"><span className="font-mono">{update.path}</span> · {update.reason ?? ""} · {t(`brainstorm.proposal.status.${update.status ?? "pending"}`)}</summary>
            {update.content === null && <p className="mt-2 text-muted-foreground">{t("outline.copilot.deletes")}</p>}
            {current ? <FileDiff previous={update.previousContent ?? current.files.get(update.path) ?? ""} next={update.content ?? ""} className="mt-2 max-h-64" /> : null}
            {update.error && <p className="mt-2 break-words text-destructive">{update.error}</p>}
          </details>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {pending && (
          <Button size="sm" onClick={() => (notes ? onApply() : setConfirming(true))} disabled={busy || !enabled} data-brainstorm-apply="">
            <Check className="h-4 w-4" aria-hidden="true" />{notes ? t("brainstorm.proposal.saveNotes") : t("brainstorm.proposal.apply")}
          </Button>
        )}
        {pending && !applied && onIncludeOptional && (action.review?.optional?.rows.length ?? 0) > 0 && (
          <Button size="sm" variant="outline" onClick={onIncludeOptional} disabled={busy || !enabled}>{t("pageCopilot.review.includeOptional", { count: action.review!.optional!.rows.length })}</Button>
        )}
        {applied && <Badge variant="secondary">{t("brainstorm.proposal.applied")}</Badge>}
        {applied && <Button size="sm" variant="outline" onClick={onUndo} disabled={busy}><Undo2 className="h-4 w-4" aria-hidden="true" />{t("brainstorm.proposal.undo")}</Button>}
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="brainstorm-accent">
          <DialogTitle>{t("brainstorm.proposal.confirmTitle")}</DialogTitle>
          <DialogDescription>{t("brainstorm.proposal.confirmBody")}</DialogDescription>
          <div className="space-y-1 text-sm">
            <p className="font-medium">{t("brainstorm.proposal.consequences")}</p>
            {consequenceList}
          </div>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setConfirming(false)}>{t("brainstorm.proposal.cancel")}</Button>
            <Button onClick={() => { setConfirming(false); onApply(); }} disabled={busy || !enabled} data-brainstorm-confirm="">{t("brainstorm.proposal.confirm")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

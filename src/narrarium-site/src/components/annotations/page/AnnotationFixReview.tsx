import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import "@/i18n/annotationsPage";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { computeDiffChangeChunks, mergeDiffChangeChunks, type DiffChangeChoice } from "@/components/diff/DiffView";
import { wordDiff } from "@/annotations/wordDiff";
import { cn } from "@/lib/utils";

/**
 * The proposal of a fix, shown to the author before anything is written: the text as it would be with the changes marked word by word (what goes is struck
 * through and what comes is underlined, and each is named for a screen reader: colour is never the only sign), then each change of the blocks apart with Keep
 * and Skip, and the proposal itself to edit. What the author decided is the text `onFinal` gives: the proposal with the skipped changes put back as they were.
 */
export function AnnotationFixReview({ original, proposal, onProposal, onFinal, disabled }: {
  original: string;
  proposal: string;
  /** The author edited the proposal. */
  onProposal: (next: string) => void;
  /** The text to write: the proposal with the skipped changes put back. */
  onFinal: (text: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const base = useId();
  const [editing, setEditing] = useState(false);
  const chunks = useMemo(() => computeDiffChangeChunks(original, proposal), [original, proposal]);
  const [choices, setChoices] = useState<Record<string, DiffChangeChoice>>({});
  // A new proposal (or an edit of it) starts again from every change kept.
  useEffect(() => { setChoices({}); }, [proposal, original]);
  const choice = (id: string): DiffChangeChoice => (choices[id] === "original" ? "original" : "proposed");
  const final = useMemo(() => mergeDiffChangeChunks(original, chunks, Object.fromEntries(chunks.map((chunk) => [chunk.id, choice(chunk.id)])), "proposed"), [chunks, choices, original]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onFinal(final); }, [final, onFinal]);
  const parts = useMemo(() => wordDiff(original, final), [original, final]);
  const skipped = chunks.filter((chunk) => choice(chunk.id) === "original").length;
  const unchanged = final === original;

  return (
    <section aria-labelledby={`${base}-title`} className="space-y-3" data-annotation-fix-review="">
      <div className="space-y-1">
        <h3 id={`${base}-title`} className="text-sm font-semibold">{t("annotationsPage.fix.reviewTitle")}</h3>
        <p className="text-xs text-muted-foreground">{unchanged ? t("annotationsPage.fix.nothingChanges") : t("annotationsPage.fix.reviewHint", { count: chunks.length - skipped })}</p>
      </div>

      <p className="whitespace-pre-wrap break-words rounded-lg border bg-background p-3 font-serif text-sm leading-6" data-fix-text="">
        {parts.map((part, index) => part.type === "same"
          ? <span key={index}>{part.text}</span>
          : part.type === "remove"
            ? <del key={index} className="rounded-sm bg-red-500/10 line-through text-red-800 decoration-red-700 dark:text-red-300"><span className="sr-only">{t("annotationsPage.fix.removed")} </span>{part.text}</del>
            : <ins key={index} className="rounded-sm bg-emerald-500/10 text-emerald-800 underline decoration-emerald-700 dark:text-emerald-300"><span className="sr-only">{t("annotationsPage.fix.added")} </span>{part.text}</ins>)}
      </p>

      {chunks.length > 0 && (
        <ol className="space-y-2" aria-label={t("annotationsPage.fix.changes")}>
          {chunks.map((chunk, index) => {
            const kept = choice(chunk.id) === "proposed";
            return (
              <li key={chunk.id} className="rounded-lg border p-3 text-sm" data-fix-chunk={kept ? "kept" : "skipped"}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">{t("annotationsPage.fix.changeOf", { number: index + 1, total: chunks.length })}</span>
                  <div className="ml-auto flex gap-1" role="group" aria-label={t("annotationsPage.fix.decide", { number: index + 1 })}>
                    <Button type="button" size="sm" variant={kept ? "default" : "outline"} aria-pressed={kept} disabled={disabled} onClick={() => setChoices((current) => ({ ...current, [chunk.id]: "proposed" }))} className="[@media(pointer:coarse)]:h-11">{t("annotationsPage.fix.keep")}</Button>
                    <Button type="button" size="sm" variant={!kept ? "default" : "outline"} aria-pressed={!kept} disabled={disabled} onClick={() => setChoices((current) => ({ ...current, [chunk.id]: "original" }))} className="[@media(pointer:coarse)]:h-11">{t("annotationsPage.fix.skip")}</Button>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div><p className="mb-1 text-xs font-medium text-muted-foreground">{t("annotationsPage.fix.before")}</p><pre className="whitespace-pre-wrap break-words rounded bg-red-500/10 p-2 font-serif text-red-900 dark:text-red-200">{chunk.oldText || t("annotationsPage.fix.noText")}</pre></div>
                  <div><p className="mb-1 text-xs font-medium text-muted-foreground">{t("annotationsPage.fix.after")}</p><pre className={cn("whitespace-pre-wrap break-words rounded bg-emerald-500/10 p-2 font-serif text-emerald-900 dark:text-emerald-200", !kept && "opacity-60 line-through")}>{chunk.newText || t("annotationsPage.fix.noText")}</pre></div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="space-y-2">
        <Button type="button" size="sm" variant="ghost" aria-expanded={editing} aria-controls={`${base}-edit`} onClick={() => setEditing((value) => !value)} className="[@media(pointer:coarse)]:h-11">
          <Pencil aria-hidden="true" />{editing ? t("annotationsPage.fix.editClose") : t("annotationsPage.fix.edit")}
        </Button>
        {editing && (
          <div id={`${base}-edit`} className="grid gap-1.5">
            <Label htmlFor={`${base}-proposal`}>{t("annotationsPage.fix.editLabel")}</Label>
            <Textarea id={`${base}-proposal`} value={proposal} rows={Math.min(14, Math.max(4, proposal.split("\n").length + 2))} disabled={disabled} onChange={(event) => onProposal(event.target.value)} className="font-serif" />
            <p className="text-xs text-muted-foreground">{t("annotationsPage.fix.editHint")}</p>
          </div>
        )}
      </div>
    </section>
  );
}

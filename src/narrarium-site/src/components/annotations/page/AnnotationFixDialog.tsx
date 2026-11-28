import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, Loader2, RotateCcw, Sparkles } from "lucide-react";
import "@/i18n/annotationsPage";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TagLabel } from "@/components/annotations/TagLabel";
import { AnnotationFixReview } from "@/components/annotations/page/AnnotationFixReview";
import { useAnnotationFix, type FixProblem } from "@/components/annotations/page/useAnnotationFix";
import { FIX_INSTRUCTION_MAX } from "@/annotations/fix";
import { resolveTag, type Annotation, type ResolvedTag } from "@/annotations/model";

export interface FixRequest {
  annotation: Annotation;
  /** What the author already said for this fix (what a conversation came to): the first try uses it. */
  instruction?: string;
}

/** Where to read the scene by hand when the passage is not in the text. */
function sceneLink(bookId: string, annotation: Annotation, sceneNumber: string | undefined): string | undefined {
  return sceneNumber ? `/app/books/${bookId}/chapters/${annotation.chapter}/paragraphs/${sceneNumber}` : undefined;
}

/**
 * «Fix with the AI» for one annotation: the model proposes a change of the blocks that hold the passage, the author reviews it (keep or skip each change,
 * edit the proposal), applies it in ONE write and can undo it. A try with an instruction of the author's asks again. It writes only on Apply; the annotation
 * is closed as handled by the AI when the scene is written. The same dialog is used by the page of the notes and by the triage.
 */
export function AnnotationFixDialog({ bookId, request, catalog, sceneNumber, onClose, onApplied }: {
  bookId: string;
  request: FixRequest | null;
  catalog: readonly ResolvedTag[];
  /** The number of the scene file of the annotation, to offer it when the passage cannot be found. */
  sceneNumber?: string;
  onClose: () => void;
  /** The scene was written and the annotation closed. */
  onApplied?: (annotation: Annotation) => void;
}) {
  const { t } = useTranslation();
  const base = useId();
  const fix = useAnnotationFix(bookId);
  const [instruction, setInstruction] = useState("");
  const [final, setFinal] = useState("");
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const annotation = request?.annotation ?? null;
  const { state } = fix;

  // A new request starts from nothing and asks at once: the author pressed «Fix with the AI».
  useEffect(() => {
    fix.reset();
    setFinal("");
    setInstruction(request?.instruction ?? "");
    if (request) void fix.ask(request.annotation, request.instruction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const onFinal = useCallback((text: string) => setFinal(text), []);
  const busy = state.phase === "preparing" || state.phase === "asking" || state.phase === "applying";

  const problemText = (problem: FixProblem): string => t(`annotationsPage.fix.problem.${problem}`);

  const close = () => {
    if (state.phase === "applying") return;
    fix.reset();
    onClose();
  };

  const apply = async () => {
    if (!annotation) return;
    const done = await fix.apply(annotation, final);
    if (done) {
      onApplied?.(annotation);
      statusRef.current?.focus();
    }
  };

  const tag = annotation ? resolveTag(catalog, annotation.tag, t("annotations.tag.missing")) : null;
  const link = annotation ? sceneLink(bookId, annotation, sceneNumber) : undefined;
  const original = state.target?.original ?? "";

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl" data-annotation-fix="">
        <DialogHeader>
          <DialogTitle>{t("annotationsPage.fix.title")}</DialogTitle>
          <DialogDescription>{t("annotationsPage.fix.description")}</DialogDescription>
        </DialogHeader>
        {annotation && tag && (
          <figure className="space-y-1 rounded-md border-l-4 border-primary/50 bg-muted/40 px-3 py-2">
            <figcaption><TagLabel tag={tag} showScope /></figcaption>
            <blockquote className="line-clamp-3 font-serif text-sm">{annotation.quote}</blockquote>
            {annotation.comment && <p className="whitespace-pre-wrap break-words text-sm">{annotation.comment}</p>}
          </figure>
        )}

        <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground focus:outline-none">
          {state.phase === "preparing" && <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("annotationsPage.fix.preparing")}</span>}
          {state.phase === "asking" && <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("annotationsPage.fix.asking")}</span>}
          {state.phase === "applying" && <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("annotationsPage.fix.applying")}</span>}
          {state.phase === "applied" && !state.problem && <span className="inline-flex items-center gap-2 text-emerald-800 dark:text-emerald-300"><Check className="h-4 w-4" aria-hidden="true" />{t("annotationsPage.fix.applied")}</span>}
        </p>
        {state.frozen && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-fix-frozen="">{t("annotationsPage.fix.frozen")}</p>
        )}
        {state.problem && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {problemText(state.problem)}{state.detail ? ` ${state.detail}` : ""}
            {state.problem === "orphaned" && link && <> <Link to={link} className="font-medium underline">{t("annotationsPage.openParagraph")}</Link></>}
          </p>
        )}

        {state.proposal !== undefined && (state.phase === "proposed" || state.phase === "applying") && (
          <AnnotationFixReview original={original} proposal={state.proposal} onProposal={fix.setProposal} onFinal={onFinal} disabled={busy} />
        )}

        {state.phase !== "applied" && (
          <div className="grid gap-1.5">
            <Label htmlFor={`${base}-instruction`}>{t("annotationsPage.fix.instruction")}</Label>
            <Textarea id={`${base}-instruction`} value={instruction} rows={2} maxLength={FIX_INSTRUCTION_MAX} disabled={busy} placeholder={t("annotationsPage.fix.instructionPlaceholder")} onChange={(event) => setInstruction(event.target.value)} />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {state.phase === "applied" ? (
            <>
              <Button type="button" variant="outline" onClick={() => void fix.undo()} className="[@media(pointer:coarse)]:h-11"><RotateCcw aria-hidden="true" />{t("annotationsPage.fix.undo")}</Button>
              <Button type="button" onClick={close} className="[@media(pointer:coarse)]:h-11">{t("annotationsPage.fix.close")}</Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={close} disabled={state.phase === "applying"} className="[@media(pointer:coarse)]:h-11">{t("annotationsPage.fix.cancel")}</Button>
              <Button type="button" variant="outline" disabled={busy || !annotation} onClick={() => annotation && void fix.ask(annotation, instruction)} className="[@media(pointer:coarse)]:h-11">
                <Sparkles aria-hidden="true" />{state.proposal !== undefined ? t("annotationsPage.fix.retry") : t("annotationsPage.fix.ask")}
              </Button>
              <Button type="button" disabled={busy || state.phase !== "proposed" || final === original || !final.trim()} onClick={() => void apply()} className="[@media(pointer:coarse)]:h-11">{t("annotationsPage.fix.apply")}</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

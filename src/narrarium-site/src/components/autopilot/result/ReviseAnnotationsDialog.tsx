import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Wand2 } from "lucide-react";
import { chapterFilePath, type ReviseAnnotationsInput } from "narrarium-engine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EstimateLine } from "@/components/autopilot/review/ReviewFields";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { useAutopilotStore } from "@/autopilot/store";
import { useAutopilotRefresh, useBookAutopilotView } from "@/autopilot/hooks";
import { useBookFiles } from "@/autopilot/useBookFiles";
import { useRunEstimateSources } from "@/autopilot/useRunEstimate";
import { estimateReview } from "@/autopilot/runEstimate";
import { serverHasAnnotations } from "@/autopilot/campaign";
import { chapterFreezes } from "@/outline/outlineModel";
import { liveAccountTags, storedAccountTags } from "@/annotations/accountTags";
import { annotationStatus, type Annotation } from "@/annotations/model";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

export interface ReviseAnnotationsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called once the campaign is recorded and the autopilot started. */
  onStarted?: () => void;
  book: BookEntry;
  branch: string;
  structure: BookStructure | undefined;
  /** The notes the author chose (the open ones are worked; a note put off, handled or dismissed is not). */
  notes: readonly Annotation[];
}

const NOTE_MAX = 2000;

/**
 * «Have the autopilot answer these notes»: the open notes (not the ones that ask to keep a passage), the chapters they are in and what the autopilot will do (rewrite each
 * chapter scene by scene as its notes ask, review it again, close the notes as handled by the autopilot), what it costs, and the chapters of the author's that are held back
 * unless the author includes them. Confirmed, the campaign is recorded (`reviseAnnotations`) and the autopilot started. A personal server that predates it is not asked.
 */
export default function ReviseAnnotationsDialog({ open, onClose, onStarted, book, branch, structure, notes }: ReviseAnnotationsDialogProps) {
  const { t, i18n } = useTranslation();
  const id = useId();
  useAutopilotRefresh(book.id, open);
  const view = useBookAutopilotView(book.id);
  const state = view.snapshot?.state ?? null;
  const serverInfo = useAutopilotStore((store) => store.server.info);
  const unsupported = book.autopilotHost === "server" && serverInfo !== null && !serverHasAnnotations(serverInfo);
  const ready = Boolean(state?.plan?.approved);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Wand2 className="h-5 w-5 text-primary" aria-hidden="true" />{t("autopilot.annotations.title")}</DialogTitle>
          <DialogDescription>{t("autopilot.annotations.intro")}</DialogDescription>
        </DialogHeader>
        {unsupported && <Alert variant="destructive"><AlertDescription>{t("autopilot.annotations.oldServer")}</AlertDescription></Alert>}
        {!ready || !state
          ? <p data-annotations-no-plan="" className="text-sm text-muted-foreground">{t("autopilot.annotations.noPlan")}</p>
          : <Body id={id} onClose={onClose} onStarted={onStarted} book={book} branch={branch} structure={structure} notes={notes} unsupported={unsupported} state={state} language={i18n.resolvedLanguage ?? i18n.language} />}
        {(!ready || !state) && <DialogFooter><Button type="button" variant="outline" onClick={onClose}>{t("autopilot.annotations.cancel")}</Button></DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

function Body({ id, onClose, onStarted, book, branch, structure, notes, unsupported, state, language }: Omit<ReviseAnnotationsDialogProps, "open"> & { id: string; unsupported: boolean; state: NonNullable<ReturnType<typeof useBookAutopilotView>["snapshot"]>["state"] & object; language: string }) {
  const { t } = useTranslation();
  const { run, busy } = useAutopilotActions(book.id);
  const settings = useSettingsStore((store) => store.settings);
  const view = useBookAutopilotView(book.id);
  const running = useAutopilotStore((store) => store.views[book.id]?.snapshot?.running === true || store.views[book.id]?.busyInAnotherTab === true);
  const [include, setInclude] = useState<ReadonlySet<number>>(new Set());
  const [words, setWords] = useState("");
  const plan = state.plan!.chapters;

  // The notes that are changes to make: open ones, and not the ones that ask to keep a passage.
  const work = useMemo(() => notes.filter((note) => annotationStatus(note.status) === "open" && note.tag !== "keep"), [notes]);
  const slugs = useMemo(() => [...new Set(work.map((note) => note.chapter))], [work]);
  const files = useBookFiles(book.id, slugs.map((slug) => chapterFilePath(slug)));
  const freezes = useMemo(() => chapterFreezes([...(files.files ?? new Map()).entries()].map(([path, content]) => ({ path, content }))), [files.files]);

  const rows = useMemo(() => {
    const byChapter = new Map<string, Annotation[]>();
    for (const note of work) byChapter.set(note.chapter, [...(byChapter.get(note.chapter) ?? []), note]);
    return [...byChapter.entries()].map(([slug, list]) => {
      const planned = plan.find((chapter) => chapter.slug === slug);
      const by = freezes.get(slug)?.by;
      const yours = by === "author" || Boolean(planned?.imported && by !== "autopilot");
      const kind: "work" | "yours" | "later" = !planned || planned.status !== "done" ? "later" : yours ? "yours" : "work";
      return { slug, number: planned?.number ?? 0, title: structure?.chapters.find((chapter) => chapter.slug === slug)?.title ?? slug, count: list.length, scenes: new Set(list.map((note) => note.paragraph)).size, kind };
    }).sort((left, right) => left.number - right.number);
  }, [work, plan, freezes, structure]);
  const worked = rows.filter((row) => row.kind === "work" || (row.kind === "yours" && include.has(row.number)));
  const noteCount = worked.reduce((sum, row) => sum + row.count, 0);
  const rewrites = worked.reduce((sum, row) => sum + row.scenes, 0);

  const inputs = useRunEstimateSources({ book, branch, structure, state, activities: view.snapshot?.activities });
  const estimate = useMemo(() => (worked.length ? estimateReview(inputs.sources, state, { chapters: worked.length, maxRounds: state.options.review?.maxRounds ?? 2, readerRounds: state.options.readers ? 1 : 0 }).estimate : null), [worked.length, inputs.sources, state]);

  const canSubmit = worked.length > 0 && !unsupported && busy === null && !running;
  const submit = async () => {
    if (!canSubmit) return;
    const input: ReviseAnnotationsInput = {
      ids: worked.flatMap((row) => work.filter((note) => note.chapter === row.slug).map((note) => note.id)),
      ...(include.size ? { include: [...include] } : {}),
      accountTags: liveAccountTags(storedAccountTags(settings.annotations)),
      language,
      ...(words.trim() ? { note: words.trim() } : {}),
    };
    const done = await run("answer", async (runtime, bookId) => {
      await runtime.reviseAnnotations(bookId, input);
      await runtime.start(bookId);
    });
    if (done) { onStarted?.(); onClose(); }
  };

  return (
    <>
      <section aria-labelledby={`${id}-chapters`} className="space-y-2">
        <h3 id={`${id}-chapters`} className="text-sm font-semibold" data-annotations-summary="">{t("autopilot.annotations.summary", { notes: t("autopilot.annotations.rowNotes", { count: noteCount }), chapters: t("autopilot.annotations.chaptersCount", { count: worked.length }) })}</h3>
        {rows.length === 0 && <p className="text-sm text-muted-foreground">{t("autopilot.annotations.none")}</p>}
        <ul className="space-y-1.5 text-sm">
          {rows.map((row) => (
            <li key={row.slug} data-annotations-chapter={row.slug} data-kind={row.kind} className="rounded-lg border p-2">
              {row.kind === "yours" ? (
                <label className="flex min-h-6 cursor-pointer items-start gap-2 [@media(pointer:coarse)]:min-h-11">
                  <input type="checkbox" checked={include.has(row.number)} onChange={(event) => setInclude((current) => { const next = new Set(current); if (event.target.checked) next.add(row.number); else next.delete(row.number); return next; })} className="mt-1 h-4 w-4 [@media(pointer:coarse)]:h-5 [@media(pointer:coarse)]:w-5" />
                  <span><span className="font-medium">{row.title}</span> · {t("autopilot.annotations.rowNotes", { count: row.count })}<span className="block text-xs text-muted-foreground">{t("autopilot.annotations.yours")}</span></span>
                </label>
              ) : (
                <p><span className="font-medium">{row.title}</span> · {t("autopilot.annotations.rowNotes", { count: row.count })}{row.kind === "later" && <span className="block text-xs text-muted-foreground">{t("autopilot.annotations.notYet")}</span>}</p>
              )}
            </li>
          ))}
        </ul>
      </section>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-words`}>{t("autopilot.annotations.words")}</Label>
        <Textarea id={`${id}-words`} value={words} maxLength={NOTE_MAX} onChange={(event) => setWords(event.target.value)} placeholder={t("autopilot.annotations.wordsPlaceholder")} rows={2} />
      </div>
      {estimate && (
        <EstimateLine
          label={t("autopilot.annotations.estimate", { count: worked.length })}
          estimate={estimate}
          currency={inputs.sources.currency || "USD"}
          extra={<p className="text-muted-foreground">{t("autopilot.annotations.estimateRewrites", { count: rewrites })}</p>}
        />
      )}
      <p className="text-xs text-muted-foreground">{t("autopilot.annotations.stops")}</p>
      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy !== null}>{t("autopilot.annotations.cancel")}</Button>
        <Button type="button" onClick={() => void submit()} disabled={!canSubmit} aria-describedby={running ? `${id}-running` : undefined} data-annotations-submit="">
          {busy !== null ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Wand2 className="h-4 w-4" aria-hidden="true" />}
          {t("autopilot.annotations.submit", { count: noteCount })}
        </Button>
      </DialogFooter>
      {running && <p id={`${id}-running`} className="text-xs text-muted-foreground">{t("autopilot.annotations.running")}</p>}
    </>
  );
}

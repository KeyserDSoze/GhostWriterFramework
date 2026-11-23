import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertOctagon, AlertTriangle, BookOpen, CheckCircle2, Clapperboard, Info, Loader2, PlusCircle, Users, X, XCircle } from "lucide-react";
import { directorOpinionPath, parseDirectorOpinionRecord, type AutopilotState, type ChapterRound, type PlannedChapter, type ReviewDecision, type ReviewFinding } from "narrarium-engine";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DirectorVerdictBadge } from "@/components/director/DirectorOpinionView";
import { SCENE_ICON, SCENE_STYLE } from "@/components/autopilot/map/mapVisuals";
import { chapterStateText, type MapRowModel } from "@/components/autopilot/map/MapGrid";
import { formatCount } from "@/autopilot/format";
import { useBookFiles } from "@/autopilot/useBookFiles";
import { cn } from "@/lib/utils";

/** A part of the panel, named by its title. */
function Part({ title, children, icon }: { title: string; children: ReactNode; icon?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</h3>
      {children}
    </section>
  );
}

const vote = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * How the votes went from round to round: a bar for the director's vote of each round, and a lighter one for the readers' average where they read (the
 * first round). A picture, so one image to a screen reader with what it shows said in words: the table beside it has every figure. The height of a bar
 * is the vote, out of ten, and the figure is written over it: nothing is told by colour.
 */
function RoundsTrend({ rounds }: { rounds: readonly ChapterRound[] }) {
  const { t } = useTranslation();
  const votes = rounds.map((round) => vote(round.director));
  const readers = rounds.map((round) => vote(round.readers)).find((value) => value !== null) ?? null;
  const said = votes.filter((value): value is number => value !== null).map(formatCount).join(" → ");
  if (!said) return null;
  const label = [t("autopilot.chapterPanel.rounds.chart", { votes: said }), readers !== null ? t("autopilot.chapterPanel.rounds.chartReaders", { score: formatCount(readers) }) : null].filter(Boolean).join(" ");
  return (
    <div role="img" aria-label={label} className="mx-auto flex h-28 max-w-md items-end gap-4 border-b border-border px-1">
      {rounds.map((round, index) => {
        const director = votes[index];
        const read = vote(round.readers);
        return (
          <div key={index} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <div className="flex h-full w-full items-end justify-center gap-1">
              {director !== null && (
                <div className="flex h-full w-8 flex-col items-center justify-end">
                  <span className="text-xs font-semibold tabular-nums">{formatCount(director)}</span>
                  <div className="w-full rounded-t-sm bg-primary" style={{ height: `${Math.max(4, director * 8)}%` }} />
                </div>
              )}
              {read !== null && (
                <div className="flex h-full w-6 flex-col items-center justify-end">
                  <span className="text-xs tabular-nums text-muted-foreground">{formatCount(read)}</span>
                  <div className="w-full rounded-t-sm border border-primary bg-primary/20" style={{ height: `${Math.max(4, read * 8)}%` }} />
                </div>
              )}
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The rounds of review the plan recorded for the chapter, as a table, after the picture of their votes. */
function Rounds({ rounds }: { rounds: readonly ChapterRound[] }) {
  const { t } = useTranslation();
  const id = useId();
  if (!rounds.length) return <p className="text-sm text-muted-foreground">{t("autopilot.chapterPanel.rounds.none")}</p>;
  const dash = <span aria-hidden="true">—</span>;
  return (
    <div className="space-y-3">
      <RoundsTrend rounds={rounds} />
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-hidden="true">
        <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-primary" />{t("autopilot.chapterPanel.rounds.director")}</span>
        <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm border border-primary bg-primary/20" />{t("autopilot.chapterPanel.rounds.readers")}</span>
      </div>
      <div className="overflow-x-auto">
        <table aria-labelledby={id} className="w-full border-collapse text-sm">
          <caption id={id} className="sr-only">{t("autopilot.chapterPanel.rounds.title")}</caption>
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="px-2 py-1 text-left font-medium">{t("autopilot.chapterPanel.rounds.round")}</th>
              <th scope="col" className="px-2 py-1 text-right font-medium">{t("autopilot.chapterPanel.rounds.director")}</th>
              <th scope="col" className="px-2 py-1 text-right font-medium">{t("autopilot.chapterPanel.rounds.readers")}</th>
              <th scope="col" className="px-2 py-1 text-left font-medium">{t("autopilot.chapterPanel.rounds.verdict")}</th>
              <th scope="col" className="px-2 py-1 text-left font-medium">{t("autopilot.chapterPanel.rounds.fixes")}</th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((round, index) => (
              <tr key={index} className="border-b last:border-b-0">
                <th scope="row" className="px-2 py-1 text-left font-normal tabular-nums">{index + 1}</th>
                <td className="px-2 py-1 text-right tabular-nums">{vote(round.director) !== null ? formatCount(round.director!) : <>{dash}<span className="sr-only">{t("autopilot.map.table.none")}</span></>}</td>
                <td className="px-2 py-1 text-right tabular-nums">{vote(round.readers) !== null ? formatCount(round.readers!) : <>{dash}<span className="sr-only">{t("autopilot.map.table.none")}</span></>}</td>
                <td className="px-2 py-1">{round.verdict ? t(`autopilot.chapterPanel.rounds.${round.verdict}`) : dash}</td>
                <td className="px-2 py-1">{round.accepted !== undefined || round.rejected !== undefined ? t("autopilot.chapterPanel.rounds.fixesValue", { accepted: round.accepted ?? 0, rejected: round.rejected ?? 0 }) : dash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const SEVERITY_ICON = { critical: AlertOctagon, major: AlertTriangle, minor: Info } as const;
const SEVERITY_STYLE = {
  critical: "bg-red-500/15 text-red-800 dark:text-red-300",
  major: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  minor: "bg-muted text-foreground",
} as const;

function Severity({ severity }: { severity: ReviewFinding["severity"] }) {
  const { t } = useTranslation();
  const Icon = SEVERITY_ICON[severity];
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold", SEVERITY_STYLE[severity])}><Icon className="h-3.5 w-3.5" aria-hidden="true" />{t(`director.opinion.severity.${severity}`)}</span>;
}

/** A list under a title of its own, which names it. */
function TitledList({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <h4 id={id} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <ul aria-labelledby={id} className="space-y-2">{children}</ul>
    </div>
  );
}

/** The round of review in progress: the readers' cards, the findings with their gravity and scene, the director's decisions and verdict. */
function CurrentRound({ review: saved }: { review: NonNullable<AutopilotState["review"]> }) {
  const { t } = useTranslation();
  // A state written by an older engine, or cut short, may lack a list: it is read as empty.
  const review = { ...saved, readersPending: saved.readersPending ?? [], readerScores: saved.readerScores ?? [], findings: saved.findings ?? [], decisions: saved.decisions ?? [] };
  const byId = new Map(review.findings.map((finding) => [finding.id, finding]));
  const decision = (entry: ReviewDecision) => {
    const finding = byId.get(entry.findingId);
    const kind = !finding ? "added" : entry.action === "accept" ? "accepted" : "rejected";
    const Icon = kind === "rejected" ? XCircle : kind === "added" ? PlusCircle : CheckCircle2;
    return (
      <li key={entry.findingId} className="space-y-0.5 rounded-lg border border-layer p-2 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 font-semibold"><Icon className="h-4 w-4" aria-hidden="true" />{t(`autopilot.chapterPanel.current.${kind}`)}</span>
          {entry.sceneNumber ? <span className="text-xs text-muted-foreground">{t("autopilot.chapterPanel.current.scene", { number: entry.sceneNumber })}</span> : null}
        </p>
        {finding && <p className="text-muted-foreground">{finding.problem}</p>}
        {entry.rationale && <p>{entry.rationale}</p>}
        {entry.action === "accept" && entry.remediation && <p><span className="font-medium">{t("autopilot.chapterPanel.current.fix")}: </span>{entry.remediation}</p>}
      </li>
    );
  };
  return (
    <Part title={t("autopilot.chapterPanel.current.title")}>
      <p className="text-sm font-medium">{t("autopilot.chapterPanel.current.round", { round: review.round })}</p>
      {review.directorDone && review.verdict && typeof review.score === "number" && (
        <p className="text-sm">{t("autopilot.chapterPanel.current.verdict", { verdict: t(`autopilot.chapterPanel.rounds.${review.verdict}`), score: formatCount(review.score) })}{review.summary ? ` — ${review.summary}` : ""}</p>
      )}
      {(review.readersPending.length > 0 || !review.specialistsDone) && <p className="text-xs text-muted-foreground">{t("autopilot.chapterPanel.current.waiting")}</p>}
      {review.readerScores.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("autopilot.chapterPanel.current.readers")}</h4>
          <div className="grid gap-2 sm:grid-cols-2">
            {review.readerScores.map((reader) => <ReaderScore key={reader.slug} reader={reader} />)}
          </div>
        </div>
      )}
      {review.findings.length ? (
        <TitledList title={t("autopilot.chapterPanel.current.findings")}>
          {review.findings.map((finding) => (
            <li key={finding.id} className="space-y-1 rounded-lg border border-layer p-2 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <Severity severity={finding.severity} />
                {finding.sceneNumber ? <span className="text-xs font-medium">{t("autopilot.chapterPanel.current.scene", { number: finding.sceneNumber })}</span> : null}
                <span className="text-xs text-muted-foreground">{finding.reader ?? finding.category}</span>
              </p>
              <p>{finding.problem}</p>
              {finding.remediation && <p className="text-muted-foreground"><span className="font-medium text-foreground">{t("autopilot.chapterPanel.current.fix")}: </span>{finding.remediation}</p>}
              {finding.source === "specialist" && !finding.anchored && <p className="text-xs text-muted-foreground">{t("autopilot.chapterPanel.current.unanchored")}</p>}
            </li>
          ))}
        </TitledList>
      ) : review.specialistsDone ? <p className="text-sm text-muted-foreground">{t("autopilot.chapterPanel.current.noFindings")}</p> : null}
      {review.decisions.length > 0 && <TitledList title={t("autopilot.chapterPanel.current.decisions")}>{review.decisions.map(decision)}</TitledList>}
    </Part>
  );
}

function ReaderScore({ reader }: { reader: NonNullable<AutopilotState["review"]>["readerScores"][number] }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <article aria-labelledby={id} className="space-y-1 rounded-lg border border-layer p-2 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h5 id={id} className="font-semibold">{reader.name}</h5>
        <span className="text-xs font-medium tabular-nums">{formatCount(reader.score)}/10</span>
      </div>
      {reader.mainProblem && <p><span className="text-xs font-medium text-muted-foreground">{t("autopilot.chapterPanel.current.mainProblem")}: </span>{reader.mainProblem}</p>}
      {reader.prioritySuggestion && <p><span className="text-xs font-medium text-muted-foreground">{t("autopilot.chapterPanel.current.priority")}: </span>{reader.prioritySuggestion}</p>}
    </article>
  );
}

/** The director's last opinion on a closed chapter, read from the book when the author asks for it (one file). */
function LastOpinion({ bookId, slug }: { bookId: string; slug: string }) {
  const { t } = useTranslation();
  const [asked, setAsked] = useState(false);
  const path = directorOpinionPath({ kind: "chapter", chapter: slug });
  const paths = useMemo(() => (asked ? [path] : []), [asked, path]);
  const { files, failed } = useBookFiles(bookId, paths);
  const record = useMemo(() => {
    const content = files?.get(path);
    return content ? parseDirectorOpinionRecord(path, content) : null;
  }, [files, path]);
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (!record) return undefined;
    let current = true;
    void import("@/markdown/safeMarkdown").then(({ renderRepositoryMarkdownHtml }) => {
      if (current) setHtml(renderRepositoryMarkdownHtml(record.body));
    });
    return () => {
      current = false;
    };
  }, [record]);
  if (!asked) {
    return (
      <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" onClick={() => setAsked(true)}>
        <Clapperboard className="h-4 w-4" aria-hidden="true" />{t("autopilot.chapterPanel.opinion.show")}
      </Button>
    );
  }
  return (
    <div role="status" className="space-y-2">
      {files === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />{t("autopilot.chapterPanel.opinion.loading")}</p>
      ) : failed ? (
        <p className="text-sm text-muted-foreground">{t("autopilot.chapterPanel.opinion.failed")}</p>
      ) : !record ? (
        <p className="text-sm text-muted-foreground">{t("autopilot.chapterPanel.opinion.missing")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">{t("autopilot.chapterPanel.opinion.title")}<DirectorVerdictBadge verdict={record.verdict} score={record.score} /></div>
          {/* The opinion as the book keeps it, its title left out (the panel has one) and its headings the size of the panel's. */}
          {html !== null && <div className="doc-prose max-w-none rounded-lg border border-layer px-3 py-2 text-sm [&_h1]:hidden [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:border-0 [&_h2]:pb-0 [&_h2]:font-sans [&_h2]:text-sm [&_h2]:font-semibold [&_li:empty]:hidden" dangerouslySetInnerHTML={{ __html: html }} />}
        </>
      )}
    </div>
  );
}

export interface ChapterPanelProps {
  bookId: string;
  row: MapRowModel;
  state: AutopilotState;
  linked: boolean;
  ghostwriter: string | undefined;
  onClose: () => void;
}

/**
 * Everything about one chapter, beside the map: its state and marks, the link to its page, its rounds of review (a picture of the votes and a table),
 * the round in progress when it is in review (the readers' cards, the findings with their gravity and scene, the director's decisions), its scenes
 * with their state in words, and what the plan says of it. A dialog: Escape closes it, and the focus goes back to the cell that opened it.
 */
export function ChapterPanel({ bookId, row, state, linked, ghostwriter, onClose }: ChapterPanelProps) {
  const { t } = useTranslation();
  const { chapter } = row;
  const chapterHref = `/app/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapter.slug)}`;
  const rounds = chapter.rounds ?? [];
  const review = state.review?.chapterNumber === chapter.number ? state.review : null;
  const readersRead = rounds.some((round) => vote(round.readers) !== null) || Boolean(review?.readerScores?.length);
  const marks = [
    chapterStateText(t, row),
    row.frozen ? t("autopilot.map.frozen") : null,
    row.origin === "author" ? t("autopilot.map.outline") : null,
    ghostwriter ? t("autopilot.plan.ghostwriter", { name: ghostwriter }) : null,
    row.current ? t("autopilot.map.current") : null,
  ].filter(Boolean).join(" · ");
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent bare hideCloseButton className="inset-y-0 right-0 flex h-dvh w-full max-w-xl flex-col overflow-y-auto rounded-none border-y-0 border-r-0 sm:rounded-l-2xl">
        <div className="sticky top-0 z-10 space-y-2 border-b border-layer bg-background px-4 pb-3 pt-4 pr-16">
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="icon" className="absolute right-3 top-3 h-11 w-11 sm:h-10 sm:w-10" aria-label={t("common.close")}>
              <X className="h-5 w-5" aria-hidden="true" />
            </Button>
          </DialogClose>
          <DialogTitle className="font-serif text-xl font-semibold leading-snug">{chapter.title.trim() ? t("autopilot.chapterPanel.title", { number: chapter.number, title: chapter.title }) : t("autopilot.chapterPanel.untitled", { number: chapter.number })}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">{marks}</DialogDescription>
          <div className="flex flex-wrap gap-2">
            {linked && <Button asChild size="sm" variant="outline" className="min-h-11 sm:min-h-9"><Link to={chapterHref}><BookOpen className="h-4 w-4" aria-hidden="true" />{t("autopilot.chapterPanel.open")}</Link></Button>}
            {linked && readersRead && <Button asChild size="sm" variant="ghost" className="min-h-11 sm:min-h-9"><Link to={`${chapterHref}/reader-evaluations`}><Users className="h-4 w-4" aria-hidden="true" />{t("autopilot.chapterPanel.readers")}</Link></Button>}
            {rounds.length > 0 && <Button asChild size="sm" variant="ghost" className="min-h-11 sm:min-h-9"><Link to={`/app/books/${encodeURIComponent(bookId)}/director`}><Clapperboard className="h-4 w-4" aria-hidden="true" />{t("autopilot.chapterPanel.opinions")}</Link></Button>}
          </div>
        </div>
        <div className="space-y-6 px-4 py-4">
          <Part title={t("autopilot.chapterPanel.rounds.title")}>
            <Rounds rounds={rounds} />
          </Part>
          {review && <CurrentRound review={review} />}
          {!review && chapter.status === "done" && !chapter.imported && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{t("autopilot.chapterPanel.closed")}</p>
              <LastOpinion bookId={bookId} slug={chapter.slug} />
            </div>
          )}
          {chapter.scenes.length > 0 && <ScenesList chapter={chapter} states={row.scenes} />}
          <Part title={t("autopilot.chapterPanel.plan")}>
            {chapter.summary && <p className="whitespace-pre-line text-sm">{chapter.summary}</p>}
            {chapter.goal && <p className="text-sm"><span className="font-medium text-muted-foreground">{t("autopilot.approval.chapters.goal")}: </span>{chapter.goal}</p>}
            {chapter.keyEvents.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-sm">{chapter.keyEvents.map((event, index) => <li key={index}>{event}</li>)}</ul>}
          </Part>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The scenes of the chapter, each with its state in words and in its symbol, its title, its words, how many times it was fixed and what it does. */
function ScenesList({ chapter, states }: { chapter: PlannedChapter; states: MapRowModel["scenes"] }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-sm font-semibold">{t("autopilot.chapterPanel.scenes.title")}</h3>
    <ol aria-labelledby={id} className="space-y-1.5">
      {chapter.scenes.map((scene, index) => {
        const state = states[index];
        const Icon = SCENE_ICON[state];
        return (
          <li key={scene.number} className="flex gap-2 text-sm">
            <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border", SCENE_STYLE[state])}><Icon className="h-3.5 w-3.5" aria-hidden="true" /></span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{t("autopilot.map.cell", { number: scene.number, state: t(`autopilot.map.scene.${state}`) })}</span>
              {scene.title && <span> · {scene.title}</span>}
              <span className="block text-xs text-muted-foreground">
                {[scene.words ? t("autopilot.chapterPanel.scenes.words", { count: scene.words }) : null, scene.revisions > 0 ? t("autopilot.chapterPanel.scenes.revisions", { count: scene.revisions }) : null, scene.summary || scene.goal || null].filter(Boolean).join(" · ")}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
    </section>
  );
}

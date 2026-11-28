import { useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Ban, CheckCircle2, CircleDashed, ListChecks, Loader2, Lock, Play, Target } from "lucide-react";
import type { AutopilotState } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { useActiveReaders } from "@/autopilot/useActiveReaders";
import { bookRoundOf, decisionOf, defaultChosen, lastBookRounds, proposalOf, type BookRoundProgress, type BookRoundView, type CorrectionRow } from "@/autopilot/bookRound";
import { bookTargets } from "@/autopilot/resultModel";
import { formatCount, voteText } from "@/autopilot/format";
import { cn } from "@/lib/utils";
import type { BookStructure } from "@/types/book";

/**
 * The corrections of the whole book that the director asks for in the book-level round of a review (#113): the panel of the live page (the round in progress: what is asked, what
 * waits for the author, how far the corrections are carried out) and the block of the result of a finished book (the book's vote under its target and what the director asked of it
 * in the last review). One chunk, loaded only when there is a round in progress or the book is under its target; it reads nothing but the state the page already has.
 */

const STATUS_TONE: Record<CorrectionRow["status"], string> = {
  waiting: "text-amber-800 dark:text-amber-300",
  applied: "text-emerald-800 dark:text-emerald-300",
  "left-out": "text-muted-foreground",
};

/** Where a correction stands, in words with an icon (never by colour alone): waits, carried out, or left out, and why. */
function CorrectionStatus({ row }: { row: CorrectionRow }) {
  const { t } = useTranslation();
  const Icon = row.status === "applied" ? CheckCircle2 : row.status === "left-out" ? Ban : CircleDashed;
  return (
    <span data-correction-status={row.status} className={cn("inline-flex items-center gap-1 text-xs font-medium", STATUS_TONE[row.status])}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {t(`autopilot.bookRound.status.${row.status}`)}
      {row.status === "left-out" && row.why ? ` · ${t(`autopilot.bookRound.leftOut.${row.why}`)}` : ""}
    </span>
  );
}

interface CorrectionListProps {
  bookId: string;
  rows: readonly CorrectionRow[];
  linkedSlugs: ReadonlySet<string>;
  /** The corrections are chosen one by one (the author decides), or only read. */
  choose?: { chosen: ReadonlySet<number>; disabled: boolean; onToggle: (number: number, on: boolean) => void };
  /** The start of the ids of the rows: a list of its own on the page. */
  id: string;
  label: string;
}

/**
 * The corrections, in the order of the book: the chapter (a link to it when the book has its page), what to change, why, and the points of the director's judgement of the book that
 * it answers. A correction that asks a change of a chapter of the author's says so; with `choose` each has a box, never ticked for such a chapter before the author does.
 */
function CorrectionList({ bookId, rows, linkedSlugs, choose, id, label }: CorrectionListProps) {
  const { t } = useTranslation();
  return (
    <ol aria-label={label} data-book-corrections="" className="space-y-2">
      {rows.map((row) => {
        const rowId = `${id}-${row.number}`;
        const heading = (
          <span className="font-medium">
            {t("autopilot.bookRound.correction.chapter", { number: formatCount(row.chapter) })}{row.title ? ` — ${row.title}` : ""}
          </span>
        );
        return (
          <li key={row.number} data-book-correction={row.number} data-chapter={row.chapter} className="space-y-1.5 rounded-lg border bg-background/60 p-3 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              {choose ? (
                <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-2 sm:min-h-0">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                    checked={choose.chosen.has(row.number)}
                    disabled={choose.disabled}
                    aria-describedby={`${rowId}-change`}
                    onChange={(event) => choose.onToggle(row.number, event.target.checked)}
                  />
                  <span className="min-w-0"><span className="sr-only">{t("autopilot.bookRound.correction.choose", { number: formatCount(row.chapter) })}: </span>{heading}</span>
                </label>
              ) : (
                <span className="min-w-0 flex-1">{heading}</span>
              )}
              {!choose && <CorrectionStatus row={row} />}
            </div>
            {row.slug && linkedSlugs.has(row.slug) && (
              <p className="text-xs">
                <Link className="font-medium underline underline-offset-4" to={`/app/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(row.slug)}`}>{t("autopilot.bookRound.correction.open", { number: formatCount(row.chapter) })}</Link>
              </p>
            )}
            <dl className="space-y-1">
              <div>
                <dt className="text-xs font-semibold text-muted-foreground">{t("autopilot.bookRound.correction.change")}</dt>
                <dd id={`${rowId}-change`} className="whitespace-pre-line">{row.change}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold text-muted-foreground">{t("autopilot.bookRound.correction.reason")}</dt>
                <dd className="whitespace-pre-line">{row.reason}</dd>
              </div>
              {row.answers.length > 0 && (
                <div>
                  <dt className="text-xs font-semibold text-muted-foreground">{t("autopilot.bookRound.correction.answers")}</dt>
                  <dd><ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">{row.answers.map((answer, index) => <li key={index}>{answer}</li>)}</ul></dd>
                </div>
              )}
            </dl>
            {row.held && <p data-correction-held="" className="flex items-start gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-300"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("autopilot.bookRound.correction.held")}</p>}
            {choose && row.status !== "waiting" ? <CorrectionStatus row={row} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** What the author is asked: the corrections the director asks for, each with a box, and the two ways out (carry out those ticked, or leave them all out). */
function Proposal({ bookId, round, linkedSlugs }: { bookId: string; round: BookRoundProgress; linkedSlugs: ReadonlySet<string> }) {
  const { t } = useTranslation();
  const id = useId();
  const { busy, run } = useAutopilotActions(bookId);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(() => defaultChosen(round.rows));
  const waiting = round.rows.filter((row) => row.status === "waiting");
  const count = chosen.size;
  const decide = (decision: ReturnType<typeof decisionOf>) => void run("answer", async (runtime, book) => {
    await runtime.decideBookCorrections(book, decision);
    await runtime.start(book);
  });
  const toggle = (number: number, on: boolean) => setChosen((current) => {
    const next = new Set(current);
    if (on) next.add(number);
    else next.delete(number);
    return next;
  });
  const disabled = busy !== null;
  return (
    <section id="autopilot-book-round" data-book-round="proposed" tabIndex={-1} aria-labelledby={`${id}-title`} className="space-y-3 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5">
      <h2 id={`${id}-title`} className="flex items-center gap-2 text-base font-semibold"><ListChecks className="h-4 w-4 text-amber-700 dark:text-amber-600" aria-hidden="true" />{t("autopilot.bookRound.proposal.title")}</h2>
      <p className="text-sm">{t("autopilot.bookRound.proposal.intro", { book: voteText(round.score), target: voteText(round.target) })}</p>
      {round.summary && <p className="whitespace-pre-line text-sm"><span className="font-medium">{t("autopilot.bookRound.proposal.summary")}</span> {round.summary}</p>}
      {round.taken && <p className="text-xs text-muted-foreground">{t("autopilot.bookRound.progress.taken")}</p>}
      <CorrectionList
        id={`${id}-list`}
        label={t("autopilot.bookRound.proposal.list")}
        bookId={bookId}
        rows={round.rows}
        linkedSlugs={linkedSlugs}
        choose={{ chosen, disabled, onToggle: toggle }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={disabled || count === 0} aria-describedby={`${id}-count`} onClick={() => decide(decisionOf(round, chosen))}>
          {busy !== null ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          {count === 0 ? t("autopilot.bookRound.proposal.applyNone") : t("autopilot.bookRound.proposal.apply", { count })}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} aria-describedby={`${id}-decline`} onClick={() => decide(decisionOf(round, new Set()))}>{t("autopilot.bookRound.proposal.decline")}</Button>
      </div>
      <p id={`${id}-count`} role="status" className="text-xs text-muted-foreground">{t("autopilot.bookRound.proposal.chosen", { count, total: waiting.length })}</p>
      <p id={`${id}-decline`} className="text-xs text-muted-foreground">{t("autopilot.bookRound.proposal.declineHint")}</p>
    </section>
  );
}

/** A round that is not waiting for the author: the director is asked for its corrections, or they are being carried out chapter by chapter. */
function Progress({ bookId, round, linkedSlugs }: { bookId: string; round: BookRoundProgress; linkedSlugs: ReadonlySet<string> }) {
  const { t } = useTranslation();
  const id = useId();
  const asking = round.status === "asking";
  return (
    <section data-book-round={round.status} aria-labelledby={`${id}-title`} className="space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm">
      <h2 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold"><ListChecks className="h-4 w-4 text-primary" aria-hidden="true" />{t("autopilot.bookRound.progress.title")}</h2>
      <p role="status" className="text-sm">
        {asking
          ? t("autopilot.bookRound.progress.asking", { round: round.round, book: voteText(round.score), target: voteText(round.target) })
          : t("autopilot.bookRound.progress.applying", { round: round.round, done: round.applied, total: round.rows.length })}
      </p>
      {round.taken && <p className="text-xs text-muted-foreground">{t("autopilot.bookRound.progress.taken")}</p>}
      {round.rows.length > 0 && <CorrectionList id={`${id}-list`} label={t("autopilot.bookRound.proposal.list")} bookId={bookId} rows={round.rows} linkedSlugs={linkedSlugs} />}
    </section>
  );
}

/**
 * The corrections of the whole book on the live page, while a review is in a book-level round: what the author is asked when the round waits for them (carry out some, or none), and
 * where the round stands otherwise. Nothing when no review is in one.
 */
export function BookRoundPanel({ bookId, state, linkedSlugs }: { bookId: string; state: Pick<AutopilotState, "campaign" | "plan">; linkedSlugs: ReadonlySet<string> }) {
  const proposal = proposalOf(state);
  const round = bookRoundOf(state);
  if (proposal) return <Proposal key={proposal.round} bookId={bookId} round={proposal} linkedSlugs={linkedSlugs} />;
  if (round && (round.status === "asking" || round.status === "applying")) return <Progress bookId={bookId} round={round} linkedSlugs={linkedSlugs} />;
  return null;
}

/** One round the director asked the book for corrections: the vote the book had, how many corrections and what became of them, and the corrections themselves. */
function RoundDisclosure({ bookId, view, linkedSlugs, open }: { bookId: string; view: BookRoundView; linkedSlugs: ReadonlySet<string>; open: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const applied = view.rows.filter((row) => row.status === "applied").length;
  return (
    <details data-book-round-history={view.round} open={open} className="rounded-lg border bg-background/60 p-3">
      <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t("autopilot.result.bookRound.round", { round: view.round, book: voteText(view.score) })} · {t("autopilot.result.bookRound.counts", { count: view.rows.length, applied, left: view.rows.length - applied })}
      </summary>
      <div className="mt-2 space-y-2">
        {view.summary && <p className="whitespace-pre-line text-sm text-muted-foreground">{view.summary}</p>}
        <CorrectionList id={id} label={t("autopilot.result.bookRound.listOf", { round: view.round })} bookId={bookId} rows={view.rows} linkedSlugs={linkedSlugs} />
      </div>
    </details>
  );
}

export interface BookRoundBlockProps {
  bookId: string;
  state: AutopilotState;
  /** The structure of the book: the director's profile is read with the readers', as the table of targets does. */
  structure?: BookStructure;
  linkedSlugs: ReadonlySet<string>;
  /** Open «Review the book again» (with the round for the whole book on by default, when it is off): offered only when the page can. */
  onReview?: () => void;
}

/**
 * «The book as a whole» in the result of a finished book: the director's vote of the book when it is under its target (with whether the chapters have theirs, which is what a round of the
 * whole book is for), the way to review the book as a whole, and what the director asked of the book in the last review that had a round for it, round by round, with what became of each
 * correction. Nothing is said that the engine did not: no vote of the book, nothing shown.
 */
export default function BookRoundBlock({ bookId, state, structure, linkedSlugs, onReview }: BookRoundBlockProps) {
  const { t } = useTranslation();
  const id = useId();
  const active = useActiveReaders(bookId, structure, state.options.maxReaders);
  // The vote the book must reach: the policy's, else the director's approval score (read from its file, so nothing is said before it is).
  const target = state.options.review?.targetScore ?? active.director.approvalScore;
  const score = state.finalReview?.score;
  const under = active.ready && typeof score === "number" && score < target;
  const model = useMemo(() => bookTargets({ chapters: state.plan?.chapters ?? [], book: score ?? null, directorTarget: target }), [state.plan?.chapters, score, target]);
  const chaptersUnder = model.rows[0]?.under ?? 0;
  const rounds = useMemo(() => lastBookRounds(state), [state]);
  const roundOn = state.options.review?.bookRound !== undefined;
  if (!active.ready || (!under && rounds.length === 0)) return null;
  return (
    <div data-result-book-round="" className="min-w-0 space-y-3">
      <h3 id={`${id}-title`} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Target className="h-3.5 w-3.5" aria-hidden="true" />{t("autopilot.result.bookRound.title")}</h3>
      {under && (
        <div className="space-y-1.5">
          <p data-book-below="" className="text-sm font-medium">{t("autopilot.result.bookRound.below", { book: voteText(score), target: voteText(target) })}</p>
          <p className="text-xs text-muted-foreground">{chaptersUnder === 0 ? t("autopilot.result.bookRound.allChapters") : t("autopilot.result.bookRound.someChapters", { count: chaptersUnder })}</p>
          {onReview && (
            <div className="space-y-1">
              <Button type="button" size="sm" variant="outline" data-result-book-round-review="" aria-describedby={`${id}-hint`} onClick={onReview}>
                <Target className="h-4 w-4" aria-hidden="true" />{t("autopilot.result.bookRound.action")}
              </Button>
              <p id={`${id}-hint`} className="text-xs text-muted-foreground">{roundOn ? t("autopilot.result.bookRound.onHint") : t("autopilot.result.bookRound.offHint")}</p>
            </div>
          )}
        </div>
      )}
      {rounds.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">{t("autopilot.result.bookRound.asked")}</h4>
          {rounds.map((view, index) => <RoundDisclosure key={view.round} bookId={bookId} view={view} linkedSlugs={linkedSlugs} open={index === rounds.length - 1} />)}
        </div>
      )}
    </div>
  );
}

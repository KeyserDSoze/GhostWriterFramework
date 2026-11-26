import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCcw, Target } from "lucide-react";
import { DIRECTOR_FILE, REVIEW_MAX_CAMPAIGN_ROUNDS, REVIEW_MAX_ROUNDS, chapterFilePath, defaultDirector, parseDirector, type AutopilotState, type ReviewBookInput } from "narrarium-engine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EstimateLine, OptionalNumberField, useProblemText } from "@/components/autopilot/review/ReviewFields";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { useAutopilotStore } from "@/autopilot/store";
import { useBookFiles } from "@/autopilot/useBookFiles";
import { useBookAutopilotView } from "@/autopilot/hooks";
import { useRunEstimateSources } from "@/autopilot/useRunEstimate";
import { estimateReview } from "@/autopilot/runEstimate";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { formatCount, voteText } from "@/autopilot/format";
import { MAX_MONEY_CAP, REVIEW_SERVER_VERSION, TARGET_MAX, TARGET_MIN, TARGET_STEP, serverHasReviewBook, typedNumber } from "@/autopilot/reviewPolicy";
import { defaultReviewTarget, reviewCandidates, type ReviewCandidate } from "@/autopilot/resultModel";
import { chapterFreezes } from "@/outline/outlineModel";
import { useMoney } from "@/costs/useMoney";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

export interface ReviewBookDialogProps {
  open: boolean;
  onClose: () => void;
  book: BookEntry;
  branch: string;
  structure: BookStructure | undefined;
  state: AutopilotState;
}

/** The fields of the dialog, as they are typed. */
interface ReviewBookForm {
  target: string;
  rounds: string;
  readerRounds: string;
  campaignRounds: string;
  money: string;
}

type Field = keyof ReviewBookForm;

/** A whole number from `min` to `max`, or why it is not one. */
function whole(raw: string, min: number, max: number): { value: number | null; problem: "number" | "range" | null } {
  const value = typedNumber(raw);
  if (value === null) return { value: null, problem: null };
  if (!Number.isFinite(value) || !Number.isInteger(value)) return { value: null, problem: "number" };
  if (value < min || value > max) return { value: null, problem: "range" };
  return { value, problem: null };
}

/**
 * «Review the book again»: the target to reach (one point over the one in force, 8 at least), the rounds of a chapter, the rounds the readers read again, the rounds of the
 * review before it waits for the author, the money cap of the book (with what it spent: the cap never resets), what a round costs, and the chapters under the target that would
 * be reviewed again, in the order of the book: the autopilot's, and the author's only when the author includes them; one changed since it was frozen waits for the decision about
 * that change. Confirmed, the review is recorded (`reviewBook`) and the autopilot started. A personal server that predates it is not asked, and the dialog says why.
 */
export default function ReviewBookDialog({ open, onClose, book, branch, structure, state }: ReviewBookDialogProps) {
  const { t } = useTranslation();
  const id = useId();
  const money = useMoney();
  const problemText = useProblemText();
  const { run, busy } = useAutopilotActions(book.id);
  const serverInfo = useAutopilotStore((store) => store.server.info);
  const unsupported = book.autopilotHost === "server" && serverInfo !== null && !serverHasReviewBook(serverInfo);
  const chapters = state.plan?.chapters ?? [];

  // The director's score and rounds: the review starts from the ones in force.
  const directorFile = useBookFiles(book.id, open ? [DIRECTOR_FILE] : []);
  const director = useMemo(() => {
    const text = directorFile.files?.get(DIRECTOR_FILE);
    return text === undefined ? defaultDirector(structure?.language) : parseDirector(text, structure?.language);
  }, [directorFile.files, structure?.language]);
  const current = state.options.review?.targetScore ?? director.approvalScore;

  const initial = useMemo<ReviewBookForm>(() => ({
    target: String(defaultReviewTarget(current)),
    rounds: String(state.options.review?.maxRounds ?? director.maxReviewRounds),
    readerRounds: String(state.options.readers ? state.options.review?.readerRounds ?? 1 : 0),
    campaignRounds: state.options.review?.campaignMaxRounds ? String(state.options.review.campaignMaxRounds) : "",
    money: state.options.budgetLimit > 0 ? String(state.options.budgetLimit) : "",
  }), [current, director.maxReviewRounds, state.options]);
  const [form, setForm] = useState<ReviewBookForm>(initial);
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!edited) setForm(initial);
  }, [initial, edited]);
  useEffect(() => {
    if (!open) setEdited(false);
  }, [open]);
  const change = (field: Field, value: string) => {
    setEdited(true);
    setForm((now) => ({ ...now, [field]: value }));
  };

  // Who froze each chapter (read from the chapters that could be under a target), and the chapters changed since they were frozen.
  const unvoted = useMemo(() => reviewCandidates(chapters, TARGET_MAX, new Map(), new Set()).map((entry) => chapterFilePath(entry.slug)), [chapters]);
  const chapterFiles = useBookFiles(book.id, open ? unvoted : []);
  const freezes = useMemo(() => {
    const records = chapterFreezes([...(chapterFiles.files ?? new Map()).entries()].map(([path, content]) => ({ path, content })));
    return new Map([...records].map(([slug, record]) => [slug, record.by] as const));
  }, [chapterFiles.files]);
  const [changed, setChanged] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    void loadAutopilotRuntime()
      .then((runtime) => runtime.frozenStatus(book.id))
      .then((status) => { if (live) setChanged(new Set(status.changes.filter((entry) => entry.kind === "frozen").map((entry) => entry.number))); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [open, book.id]);
  const [include, setInclude] = useState<ReadonlySet<number>>(new Set());

  // The values, checked as the engine checks them.
  const targetValue = typedNumber(form.target);
  const targetProblem = targetValue === null || !Number.isFinite(targetValue) ? "number" : targetValue < TARGET_MIN || targetValue > TARGET_MAX ? "range" : Math.abs(targetValue / TARGET_STEP - Math.round(targetValue / TARGET_STEP)) > 1e-9 ? "step" : null;
  const target = targetProblem ? null : targetValue;
  const rounds = whole(form.rounds, 1, REVIEW_MAX_ROUNDS);
  const readerRounds = whole(form.readerRounds, 0, REVIEW_MAX_ROUNDS);
  const campaignRounds = whole(form.campaignRounds, 0, REVIEW_MAX_CAMPAIGN_ROUNDS);
  const moneyValue = typedNumber(form.money);
  const moneyProblem = moneyValue === null ? null : !Number.isFinite(moneyValue) ? "number" : moneyValue < 0 || moneyValue > MAX_MONEY_CAP ? "range" : null;
  const roundsMissing = rounds.value === null && !rounds.problem;
  const valid = target !== null && !rounds.problem && !roundsMissing && !readerRounds.problem && !campaignRounds.problem && !moneyProblem;

  const candidates = useMemo(() => (target === null ? [] : reviewCandidates(chapters, target, freezes, changed)), [chapters, target, freezes, changed]);
  const reviewed = candidates.filter((entry) => entry.kind === "review" || (entry.kind === "author" && include.has(entry.number)));
  const authors = candidates.filter((entry) => entry.kind === "author");
  const waiting = candidates.filter((entry) => entry.kind === "changed");

  // What a round costs: the chapters under the target, reviewed again, and the book judged again.
  const view = useBookAutopilotView(book.id);
  const inputs = useRunEstimateSources({ book, branch, structure, state, activities: view.snapshot?.activities });
  const scenes = useMemo(() => {
    const counts = reviewed.map((entry) => chapters.find((chapter) => chapter.number === entry.number)?.scenes.length ?? 0).filter((count) => count > 0);
    return counts.length ? Math.min(20, Math.max(1, Math.round(counts.reduce((sum, count) => sum + count, 0) / counts.length))) : undefined;
  }, [reviewed, chapters]);
  const estimate = useMemo(() => (open && reviewed.length && rounds.value !== null ? estimateReview(inputs.sources, state, { chapters: reviewed.length, maxRounds: rounds.value, readerRounds: readerRounds.value ?? 0, scenesPerChapter: scenes }).estimate : null), [open, reviewed.length, rounds.value, readerRounds.value, inputs.sources, state, scenes]);

  const spentCurrency = state.stats.currency || money.display;
  const spent = money.amount(state.stats.cost, state.stats.currency, { zero: "amount" });
  const capNow = moneyValue !== null && Number.isFinite(moneyValue) && moneyValue > 0 ? money.amount(moneyValue, spentCurrency) : null;
  const running = useAutopilotStore((store) => store.views[book.id]?.snapshot?.running === true || store.views[book.id]?.busyInAnotherTab === true);
  const canSubmit = valid && reviewed.length > 0 && !unsupported && busy === null && !running;

  // What the chapters come to, said once to a screen reader when the values stop changing: never one line for each key.
  const chaptersText = target === null ? "" : t("autopilot.reviewBook.chaptersTitle", { count: reviewed.length, target: voteText(target) });
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    if (!open || !edited) return undefined;
    const timer = window.setTimeout(() => setAnnounced(chaptersText), 1200);
    return () => window.clearTimeout(timer);
  }, [open, edited, chaptersText]);

  const submit = async () => {
    if (!canSubmit || target === null || rounds.value === null) return;
    const input: ReviewBookInput = {
      targetScore: target,
      maxRounds: rounds.value,
      readerRounds: readerRounds.value ?? 0,
      campaignMaxRounds: campaignRounds.value ?? 0,
      budgetLimit: moneyValue ?? 0,
      ...(include.size ? { include: [...include].filter((number) => authors.some((entry) => entry.number === number)) } : {}),
    };
    const done = await run("answer", async (runtime, bookId) => {
      await runtime.reviewBook(bookId, input);
      await runtime.start(bookId);
    });
    if (done) onClose();
  };

  const row = (entry: ReviewCandidate) => (
    <span><span className="font-medium">{t("autopilot.reviewBook.chapter", { number: formatCount(entry.number) })}{entry.title ? ` — ${entry.title}` : ""}</span> <span className="tabular-nums text-muted-foreground">· {voteText(entry.vote)}</span></span>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && busy === null) onClose(); }}>
      <DialogContent data-review-book="" className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Target className="h-5 w-5 text-primary" aria-hidden="true" />{t("autopilot.reviewBook.title")}</DialogTitle>
          <DialogDescription>{t("autopilot.reviewBook.intro", { book: voteText(state.finalReview?.score), target: voteText(current) })}</DialogDescription>
        </DialogHeader>
        {unsupported && <Alert variant="destructive"><AlertDescription>{t("autopilot.reviewBook.oldServer", { version: REVIEW_SERVER_VERSION })}</AlertDescription></Alert>}

        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <OptionalNumberField id={`${id}-target`} label={t("autopilot.review.target.label")} value={form.target} placeholder={String(defaultReviewTarget(current))} hint={t("autopilot.reviewBook.targetHint")} problem={problemText(targetProblem ?? undefined, { min: TARGET_MIN, max: TARGET_MAX })} unit="/10" decimals onChange={(value) => change("target", value)} />
          <OptionalNumberField id={`${id}-rounds`} label={t("autopilot.review.rounds.label")} value={form.rounds} placeholder={String(director.maxReviewRounds)} hint={t("autopilot.review.rounds.hint")} problem={problemText(rounds.problem ?? (roundsMissing ? "number" : undefined), { min: 1, max: REVIEW_MAX_ROUNDS })} onChange={(value) => change("rounds", value)} />
          <OptionalNumberField id={`${id}-readers`} label={t("autopilot.review.readerRounds.label")} value={form.readerRounds} placeholder="0" hint={state.options.readers ? t("autopilot.reviewBook.readersHint") : t("autopilot.review.readerRounds.off")} problem={problemText(readerRounds.problem ?? undefined, { min: 0, max: REVIEW_MAX_ROUNDS })} disabled={!state.options.readers} onChange={(value) => change("readerRounds", value)} />
          <OptionalNumberField id={`${id}-campaign`} label={t("autopilot.review.campaignRounds.label")} value={form.campaignRounds} placeholder={t("autopilot.review.unlimited")} hint={t("autopilot.review.campaignRounds.hint")} problem={problemText(campaignRounds.problem ?? undefined, { min: 0, max: REVIEW_MAX_CAMPAIGN_ROUNDS })} onChange={(value) => change("campaignRounds", value)} />
          <div className="sm:col-span-2">
            <OptionalNumberField
              id={`${id}-money`}
              label={t("autopilot.review.money.label", { currency: spentCurrency })}
              value={form.money}
              placeholder={t("autopilot.review.unlimited")}
              hint={capNow ? t("autopilot.reviewBook.moneyHint", { spent, cap: capNow }) : t("autopilot.reviewBook.moneyHintNone", { spent })}
              problem={problemText(moneyProblem ?? undefined, { min: 0, max: MAX_MONEY_CAP })}
              unit={spentCurrency}
              decimals
              onChange={(value) => change("money", value)}
            />
          </div>
        </div>

        <section aria-labelledby={`${id}-chapters`} className="space-y-2">
          <h3 id={`${id}-chapters`} className="text-sm font-semibold">{target === null ? t("autopilot.reviewBook.chaptersNoTarget") : chaptersText}</h3>
          {target !== null && candidates.length === 0 && <p data-review-nothing className="text-sm text-muted-foreground">{t("autopilot.reviewBook.nothing", { target: voteText(target), book: voteText(state.finalReview?.score) })}</p>}
          {candidates.filter((entry) => entry.kind === "review").length > 0 && (
            <ol data-review-chapters className="space-y-1 text-sm">
              {candidates.filter((entry) => entry.kind === "review").map((entry) => <li key={entry.number} data-review-chapter={entry.number}>{row(entry)}</li>)}
            </ol>
          )}
          {authors.length > 0 && (
            <fieldset className="space-y-1 rounded-lg border p-2">
              <legend className="px-1 text-xs font-semibold">{t("autopilot.reviewBook.authorsTitle")}</legend>
              <p className="text-xs text-muted-foreground">{t("autopilot.reviewBook.authorsHint")}</p>
              {authors.map((entry) => (
                <label key={entry.number} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-8">
                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={include.has(entry.number)} onChange={(event) => setInclude((now) => { const next = new Set(now); if (event.target.checked) next.add(entry.number); else next.delete(entry.number); return next; })} />
                  {row(entry)}
                </label>
              ))}
            </fieldset>
          )}
          {waiting.length > 0 && (
            <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-sm">
              <p className="text-xs font-semibold">{t("autopilot.reviewBook.changedTitle")}</p>
              <ul className="space-y-1">{waiting.map((entry) => <li key={entry.number}>{row(entry)}</li>)}</ul>
            </div>
          )}
        </section>

        {estimate && (
          <EstimateLine
            label={t("autopilot.reviewBook.estimate", { count: reviewed.length })}
            estimate={estimate}
            currency={inputs.sources.currency || "USD"}
            extra={<p className="text-muted-foreground">{campaignRounds.value ? t("autopilot.reviewBook.estimateRounds", { count: campaignRounds.value }) : t("autopilot.reviewBook.estimateUnlimited")}</p>}
          />
        )}
        <p className="text-xs text-muted-foreground">{t("autopilot.reviewBook.stops")}</p>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy !== null}>{t("autopilot.reviewBook.cancel")}</Button>
          <Button type="button" onClick={() => void submit()} disabled={!canSubmit} aria-describedby={running ? `${id}-running` : undefined}>
            {busy !== null ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCcw className="h-4 w-4" aria-hidden="true" />}
            {t("autopilot.reviewBook.submit", { count: reviewed.length })}
          </Button>
        </DialogFooter>
        {running && <p id={`${id}-running`} className="text-xs text-muted-foreground">{t("autopilot.reviewBook.running")}</p>}
        <p role="status" data-review-announcement className="sr-only">{announced}</p>
      </DialogContent>
    </Dialog>
  );
}

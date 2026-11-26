import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GitHubServerTokenNotice } from "@/components/book/GitHubServerTokenNotice";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  AlertTriangle,
  BookOpen,
  BookOpenCheck,
  CheckCircle2,
  Clapperboard,
  Cloud,
  Laptop,
  Loader2,
  MessageSquarePlus,
  Play,
  Plane,
  RefreshCcw,
  RotateCcw,
  Scale,
  Server,
  SlidersHorizontal,
  XCircle,
} from "lucide-react";
import {
  type AutopilotActivity,
  type AutopilotPlan,
  type AutopilotState,
  type InterventionScope,
} from "narrarium-engine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { AutopilotResult } from "@/components/autopilot/AutopilotResult";
import { LimitPanel } from "@/components/autopilot/LimitPanel";
import { AutopilotTimeline } from "@/components/autopilot/AutopilotTimeline";
import { AutopilotBandDetails, AutopilotControlBand } from "@/components/autopilot/AutopilotControlBand";
import { Card } from "@/components/autopilot/Card";
import { OperationNotice } from "@/components/autopilot/OperationNotice";
import { PlanChapters, RemovedChapters, useGhostwriterName } from "@/components/autopilot/PlanChapters";
import { PlanApproval } from "@/components/autopilot/plan/PlanApproval";
import { ChapterMap } from "@/components/autopilot/map/ChapterMap";
import { QuickCommands } from "@/components/autopilot/QuickCommands";
import { ProfileProblemsNotice } from "@/components/autopilot/StopNotices";
import { QuestionCard } from "@/components/autopilot/QuestionCard";
import { PendingReviews } from "@/components/autopilot/PendingReviews";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { ErrorPanel } from "@/components/autopilot/ErrorPanel";
import { LearnedModelNotices } from "@/components/autopilot/LearnedModelNotices";
import { GithubConflictsAction } from "@/components/autopilot/GithubConflictsAction";
import { GithubConflictsWindow } from "@/components/autopilot/GithubConflictsWindow";
import { SyncConflicts } from "@/components/autopilot/SyncConflicts";
import { githubConflictsOfSync } from "@/autopilot/githubConflicts";
import { SyncSkipped } from "@/components/autopilot/SyncSkipped";
import { closedChapterToRead, finalReviewOf, pageLayout } from "@/autopilot/bandModel";
import { planReviewMode } from "@/autopilot/planApprovalModel";
import { useAutopilotRefresh, useBookAutopilotView } from "@/autopilot/hooks";
import { setAutopilotHost } from "@/autopilot/host";
import { autopilotSettingsHref } from "@/autopilot/pageRoute";
import { STREAM_CHARACTERS, taskIdOfHash } from "@/autopilot/liveText";
import { callIdOfHash } from "@/components/autopilot/calls/anchors";
import { useTextDetail } from "@/autopilot/useLiveText";
import { PREVIEW_CHARACTERS } from "@/components/autopilot/band/parts";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { useAutopilotControl } from "@/autopilot/useAutopilotControl";
import { useAutopilotStore, type SyncOutcome } from "@/autopilot/store";
import { useServerConnection } from "@/autopilot/serverConnection";
import { formatDateTime, syncStatusText } from "@/autopilot/format";
import { isProfileProblemStop } from "@/autopilot/stopReason";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useContainerWidth } from "@/hooks/useContainerWidth";
import { useReserveSpace } from "@/hooks/useReserveSpace";
import { FloatingInBar } from "@/components/layout/FloatingInBar";
import { useScrollToHash } from "@/hooks/useScrollToHash";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { bookStorageMode, type BookEntry } from "@/types/settings";
import { cn } from "@/lib/utils";

const SCOPES: InterventionScope[] = ["next_step", "from_now", "rewrite"];

/** The sentence under a run that waits for its profile files: the button that resumes is described by it. */
const PROFILE_HINT_ID = "autopilot-profile-problems-hint";

const NO_ACTIVITIES: AutopilotActivity[] = [];

type PageTab = "overview" | "timeline" | "plan" | "rules";

/** The tab that holds what a link to `#its-id` points at, for the page that has tabs. */
const TAB_OF_ID: Record<string, PageTab> = { "autopilot-where": "rules" };

/** The tab of an anchor: the ones above, and every step of the history (`#task-<id>`, see `taskHref`) and call of a step (`#call-<id>`), which are in the Timeline. */
function tabOfId(id: string): PageTab | undefined {
  return TAB_OF_ID[id] ?? (taskIdOfHash(id) || callIdOfHash(id) ? "timeline" : undefined);
}

/** The links that opened the settings on this page before they had a page of their own: they lead there now. */
const MOVED_TO_SETTINGS = "autopilot-setup";

type RunAction = ReturnType<typeof useAutopilotActions>["run"];

/**
 * The live page of a book's autopilot: what it is doing (the band, what waits for the author, the result), its history, the plan, the way to
 * intervene, the permanent rules to read and where it runs. The brief, the settings, the editing of the rules and the reset are on the
 * configuration (`AutopilotSettingsPage`).
 */
export function AutopilotPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const location = useLocation();
  const { settings } = useSettingsStore();
  const { branch, ready } = useWorkingBranch(bookId);
  const { book, structure, error, reload } = useBookStructure(bookId);
  const view = useBookAutopilotView(bookId);
  const serverStatus = useServerConnection().status;
  const { busy, run } = useAutopilotActions(bookId);
  const host = book?.autopilotHost === "server" ? "server" : "browser";
  const canRefresh = Boolean(book && (host === "server" || (structure && ready)));
  useAutopilotRefresh(bookId, canRefresh, `${host}:${branch}`);

  const snapshot = view.snapshot;
  const loaded = Boolean(snapshot || view.error);
  const state = snapshot?.state ?? null;
  const activities = snapshot?.activities ?? NO_ACTIVITIES;
  // Status and statistics follow the summaries of the `state` events (the page does not download the whole state again for
  // them), and who can command the run is read the same way here, in the dock and in the bar of quick commands.
  const control = useAutopilotControl(bookId);
  const { summary, status, controllable, running } = control;
  const noAi = host === "browser" && settings.aiIntegrations.length === 0;
  const linkedChapters = useMemo(() => new Set(structure?.chapters.map((chapter) => chapter.slug) ?? []), [structure?.chapters]);
  const closedChapter = useMemo(() => closedChapterToRead(state, activities, status), [state, activities, status]);
  // The title of a chapter is looked up when a group asks for it: a plan has no maximum number of chapters, and the timeline shows a few.
  const planChapters = state?.plan?.chapters;
  const chapterTitle = useCallback((number: number) => planChapters?.find((chapter) => chapter.number === number)?.title, [planChapters]);
  // The ghostwriter the outline gives a chapter, when it is not the book's (engine 0.1.8).
  const ghostwriterName = useGhostwriterName(bookId ?? "");
  const chapterGhostwriter = useCallback((number: number) => {
    const slug = planChapters?.find((chapter) => chapter.number === number)?.ghostwriter;
    return slug ? ghostwriterName(slug) : undefined;
  }, [planChapters, ghostwriterName]);
  // The rounds of review the plan recorded (engine 0.1.6) and the verdict on the whole book: the history numbers and scores its rounds by them, and by the log for a state that has none.
  const chapterRounds = useCallback((number: number) => planChapters?.find((chapter) => chapter.number === number)?.rounds, [planChapters]);
  const finalReview = useMemo(() => finalReviewOf(summary, state), [summary, state]);
  // How many frozen chapters changed is counted by a run before every step: a book that does not run is asked once when its page opens.
  const hasState = Boolean(state);
  useEffect(() => {
    if (!bookId || !hasState || running) return;
    void loadAutopilotRuntime().then((runtime) => runtime.frozenStatus(bookId)).catch(() => undefined);
  }, [bookId, hasState, running]);

  // How wide the page has: two columns when it is wide, tabs when it is not, and on a phone a short band with the actions in a bar at the bottom.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const { width, measured } = useContainerWidth(root);
  const layout = pageLayout(width);
  const tabs: PageTab[] = ["overview", "timeline", "plan", "rules"];
  // A plan that waits for the author (to be approved, or to be made again with the changes asked) is what the person came to see: its own screen
  // takes the place of the history, and until they pick a tab themselves the Plan is the one that is open.
  const planReview = planReviewMode(state, running);
  // The tab the author chose is the one of that book: the page of another book (whose plan may wait) opens as its own.
  const [chosen, setChosen] = useState<{ bookId: string | undefined; tab: PageTab } | null>(null);
  const chosenTab = chosen && chosen.bookId === bookId ? chosen.tab : null;
  const active = chosenTab && tabs.includes(chosenTab) ? chosenTab : planReview ? "plan" : tabs[0];
  const hash = safeDecode(location.hash.replace(/^#/, ""));
  const hashTab = tabOfId(hash);
  const taskLink = Boolean(taskIdOfHash(hash) || callIdOfHash(hash));
  useEffect(() => {
    if (hashTab) setChosen({ bookId, tab: hashTab });
  }, [hashTab, location.key, bookId]);
  // Nothing is followed before the width is known: the layout of the first draw is thrown away at once, and what was focused in it with it. A step of the
  // history is looked for again when the log or the step that runs changes: the step a link points at may arrive after the page.
  const liveId = useAutopilotStore((store) => (bookId ? store.live[bookId]?.activity.id ?? "" : ""));
  const [textDetail] = useTextDetail();
  useScrollToHash(loaded && measured, `${layout}:${active}${taskLink ? `:${activities.length}:${activities[activities.length - 1]?.id ?? ""}:${liveId}` : ""}`);

  if (error && !structure && host === "browser") return <BookStructureErrorAlert error={error} reload={reload} />;
  if (!book || !bookId) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;

  const settingsHref = autopilotSettingsHref(bookId);
  if (hash === MOVED_TO_SETTINGS) return <Navigate to={{ pathname: settingsHref, hash: "autopilot-overview" }} replace />;

  // The engine waits for the author without a question when a profile file has problems; a run that ended with an error has the panel of its own.
  const profileStop = isProfileProblemStop(summary);
  const compact = layout === "compact";
  const chapterHref = closedChapter?.slug && linkedChapters.has(closedChapter.slug) ? `/app/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(closedChapter.slug)}` : null;

  const commands = (
    <QuickCommands
      bookId={bookId}
      variant="page"
      framed={false}
      profileHintId={PROFILE_HINT_ID}
      condensed={layout !== "wide"}
      tools={layout === "compact" ? <FloatingInBar /> : undefined}
      runExtra={chapterHref && closedChapter ? (
        <Button asChild size="sm" variant="outline">
          <Link to={chapterHref}><BookOpen className="h-4 w-4" aria-hidden="true" />{t("autopilot.actions.readChapter", { number: closedChapter.number })}</Link>
        </Button>
      ) : undefined}
    />
  );

  const reset = () => { if (window.confirm(t("autopilot.actions.resetConfirm"))) void run("reset", (runtime, id) => runtime.reset(id)); };
  const intervene = state ? <InterventionLauncher state={state} asking={Boolean(summary?.question)} running={running} controllable={controllable} busy={busy !== null} run={run} /> : null;

  // What comes under the band, always at the top of the content: the question, what went wrong, the plan that waits, and the state of the connections.
  const alerts = (
    <div data-autopilot-alerts className="space-y-3 empty:hidden">
      {summary?.question && <QuestionCard bookId={bookId} question={summary.question} disabled={busy !== null || running} run={run} />}
      <PendingReviews reviews={state?.pendingReviews} running={running} />
      <ErrorPanel bookId={bookId} />
      <LearnedModelNotices />
      {profileStop && <ProfileProblemsNotice bookId={bookId} message={summary?.message} hintId={PROFILE_HINT_ID} />}
      {noAi && <Alert><AlertTriangle className="h-4 w-4" /><AlertDescription className="flex flex-wrap items-center justify-between gap-2"><span>{t("autopilot.errors.aiMissing")}</span><Button asChild size="sm" variant="outline"><Link to="/app/settings/ai-integrations">{t("settingsSection.aiIntegrationsTitle")}</Link></Button></AlertDescription></Alert>}
      {view.error && <Alert variant="destructive"><AlertDescription>{view.error}</AlertDescription></Alert>}
      {snapshot?.stateError && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("autopilot.errors.stateCorrupt")}</span>
            <Button size="sm" variant="outline" disabled={busy !== null || running} onClick={reset}>
              <RotateCcw className="h-4 w-4" />{t("autopilot.actions.reset")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {host === "server" && (serverStatus === "offline" || serverStatus === "error") && <Alert><Cloud className="h-4 w-4" /><AlertDescription>{t("autopilot.serverOffline")}</AlertDescription></Alert>}
      {host === "server" && serverStatus === "reconnecting" && <Alert><Cloud className="h-4 w-4" /><AlertDescription>{t("autopilot.serverReconnecting")}</AlertDescription></Alert>}
      {view.busyInAnotherTab && <Alert><AlertDescription>{t("autopilot.anotherTab")}</AlertDescription></Alert>}
      <OperationNotice bookId={bookId} />
      <GithubConflictsWindow bookId={bookId} />
    </div>
  );

  const result = <AutopilotResult bookId={bookId} linkedSlugs={linkedChapters} wide={layout === "wide"} review={book ? { book, branch, structure } : undefined} />;
  // The band of the wide page shows the end of the text that streams (its lines, or one line with «Show the text» off): the history adds it only when there is more.
  const shownAbove = layout === "wide" ? (textDetail === "full" ? STREAM_CHARACTERS : PREVIEW_CHARACTERS) : 0;
  const timeline = <AutopilotTimeline bookId={bookId} loading={!loaded} activities={activities} chapterTitle={chapterTitle} chapterGhostwriter={chapterGhostwriter} chapterRounds={chapterRounds} finalReview={finalReview} currency={summary?.stats.currency ?? settings.costCurrency} shownAbove={shownAbove} />;
  const plan = state ? <PlanCard bookId={bookId} plan={state.plan} reviewNumber={state.review?.chapterNumber} linkedSlugs={linkedChapters} /> : null;
  const approval = state && planReview ? <PlanApproval bookId={bookId} mode={planReview} state={state} activities={activities} /> : null;
  // The map of the chapters goes with the plan, and both give way to the approval while the plan waits for the author.
  const map = state?.plan?.chapters.length ? <ChapterMap bookId={bookId} state={state} linkedSlugs={linkedChapters} /> : null;
  const rules = state ? <RulesCard state={state} editHref={`${settingsHref}#autopilot-rules`} /> : null;
  const where = <WhereCard book={book} running={running} quiet />;

  const loading = !loaded ? (
    <div className="flex items-center gap-2 rounded-2xl border border-layer bg-card p-5 text-sm text-muted-foreground shadow-sm"><Loader2 className="h-4 w-4 animate-spin" />{t("autopilot.current.loading")}</div>
  ) : null;

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold tracking-tight"><Plane className="h-6 w-6 text-primary" aria-hidden="true" />{t("autopilot.title")}{(view.loading || !loaded) && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}</h1>
        {!state && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("autopilot.description")}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* On a phone the two links are icons, with their names for screen readers: the title and the band keep the first row. */}
        <Button asChild variant="outline"><Link to={settingsHref}><SlidersHorizontal className="h-4 w-4" aria-hidden="true" /><span className="sr-only sm:not-sr-only">{t("nav.autopilotSettings")}</span></Link></Button>
        <Button asChild variant="outline"><Link to={`/app/books/${encodeURIComponent(bookId)}/director`}><Clapperboard className="h-4 w-4" aria-hidden="true" /><span className="sr-only sm:not-sr-only">{t("autopilot.actions.director")}</span></Link></Button>
        <Button variant="ghost" size="icon" title={t("autopilot.actions.refresh")} aria-label={t("autopilot.actions.refresh")} disabled={!canRefresh} onClick={() => void run("refresh", (runtime, id) => runtime.refresh(id))}>
          <RefreshCcw className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  // The page of a book that never started, or whose state is not there to read: the way to the configuration, where it starts, and where it runs.
  if (!state || !summary) {
    return (
      <div ref={setRoot} className="mx-auto max-w-6xl space-y-4">
        {header}
        {alerts}
        {!loaded ? loading : (
          <div className={cn("grid gap-5", layout === "wide" && "grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]")}>
            <div className="min-w-0 space-y-5">{snapshot && !snapshot.state && !snapshot.stateError ? <ConfigureInvite settingsHref={settingsHref} /> : null}</div>
            <div className="min-w-0 space-y-5">{where}</div>
          </div>
        )}
      </div>
    );
  }

  const band = <AutopilotControlBand bookId={bookId} variant={layout === "wide" ? "full" : compact ? "compact" : "slim"} commands={compact ? null : commands} />;

  return (
    <div ref={setRoot} className="mx-auto max-w-6xl space-y-4">
      {header}
      {band}
      <LimitPanel bookId={bookId} summary={summary} />
      {alerts}
      {layout === "wide" && result}
      {layout === "wide" ? (
        <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-5">
          {/* A plan that waits takes the place of the history, which a link to one of its steps brings back under it. */}
          <div data-autopilot-main className="min-w-0 space-y-5">{approval ? <>{approval}{taskLink && timeline}</> : timeline}</div>
          <div data-autopilot-side className="min-w-0 space-y-4">
            {approval ? null : <>{map}{plan}</>}
            {intervene}
            {rules}
            {where}
          </div>
        </div>
      ) : (
        <Tabs value={active} onValueChange={(value) => setChosen({ bookId, tab: value as PageTab })}>
          <TabsList aria-label={t("autopilot.tabs.label")} className="grid h-auto w-full grid-cols-4">
            {tabs.map((tab) => <TabsTrigger key={tab} value={tab} className="px-1.5 text-xs sm:text-sm">{t(`autopilot.tabs.${tab}`)}</TabsTrigger>)}
          </TabsList>
          <TabsContent value="overview" className="space-y-4">
            {result}
            <AutopilotBandDetails bookId={bookId} variant={compact ? "compact" : "slim"} />
            {intervene}
          </TabsContent>
          <TabsContent value="timeline" className="space-y-5">{timeline}</TabsContent>
          <TabsContent value="plan" className="space-y-4">{approval ?? <>{map}{plan}</>}</TabsContent>
          <TabsContent value="rules" className="space-y-4">
            {rules}
            {where}
          </TabsContent>
        </Tabs>
      )}
      {compact && <BottomBar>{commands}</BottomBar>}
    </div>
  );
}

/** A book whose autopilot never started: what to do, and the way to the configuration, where the brief is written and the autopilot started. */
function ConfigureInvite({ settingsHref }: { settingsHref: string }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="autopilot-invite-title" className="space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
      <h2 id="autopilot-invite-title" className="text-base font-semibold">{t("autopilot.live.inviteTitle")}</h2>
      <p className="text-sm text-muted-foreground">{t("autopilot.live.inviteBody")}</p>
      <Button asChild>
        <Link to={settingsHref}><SlidersHorizontal className="h-4 w-4" aria-hidden="true" />{t("autopilot.live.configure")}</Link>
      </Button>
    </section>
  );
}

/** A hash as the page reads it: decoded, or as it is when it is not a valid escape. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** On a phone the actions are in a bar at the bottom of the screen, where the thumb is. The page and the floating buttons keep clear of it. */
function BottomBar({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  useReserveSpace(bar, "--bottom-reserve", true);
  return <div ref={bar} data-autopilot-bottom-bar className="fixed inset-x-0 bottom-0 z-30 border-t border-layer bg-card px-3 py-2 shadow-lg">{children}</div>;
}

/** The chapters of the plan. That the plan waits for the author is said once, under the band, and not here. */
export const PlanCard = memo(function PlanCard({ bookId, plan, reviewNumber, linkedSlugs }: { bookId: string; plan: AutopilotPlan | null; reviewNumber: number | undefined; linkedSlugs: ReadonlySet<string> }) {
  const { t } = useTranslation();
  return (
    <Card title={t("autopilot.plan.title")} icon={<BookOpenCheck className="h-4 w-4 text-primary" />}>
      {!plan?.chapters.length ? (
        <p className="text-sm text-muted-foreground">{t("autopilot.plan.empty")}</p>
      ) : (
        <PlanChapters key={bookId} bookId={bookId} chapters={plan.chapters} linkedSlugs={linkedSlugs} reviewNumber={reviewNumber} />
      )}
      <RemovedChapters bookId={bookId} numbers={plan?.removedChapters} />
      {plan && plan.readerReactions.length > 0 && (
        <details className="rounded-lg border p-2 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t("autopilot.plan.readers")}</summary>
          <ul className="mt-2 space-y-1.5">
            {plan.readerReactions.map((reaction) => (
              <li key={reaction.slug} className="text-xs"><span className="font-medium">{reaction.name} · {reaction.interest}/10</span> — {reaction.reaction}</li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
});

type InterventionProps = { state: AutopilotState; asking: boolean; running: boolean; controllable: boolean; busy: boolean; run: RunAction };

/**
 * Intervening is a button that opens its own form, not a card with a form on the page: the author writes an instruction, says how far it goes, and
 * records it (or records it and goes on, or interrupts the step that runs).
 */
function InterventionLauncher(props: InterventionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const waiting = props.state.interventions.filter((entry) => entry.status === "pending").length;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />{t("autopilot.actions.intervene")}
      </Button>
      {waiting > 0 && <span className="text-xs text-muted-foreground">{t("autopilot.intervention.history", { count: waiting })}</span>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("autopilot.intervention.title")}</DialogTitle>
            <DialogDescription>{t("autopilot.intervention.description")}</DialogDescription>
          </DialogHeader>
          <InterventionForm {...props} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InterventionForm({ state, asking, running, controllable, busy, run, onDone }: InterventionProps & { onDone: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [scope, setScope] = useState<InterventionScope>("next_step");
  const history = useMemo(() => [...state.interventions].reverse(), [state.interventions]);
  const submit = async (mode: "record" | "continue" | "interrupt") => {
    const ok = await run("intervene", async (runtime, id) => {
      await runtime.intervene(id, { scope, text: text.trim(), interrupt: mode === "interrupt" });
      if (mode === "continue") await runtime.start(id);
    }, t("autopilot.intervention.recorded"));
    if (ok) {
      setText("");
      onDone();
    }
  };
  const blocked = busy || !text.trim() || (running && !controllable);
  return (
    <div className="space-y-3">
      <AutoTextarea value={text} onChange={(event) => setText(event.target.value)} minRows={3} placeholder={t("autopilot.intervention.placeholder")} aria-label={t("autopilot.intervention.title")} className="text-sm" />
      <div className="space-y-1.5" role="radiogroup" aria-label={t("autopilot.intervention.title")}>
        {SCOPES.map((option) => (
          <label key={option} className={cn("flex cursor-pointer gap-2 rounded-lg border p-2 text-sm transition", scope === option ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40")}>
            <input type="radio" name="intervention-scope" className="mt-1" checked={scope === option} onChange={() => setScope(option)} />
            <span><span className="font-medium">{t(`autopilot.intervention.scope.${option}`)}</span><span className="block text-xs text-muted-foreground">{t(`autopilot.intervention.help.${option}`)}</span></span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {running ? (
          <>
            <Button size="sm" disabled={blocked} onClick={() => void submit("record")}>{t("autopilot.intervention.recordWhileRunning")}</Button>
            <Button size="sm" variant="outline" disabled={blocked} onClick={() => void submit("interrupt")}>{t("autopilot.intervention.interrupt")}</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" disabled={blocked} onClick={() => void submit("record")}>{t("autopilot.intervention.record")}</Button>
            {!asking && <Button size="sm" disabled={blocked} onClick={() => void submit("continue")}><Play className="h-3.5 w-3.5" />{t("autopilot.intervention.recordAndContinue")}</Button>}
          </>
        )}
      </div>
      {history.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t("autopilot.intervention.history", { count: history.length })}</summary>
          <ul className="mt-2 space-y-1.5">
            {history.map((entry) => (
              <li key={entry.id} className="rounded-lg bg-muted/40 p-2 text-xs">
                <p className="whitespace-pre-wrap">{entry.text}</p>
                <p className="mt-0.5 text-muted-foreground">{t(`autopilot.intervention.scope.${entry.scope}`)} · {entry.status === "applied" ? t("autopilot.intervention.applied") : t("autopilot.intervention.waiting")} · {formatDateTime(entry.createdAt)}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The permanent rules and the director's guidance, to read while the autopilot works: the rules are changed in the configuration (`editHref`). */
function RulesCard({ state, editHref }: { state: AutopilotState; editHref: string }) {
  const { t } = useTranslation();
  // Each list says in its own words that it is empty: two lists that say “none yet” say the same text twice.
  const list = (items: string[], none: string) => items.length ? <ul className="list-disc space-y-1 pl-5 text-sm">{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="text-sm text-muted-foreground">{none}</p>;
  const edit = <Link to={editHref} className="inline-flex min-h-6 items-center rounded-sm text-xs font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("autopilot.live.editRules")}</Link>;
  return (
    <Card title={t("autopilot.rules.title")} icon={<Scale className="h-4 w-4 text-primary" />} actions={edit} quiet>
      <div className="space-y-1"><p className="text-xs font-medium text-muted-foreground">{t("autopilot.rules.constraints")}</p>{list(state.constraints, t("autopilot.rules.noConstraints"))}</div>
      <div className="space-y-1"><p className="text-xs font-medium text-muted-foreground">{t("autopilot.rules.directorNotes")}</p>{list(state.directorNotes, t("autopilot.rules.noNotes"))}</div>
    </Card>
  );
}

/** The toast that fits how a sync ended: each outcome reads differently, and only a real success reads as one. */
function syncToast(t: TFunction, outcome: SyncOutcome): Parameters<ReturnType<typeof useToast>["toast"]>[0] {
  switch (outcome.kind) {
    case "synced": return { title: t("autopilot.where.synced") };
    case "up-to-date": return { title: t("autopilot.where.upToDate") };
    case "published": return { title: t("autopilot.where.published") };
    case "partial": return { title: t("autopilot.where.partial"), variant: "destructive" };
    case "local-changes": return { title: t("autopilot.where.localChanges"), variant: "destructive" };
    case "conflicts": return { title: t("autopilot.where.conflicts", { count: outcome.conflicts.length }), variant: "destructive" };
    default: return { title: t("autopilot.errors.action"), description: outcome.message, variant: "destructive" };
  }
}

function SyncIcon({ kind }: { kind: SyncOutcome["kind"] }) {
  if (kind === "error") return <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />;
  if (kind === "conflicts" || kind === "local-changes" || kind === "partial") return <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />;
  return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />;
}

export function WhereCard({ book, running, quiet = false }: { book: BookEntry; running: boolean; quiet?: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { save } = useSettings();
  const server = useServerConnection();
  const view = useBookAutopilotView(book.id);
  const { busy, run } = useAutopilotActions(book.id);
  const host = book.autopilotHost === "server" ? "server" : "browser";
  const [choice, setChoice] = useState<"browser" | "server">(host);
  const [consentAi, setConsentAi] = useState(true);
  const [consentGithub, setConsentGithub] = useState(true);
  const github = bookStorageMode(book) === "github";
  // Online means the server proved the identity pinned in the settings: only then does a book (with its keys and tokens) move there.
  const serverReady = server.status === "online";
  const serverBook = view.server;
  useEffect(() => setChoice(host), [host]);

  const setHost = (next: "browser" | "server") => setAutopilotHost(book.id, next, save);
  // The quick commands send the author here when a consent is missing: the side they wanted to pass to is already chosen.
  const whereIntent = useAutopilotStore((state) => state.whereIntent);
  useEffect(() => {
    if (whereIntent?.bookId !== book.id) return;
    setChoice(whereIntent.side);
    useAutopilotStore.getState().setWhereIntent(null);
  }, [whereIntent, book.id]);
  const move = () => void run("move", async (runtime, id) => {
    await runtime.moveToServer(id, { sendAiConfiguration: consentAi, sendGitHubToken: github && consentGithub });
    await setHost("server");
    toast({ title: t("autopilot.where.moved") });
  });
  const moveBack = () => void run("move", async (runtime, id) => {
    await runtime.moveToBrowser(id);
    await setHost("browser");
    toast({ title: t("autopilot.where.movedBack") });
  });
  // The way out when the server cannot be reached: the book comes back as it is here, without what the server wrote since the last sync.
  const moveBackWithoutDownloading = () => {
    if (!window.confirm(t("autopilot.where.discardConfirm"))) return;
    void run("move", async (runtime, id) => {
      await runtime.moveToBrowser(id, { discardServerWork: true });
      await setHost("browser");
      toast({ title: t("autopilot.where.movedBack") });
    });
  };
  const statusRef = useRef<HTMLDivElement>(null);
  const settle = (choices: Record<string, "local" | "remote">) => void run("sync", async (runtime, id) => {
    toast(syncToast(t, await runtime.resolveSyncConflicts(id, choices)));
  }).then(() => window.setTimeout(() => {
    // The file that was settled leaves the list with its buttons: the focus goes to where the result is announced instead of being lost.
    if (!document.activeElement || document.activeElement === document.body) statusRef.current?.focus();
  }, 0));
  const sync = view.sync;
  const syncText = syncStatusText(t, sync);
  // The server says its sync with GitHub stopped on files that both changed: the way to settle them is here, as it is in the panel of the error.
  const githubConflicts = host === "server" ? githubConflictsOfSync(serverBook?.lastSync) : null;

  return (
    <Card id="autopilot-where" title={t("autopilot.where.title")} icon={<Server className="h-4 w-4 text-primary" />} quiet={quiet}>
      <p className="text-xs text-muted-foreground">{t("autopilot.where.description")}</p>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("autopilot.where.title")}>
        {(["browser", "server"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={choice === option}
            disabled={running || busy !== null}
            onClick={() => setChoice(option)}
            className={cn("flex items-center gap-2 rounded-lg border p-2 text-left text-sm transition disabled:opacity-60", choice === option ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40")}
          >
            {option === "server" ? <Server className="h-4 w-4 shrink-0" /> : <Laptop className="h-4 w-4 shrink-0" />}
            <span className="min-w-0">{t(`autopilot.where.${option}`)}</span>
          </button>
        ))}
      </div>
      {choice === "server" && host === "browser" && (
        <div className="space-y-2">
          {serverReady ? (
            <>
              <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={consentAi} onChange={(event) => setConsentAi(event.target.checked)} />{t("autopilot.where.consentAi")}</label>
              {github && <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={consentGithub} onChange={(event) => setConsentGithub(event.target.checked)} />{t("autopilot.where.consentGithub")}</label>}
              {github && <GitHubServerTokenNotice book={book} />}
            </>
          ) : (
            <p id={`where-move-blocked-${book.id}`} className="text-xs text-muted-foreground" role="note">
              {server.status === "disabled" ? t("autopilot.where.noServer") : t("autopilot.where.serverUnverified")} <Link className="underline" to="/app/settings/server">{t("personalServer.title")}</Link>
            </p>
          )}
          <Button size="sm" disabled={!serverReady || busy !== null || running || (github && !consentGithub && !serverBook?.hasGithubToken)} aria-describedby={serverReady ? undefined : `where-move-blocked-${book.id}`} onClick={move}>
            {busy === "move" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Server className="h-3.5 w-3.5" />}{t("autopilot.where.move")}
          </Button>
        </div>
      )}
      {host === "server" && (
        <div className="space-y-2">
          {serverBook ? (
            <p className="text-xs text-muted-foreground">{t("autopilot.where.serverBook", { status: serverBook.autopilot ? t(`autopilot.status.${serverBook.autopilot.status}`) : t("autopilot.notStarted") })}{serverBook.lastSync ? ` · ${serverBook.lastSync.message}` : ""}</p>
          ) : serverReady ? (
            <p className="text-xs text-amber-800 dark:text-amber-300">{t("autopilot.where.serverBookMissing")}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null || !serverReady} onClick={() => void run("sync", async (runtime, id) => { toast(syncToast(t, await runtime.syncWithServer(id, { push: true }))); })}>
              {busy === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}{t("autopilot.where.sync")}
            </Button>
            {choice === "browser" && (
              <Button size="sm" disabled={busy !== null || running} onClick={moveBack}>
                {busy === "move" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Laptop className="h-3.5 w-3.5" />}{t("autopilot.where.moveBack")}
              </Button>
            )}
            {choice === "browser" && !serverReady && (
              <Button size="sm" variant="ghost" disabled={busy !== null || running} onClick={moveBackWithoutDownloading}>{t("autopilot.where.discardServerWork")}</Button>
            )}
          </div>
          {githubConflicts !== null && (
            <div data-github-conflicts-notice className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <p className="flex items-start gap-1.5 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-600" aria-hidden />
                <span>{t("githubConflicts.notice.text", { count: githubConflicts })}</span>
              </p>
              <GithubConflictsAction bookId={book.id} />
            </div>
          )}
        </div>
      )}
      {sync && (
        <div ref={statusRef} role="status" tabIndex={-1} className="space-y-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <p className={cn("flex items-start gap-1.5 text-xs", sync.ok ? "text-muted-foreground" : "text-amber-800 dark:text-amber-300")}>
            <SyncIcon kind={sync.kind} />
            <span>{syncText} · {t("autopilot.where.lastSync", { time: formatDateTime(sync.at) })}</span>
          </p>
          {sync.firstSync && <p className="text-xs text-muted-foreground">{t("autopilot.where.firstSync")}</p>}
          {sync.baseSaved === false && sync.kind !== "error" && <p className="text-xs text-amber-800 dark:text-amber-300">{t("autopilot.errors.baseSaveFailed")}</p>}
        </div>
      )}
      {sync && <SyncConflicts conflicts={sync.conflictDetails} disabled={busy !== null} onResolve={settle} />}
      {sync && <SyncSkipped skipped={sync.skipped} />}
    </Card>
  );
}

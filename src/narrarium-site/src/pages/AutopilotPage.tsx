import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Ban,
  BookOpenCheck,
  CheckCircle2,
  Clapperboard,
  Cloud,
  Gauge,
  Laptop,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  Plane,
  RefreshCcw,
  Rocket,
  RotateCcw,
  Save,
  Scale,
  Server,
  Square,
  XCircle,
} from "lucide-react";
import {
  AUTOPILOT_PHASES,
  DEFAULT_BRIEF,
  DEFAULT_OPTIONS,
  autopilotProgress,
  type AutopilotActivity,
  type AutopilotBrief,
  type AutopilotOptions,
  type AutopilotState,
  type InterventionScope,
  type PlannedChapter,
} from "narrarium-engine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { AutopilotFeed, AutopilotLiveCard, AutopilotStatusBadge } from "@/components/autopilot/AutopilotFeed";
import { useAutopilotRefresh, useBookAutopilotView, useElapsed } from "@/autopilot/hooks";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { useAutopilotStore } from "@/autopilot/store";
import { formatCost, formatCount, formatDateTime, formatDuration, syncStatusText } from "@/autopilot/format";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { bookStorageMode, type BookEntry } from "@/types/settings";
import { cn } from "@/lib/utils";

const SCOPES: InterventionScope[] = ["next_step", "from_now", "rewrite"];

function Card({ title, icon, actions, children, className }: { title: string; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-3 rounded-2xl border bg-card p-4 shadow-sm sm:p-5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">{icon}{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function AutopilotPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const { settings } = useSettingsStore();
  const { branch, ready } = useWorkingBranch(bookId);
  const { book, structure, error, reload } = useBookStructure(bookId);
  const view = useBookAutopilotView(bookId);
  const live = useAutopilotStore((state) => (bookId ? state.live[bookId] ?? null : null));
  const serverStatus = useAutopilotStore((state) => state.server.status);
  const { busy, run } = useAutopilotActions(bookId);
  const host = book?.autopilotHost === "server" ? "server" : "browser";
  const canRefresh = Boolean(book && (host === "server" || (structure && ready)));
  useAutopilotRefresh(bookId, canRefresh, `${host}:${branch}`);

  const snapshot = view.snapshot;
  const loaded = Boolean(snapshot || view.error);
  const state = snapshot?.state ?? null;
  const status = state?.status;
  const controllable = Boolean(snapshot?.running) || view.busyInAnotherTab;
  const remote = !controllable && status === "running" && state?.runner ? state.runner : null;
  const running = controllable || status === "running";
  const noAi = host === "browser" && settings.aiIntegrations.length === 0;
  const existingChapters = structure?.chapters.filter((chapter) => chapter.paragraphs.length > 0).length ?? 0;

  if (error && !structure && host === "browser") return <BookStructureErrorAlert error={error} reload={reload} />;
  if (!book || !bookId) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;

  const resume = () => void run("start", (runtime, id) => runtime.start(id));
  const awaitingPlan = Boolean(state?.plan?.awaitingAuthor);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold tracking-tight"><Plane className="h-6 w-6 text-primary" />{t("autopilot.title")}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("autopilot.description")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {loaded && <AutopilotStatusBadge status={status} />}
            {state && state.phase !== "completed" && <Badge variant="outline">{t(`autopilot.phase.${state.phase}`)}</Badge>}
            <Badge variant="outline" className="gap-1">{host === "server" ? <Server className="h-3 w-3" /> : <Laptop className="h-3 w-3" />}{t(`autopilot.host.${host}`)}</Badge>
            {(view.loading || !loaded) && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 lg:max-w-sm lg:shrink-0 lg:justify-end">
          {running ? (
            <>
              <Button variant="outline" disabled={busy !== null || !controllable} onClick={() => void run("pause", (runtime, id) => runtime.pause(id, "after-step"))}>
                {busy === "pause" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}{t("autopilot.actions.pause")}
              </Button>
              <Button variant="ghost" title={t("autopilot.stopHint")} disabled={busy !== null || !controllable} onClick={() => void run("stop", (runtime, id) => runtime.pause(id, "now"))}>
                <Square className="h-4 w-4" />{t("autopilot.actions.stop")}
              </Button>
            </>
          ) : state && !state.question ? (
            <Button variant={status === "completed" ? "outline" : "default"} disabled={busy !== null || noAi} onClick={resume}>
              {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {awaitingPlan ? t("autopilot.actions.approvePlan") : t("autopilot.actions.resume")}
            </Button>
          ) : null}
          <Button asChild variant="outline"><Link to={`/app/books/${encodeURIComponent(bookId)}/director`}><Clapperboard className="h-4 w-4" />{t("autopilot.actions.director")}</Link></Button>
          <Button variant="ghost" size="icon" title={t("autopilot.actions.refresh")} aria-label={t("autopilot.actions.refresh")} disabled={!canRefresh} onClick={() => void run("refresh", (runtime, id) => runtime.refresh(id))}>
            <RefreshCcw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {noAi && <Alert><AlertTriangle className="h-4 w-4" /><AlertDescription className="flex flex-wrap items-center justify-between gap-2"><span>{t("autopilot.errors.aiMissing")}</span><Button asChild size="sm" variant="outline"><Link to="/app/settings/ai-router">AI Router</Link></Button></AlertDescription></Alert>}
      {view.error && <Alert variant="destructive"><AlertDescription>{view.error}</AlertDescription></Alert>}
      {host === "server" && (serverStatus === "offline" || serverStatus === "error") && <Alert><Cloud className="h-4 w-4" /><AlertDescription>{t("autopilot.serverOffline")}</AlertDescription></Alert>}
      {view.busyInAnotherTab && <Alert><AlertDescription>{t("autopilot.anotherTab")}</AlertDescription></Alert>}
      {remote && <Alert><AlertDescription>{t("autopilot.remoteRunner", { label: remote.label || t(`autopilot.host.${remote.host}`) })}</AlertDescription></Alert>}
      {state?.message && !running && <Alert><AlertDescription>{state.message}</AlertDescription></Alert>}
      {state?.lastError && status === "error" && (
        <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertDescription><span className="font-medium">{t("autopilot.lastError")}:</span> {state.lastError.message}</AlertDescription></Alert>
      )}

      {state?.question && <QuestionCard bookId={bookId} state={state} disabled={busy !== null || running} run={run} />}

      {running && (live ? <AutopilotLiveCard preview={live} /> : (
        <div className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin text-primary" />{t("autopilot.current.preparing")}</div>
      ))}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          {!loaded ? (
            <div className="flex items-center gap-2 rounded-2xl border bg-card p-5 text-sm text-muted-foreground shadow-sm"><Loader2 className="h-4 w-4 animate-spin" />{t("autopilot.current.loading")}</div>
          ) : !state ? (
            <SetupCard book={book} state={null} existingChapters={existingChapters} running={false} busy={busy !== null} disabled={noAi || !canRefresh} run={run} />
          ) : (
            <PlanCard bookId={bookId} state={state} structureChapters={new Set(structure?.chapters.map((chapter) => chapter.slug) ?? [])} awaitingPlan={awaitingPlan} />
          )}
          <Card title={t("autopilot.activity.title")} icon={<ListChecks className="h-4 w-4 text-primary" />}>
            <ActivityList loading={!loaded} activities={snapshot?.activities ?? []} currency={state?.stats.currency ?? settings.costCurrency} />
          </Card>
          <Card title={t("autopilot.dockLive")} icon={<Rocket className="h-4 w-4 text-primary" />}>
            <AutopilotFeed bookId={bookId} limit={120} />
          </Card>
        </div>
        <div className="min-w-0 space-y-5">
          {state && <ProgressCard state={state} />}
          {state && <InterventionCard state={state} running={running} controllable={controllable} busy={busy !== null} run={run} />}
          {state && <RulesCard state={state} />}
          <WhereCard book={book} running={running} />
          {state && <SetupCard book={book} state={state} existingChapters={existingChapters} running={running} busy={busy !== null} disabled={false} run={run} />}
          {state && !running && (
            <Button
              variant="ghost"
              className="w-full text-destructive hover:text-destructive"
              disabled={busy !== null}
              onClick={() => { if (window.confirm(t("autopilot.actions.resetConfirm"))) void run("reset", (runtime, id) => runtime.reset(id)); }}
            >
              <RotateCcw className="h-4 w-4" />{t("autopilot.actions.reset")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

type RunAction = ReturnType<typeof useAutopilotActions>["run"];

function QuestionCard({ bookId, state, disabled, run }: { bookId: string; state: AutopilotState; disabled: boolean; run: RunAction }) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState("");
  const question = state.question!;
  const send = (text: string, accept: boolean) => void run("answer", async (runtime, id) => {
    await runtime.answer(id, { questionId: question.id, answer: text, accept });
    await runtime.start(id);
  });
  return (
    <section className="space-y-3 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4 sm:p-5" aria-live="polite">
      <h2 className="flex items-center gap-2 text-base font-semibold"><Clapperboard className="h-4 w-4 text-amber-600" />{t("autopilot.question.title")}</h2>
      <p className="whitespace-pre-wrap text-sm font-medium">{question.question}</p>
      {question.context && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{question.context}</p>}
      {question.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {question.options.map((option) => <Button key={option} size="sm" variant="outline" disabled={disabled} onClick={() => send(option, false)}>{option}</Button>)}
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={`answer-${bookId}`}>{t("autopilot.question.answer")}</Label>
        <AutoTextarea id={`answer-${bookId}`} value={answer} onChange={(event) => setAnswer(event.target.value)} minRows={2} className="text-sm" disabled={disabled} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || !answer.trim()} onClick={() => send(answer.trim(), false)}><Play className="h-4 w-4" />{t("autopilot.question.send")}</Button>
        <Button variant="outline" disabled={disabled} onClick={() => send("", true)}>{t("autopilot.question.accept")}</Button>
      </div>
    </section>
  );
}

function ProgressCard({ state }: { state: AutopilotState }) {
  const { t } = useTranslation();
  const progress = autopilotProgress(state);
  const phaseIndex = AUTOPILOT_PHASES.indexOf(state.phase);
  const stats: Array<[string, string]> = [
    [t("autopilot.progress.chapters"), `${progress.chaptersDone}/${progress.chapters}`],
    [t("autopilot.progress.scenes"), `${progress.scenesWritten}/${progress.scenes}`],
    [t("autopilot.progress.words"), formatCount(progress.words)],
    [t("autopilot.progress.calls"), formatCount(state.stats.aiCalls)],
    [t("autopilot.progress.tokens"), formatCount(state.stats.inputTokens + state.stats.outputTokens)],
    [t("autopilot.progress.cost"), formatCost(state.stats.cost, state.stats.currency)],
  ];
  return (
    <Card title={t(`autopilot.phase.${state.phase}`)} icon={<Gauge className="h-4 w-4 text-primary" />}>
      <ol className="flex flex-wrap gap-1">
        {AUTOPILOT_PHASES.map((phase, index) => (
          <li key={phase} className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", index < phaseIndex ? "bg-primary/15 text-primary" : index === phaseIndex ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
            {t(`autopilot.phase.${phase}`)}
          </li>
        ))}
      </ol>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-muted/40 p-2">
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className="text-sm font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function PlanCard({ bookId, state, structureChapters, awaitingPlan }: { bookId: string; state: AutopilotState; structureChapters: Set<string>; awaitingPlan: boolean }) {
  const { t } = useTranslation();
  const plan = state.plan;
  return (
    <Card title={t("autopilot.plan.title")} icon={<BookOpenCheck className="h-4 w-4 text-primary" />}>
      {awaitingPlan && <Alert><AlertDescription>{t("autopilot.plan.awaiting")}</AlertDescription></Alert>}
      {!plan?.chapters.length ? (
        <p className="text-sm text-muted-foreground">{t("autopilot.plan.empty")}</p>
      ) : (
        <ol className="space-y-1.5">
          {plan.chapters.map((chapter) => <PlanChapter key={`${chapter.number}:${chapter.slug}`} bookId={bookId} chapter={chapter} linked={structureChapters.has(chapter.slug)} current={state.review?.chapterNumber === chapter.number} />)}
        </ol>
      )}
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
}

function PlanChapter({ bookId, chapter, linked, current }: { bookId: string; chapter: PlannedChapter; linked: boolean; current: boolean }) {
  const { t } = useTranslation();
  const statusClass = chapter.status === "done" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : chapter.status === "review" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : chapter.status === "writing" ? "bg-sky-500/15 text-sky-700 dark:text-sky-300" : "bg-muted text-muted-foreground";
  return (
    <li>
      <details className={cn("rounded-lg border", current && "border-primary/50")}>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
          <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">{chapter.number}.</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{chapter.title}</span>
          {chapter.score !== undefined && <span className="text-[11px] text-muted-foreground">{t("autopilot.plan.score", { score: chapter.score })}</span>}
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", statusClass)}>{chapter.imported ? t("autopilot.plan.imported") : t(`autopilot.plan.status.${chapter.status}`)}</span>
        </summary>
        <div className="space-y-2 border-t px-3 py-2 text-sm">
          {chapter.summary && <p className="text-muted-foreground">{chapter.summary}</p>}
          {chapter.scenes.length > 0 && (
            <ol className="space-y-1 text-xs">
              {chapter.scenes.map((scene) => (
                <li key={scene.number} className="flex gap-2">
                  <span className="w-5 shrink-0 tabular-nums text-muted-foreground">{scene.number}.</span>
                  <span className="min-w-0 flex-1"><span className="font-medium">{scene.title}</span>{scene.summary || scene.goal ? <span className="text-muted-foreground"> — {scene.summary || scene.goal}</span> : null}</span>
                  {scene.words ? <span className="shrink-0 tabular-nums text-muted-foreground">{formatCount(scene.words)}</span> : null}
                  {scene.status !== "planned" ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : null}
                </li>
              ))}
            </ol>
          )}
          {linked && <Button asChild size="sm" variant="outline"><Link to={`/app/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapter.slug)}`}>{t("common.open")}</Link></Button>}
        </div>
      </details>
    </li>
  );
}

function ActivityIcon({ activity }: { activity: AutopilotActivity }) {
  if (activity.status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  if (activity.status === "succeeded") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />;
  if (activity.status === "cancelled") return <Ban className="h-3.5 w-3.5 text-amber-600" />;
  return <XCircle className="h-3.5 w-3.5 text-red-600" />;
}

function ActivityList({ loading, activities, currency }: { loading: boolean; activities: AutopilotActivity[]; currency?: string }) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(40);
  const ordered = useMemo(() => [...activities].reverse(), [activities]);
  if (loading) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</p>;
  if (!ordered.length) return <p className="text-sm text-muted-foreground">{t("autopilot.activity.empty")}</p>;
  return (
    <div className="space-y-1.5">
      {ordered.slice(0, limit).map((activity) => <ActivityRow key={activity.id} activity={activity} currency={currency} />)}
      {ordered.length > limit && <Button variant="ghost" size="sm" className="w-full" onClick={() => setLimit((value) => value + 40)}>…</Button>}
    </div>
  );
}

function ActivityRow({ activity, currency }: { activity: AutopilotActivity; currency?: string }) {
  const { t } = useTranslation();
  const elapsed = useElapsed(activity.status === "running" ? activity.startedAt : undefined);
  const duration = activity.endedAt ? Date.parse(activity.endedAt) - Date.parse(activity.startedAt) : elapsed;
  const tokens = activity.usage ? activity.usage.inputTokens + activity.usage.outputTokens : 0;
  return (
    <details className="rounded-lg border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ActivityIcon activity={activity} />
        <span className="min-w-0 flex-1 truncate text-sm">{activity.title}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{formatDuration(duration)}</span>
      </summary>
      <div className="space-y-1.5 border-t px-3 py-2 text-xs">
        {activity.summary && <p className="whitespace-pre-wrap">{activity.summary}</p>}
        {activity.error && <p className="whitespace-pre-wrap text-destructive">{activity.error}</p>}
        {activity.reason && <p className="text-muted-foreground"><span className="font-medium text-foreground/80">{t("autopilot.why")}:</span> {activity.reason}</p>}
        {activity.next && <p className="text-muted-foreground"><span className="font-medium text-foreground/80">{t("autopilot.next")}:</span> {activity.next}</p>}
        <p className="text-muted-foreground">
          {formatDateTime(activity.startedAt)} · {t(`autopilot.activity.status.${activity.status}`)}
          {activity.model ? ` · ${activity.model}` : ""}
          {tokens ? ` · ${formatCount(tokens)} ${t("autopilot.progress.tokens").toLowerCase()}` : ""}
          {activity.cost ? ` · ${formatCost(activity.cost, currency)}` : ""}
          {activity.host ? ` · ${t(`autopilot.host.${activity.host}`)}` : ""}
        </p>
        {activity.changedPaths && activity.changedPaths.length > 0 && (
          <div>
            <p className="font-medium">{t("autopilot.activity.changed")}</p>
            <ul className="mt-0.5 space-y-0.5 font-mono text-[11px] text-muted-foreground">{activity.changedPaths.map((path) => <li key={path} className="break-all">{path}</li>)}</ul>
          </div>
        )}
      </div>
    </details>
  );
}

function InterventionCard({ state, running, controllable, busy, run }: { state: AutopilotState; running: boolean; controllable: boolean; busy: boolean; run: RunAction }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [scope, setScope] = useState<InterventionScope>("next_step");
  const history = useMemo(() => [...state.interventions].reverse(), [state.interventions]);
  const submit = async (mode: "record" | "continue" | "interrupt") => {
    const ok = await run("intervene", async (runtime, id) => {
      await runtime.intervene(id, { scope, text: text.trim(), interrupt: mode === "interrupt" });
      if (mode === "continue") await runtime.start(id);
    }, t("autopilot.intervention.recorded"));
    if (ok) setText("");
  };
  const blocked = busy || !text.trim() || (running && !controllable);
  return (
    <Card title={t("autopilot.intervention.title")} icon={<MessageSquarePlus className="h-4 w-4 text-primary" />}>
      <p className="text-xs text-muted-foreground">{t("autopilot.intervention.description")}</p>
      <AutoTextarea value={text} onChange={(event) => setText(event.target.value)} minRows={3} placeholder={t("autopilot.intervention.placeholder")} className="text-sm" />
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
            {!state.question && <Button size="sm" disabled={blocked} onClick={() => void submit("continue")}><Play className="h-3.5 w-3.5" />{t("autopilot.intervention.recordAndContinue")}</Button>}
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
    </Card>
  );
}

function RulesCard({ state }: { state: AutopilotState }) {
  const { t } = useTranslation();
  const list = (items: string[]) => items.length ? <ul className="list-disc space-y-1 pl-5 text-sm">{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="text-sm text-muted-foreground">{t("autopilot.rules.none")}</p>;
  return (
    <Card title={t("autopilot.rules.title")} icon={<Scale className="h-4 w-4 text-primary" />}>
      <div className="space-y-1"><p className="text-xs font-medium text-muted-foreground">{t("autopilot.rules.constraints")}</p>{list(state.constraints)}</div>
      <div className="space-y-1"><p className="text-xs font-medium text-muted-foreground">{t("autopilot.rules.directorNotes")}</p>{list(state.directorNotes)}</div>
    </Card>
  );
}

function WhereCard({ book, running }: { book: BookEntry; running: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { save } = useSettings();
  const server = useAutopilotStore((state) => state.server);
  const view = useBookAutopilotView(book.id);
  const { busy, run } = useAutopilotActions(book.id);
  const host = book.autopilotHost === "server" ? "server" : "browser";
  const [choice, setChoice] = useState<"browser" | "server">(host);
  const [consentAi, setConsentAi] = useState(true);
  const [consentGithub, setConsentGithub] = useState(true);
  const github = bookStorageMode(book) === "github";
  const serverReady = server.status === "online";
  const serverBook = view.server;
  useEffect(() => setChoice(host), [host]);

  const setHost = async (next: "browser" | "server") => {
    const store = useSettingsStore.getState();
    store.patchSettings({ books: store.settings.books.map((entry) => entry.id === book.id ? { ...entry, autopilotHost: next === "server" ? "server" : undefined } : entry) });
    await save();
  };
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
  const syncText = syncStatusText(t, view.sync);

  return (
    <Card title={t("autopilot.where.title")} icon={<Server className="h-4 w-4 text-primary" />}>
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
        !serverReady ? (
          <p className="text-xs text-muted-foreground">{t("autopilot.where.noServer")} <Link className="underline" to="/app/settings/server">{t("personalServer.title")}</Link></p>
        ) : (
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={consentAi} onChange={(event) => setConsentAi(event.target.checked)} />{t("autopilot.where.consentAi")}</label>
            {github && <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={consentGithub} onChange={(event) => setConsentGithub(event.target.checked)} />{t("autopilot.where.consentGithub")}</label>}
            <Button size="sm" disabled={busy !== null || running || (github && !consentGithub && !serverBook?.hasGithubToken)} onClick={move}>
              {busy === "move" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Server className="h-3.5 w-3.5" />}{t("autopilot.where.move")}
            </Button>
          </div>
        )
      )}
      {host === "server" && (
        <div className="space-y-2">
          {serverBook ? (
            <p className="text-xs text-muted-foreground">{t("autopilot.where.serverBook", { status: serverBook.autopilot ? t(`autopilot.status.${serverBook.autopilot.status}`) : t("autopilot.notStarted") })}{serverBook.lastSync ? ` · ${serverBook.lastSync.message}` : ""}</p>
          ) : serverReady ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">{t("autopilot.where.serverBookMissing")}</p>
          ) : null}
          {syncText && <p className={cn("text-xs", view.sync?.ok ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300")}>{syncText}{view.sync ? ` · ${t("autopilot.where.lastSync", { time: formatDateTime(view.sync.at) })}` : ""}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null || !serverReady} onClick={() => void run("sync", (runtime, id) => runtime.syncWithServer(id, { push: true }), t("autopilot.where.synced"))}>
              {busy === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}{t("autopilot.where.sync")}
            </Button>
            {choice === "browser" && (
              <Button size="sm" disabled={busy !== null || running} onClick={moveBack}>
                {busy === "move" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Laptop className="h-3.5 w-3.5" />}{t("autopilot.where.moveBack")}
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

interface SetupForm {
  brief: AutopilotBrief;
  options: AutopilotOptions;
}

function NumberField({ id, label, value, min, max, step = 1, disabled, onChange }: { id: string; label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const parse = (raw: string) => (raw.trim() === "" ? Number.NaN : Number(raw));
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        disabled={disabled}
        className="h-9"
        onChange={(event) => {
          setText(event.target.value);
          const parsed = parse(event.target.value);
          if (Number.isFinite(parsed) && parsed >= min && parsed <= max) onChange(parsed);
        }}
        onBlur={(event) => {
          const parsed = parse(event.target.value);
          const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
          setText(String(next));
          if (next !== value) onChange(next);
        }}
      />
    </div>
  );
}

function SetupCard({ book, state, existingChapters, running, busy, disabled, run }: { book: BookEntry; state: AutopilotState | null; existingChapters: number; running: boolean; busy: boolean; disabled: boolean; run: RunAction }) {
  const { t } = useTranslation();
  const initial = useMemo<SetupForm>(() => state
    ? { brief: state.brief, options: state.options }
    : { brief: { ...DEFAULT_BRIEF, targetChapters: Math.max(DEFAULT_BRIEF.targetChapters, existingChapters + 1) }, options: { ...DEFAULT_OPTIONS, syncAfterChapter: bookStorageMode(book) === "github" } }, [state, existingChapters, book]);
  const [form, setForm] = useState<SetupForm>(initial);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setForm(initial);
  }, [initial, dirty]);

  const brief = (patch: Partial<AutopilotBrief>) => { setForm((current) => ({ ...current, brief: { ...current.brief, ...patch } })); setDirty(true); };
  const options = (patch: Partial<AutopilotOptions>) => { setForm((current) => ({ ...current, options: { ...current.options, ...patch } })); setDirty(true); };
  const locked = running || busy;
  const fresh = !state;

  const toggles: Array<[keyof AutopilotOptions, string]> = [
    ["readers", t("autopilot.setup.readers")],
    ["readersOnPlan", t("autopilot.setup.readersOnPlan")],
    ["specialists", t("autopilot.setup.specialists")],
    ["pauseAfterPlan", t("autopilot.setup.pauseAfterPlan")],
    ["pauseAfterEachChapter", t("autopilot.setup.pauseAfterEachChapter")],
    ...(bookStorageMode(book) === "github" ? [["syncAfterChapter", t("autopilot.setup.syncAfterChapter")] as [keyof AutopilotOptions, string]] : []),
  ];

  const body = (
    <div className="space-y-4">
      {fresh && <p className="text-sm text-muted-foreground">{existingChapters > 0 ? t("autopilot.setup.existingBook") : t("autopilot.setup.description")}</p>}
      {running && <p className="text-xs text-muted-foreground">{t("autopilot.setup.lockedWhileRunning")}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="autopilot-idea">{t("autopilot.setup.idea")}</Label>
        <AutoTextarea id="autopilot-idea" value={form.brief.idea} onChange={(event) => brief({ idea: event.target.value })} minRows={fresh ? 3 : 2} placeholder={t("autopilot.setup.ideaPlaceholder")} className="text-sm" disabled={locked} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="autopilot-synopsis">{t("autopilot.setup.synopsis")}</Label>
        <AutoTextarea id="autopilot-synopsis" value={form.brief.synopsis} onChange={(event) => brief({ synopsis: event.target.value })} minRows={2} placeholder={t("autopilot.setup.synopsisPlaceholder")} className="text-sm" disabled={locked} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <NumberField id="autopilot-chapters" label={t("autopilot.setup.chapters")} value={form.brief.targetChapters} min={1} max={200} disabled={locked} onChange={(value) => brief({ targetChapters: value })} />
        <NumberField id="autopilot-scenes" label={t("autopilot.setup.scenes")} value={form.brief.scenesPerChapter} min={1} max={20} disabled={locked} onChange={(value) => brief({ scenesPerChapter: value })} />
        <NumberField id="autopilot-words" label={t("autopilot.setup.words")} value={form.brief.wordsPerScene} min={200} max={8000} step={100} disabled={locked} onChange={(value) => brief({ wordsPerScene: value })} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="autopilot-genre" className="text-xs">{t("autopilot.setup.genre")}</Label><Input id="autopilot-genre" className="h-9" value={form.brief.genre} disabled={locked} onChange={(event) => brief({ genre: event.target.value })} /></div>
        <div className="space-y-1"><Label htmlFor="autopilot-audience" className="text-xs">{t("autopilot.setup.audience")}</Label><Input id="autopilot-audience" className="h-9" value={form.brief.audience} disabled={locked} onChange={(event) => brief({ audience: event.target.value })} /></div>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t("autopilot.setup.options")}</p>
        {toggles.map(([key, label]) => (
          <label key={key} className="flex items-center justify-between gap-3 text-sm">
            <span>{label}</span>
            <Switch checked={Boolean(form.options[key])} disabled={locked} onCheckedChange={(checked) => options({ [key]: checked } as Partial<AutopilotOptions>)} />
          </label>
        ))}
        <div className="grid grid-cols-2 gap-3 pt-1 sm:grid-cols-3">
          <NumberField id="autopilot-readers" label={t("autopilot.setup.maxReaders")} value={form.options.maxReaders} min={1} max={20} disabled={locked} onChange={(value) => options({ maxReaders: value })} />
          <NumberField id="autopilot-per-run" label={t("autopilot.setup.chaptersPerRun")} value={form.options.chaptersPerRun} min={0} max={200} disabled={locked} onChange={(value) => options({ chaptersPerRun: value })} />
          <NumberField id="autopilot-budget" label={t("autopilot.setup.budget")} value={form.options.budgetLimit} min={0} max={1_000_000} step={0.5} disabled={locked} onChange={(value) => options({ budgetLimit: value })} />
        </div>
        <p className="text-xs text-muted-foreground">{t("autopilot.setup.budgetHint")} {t("autopilot.modelHint")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {fresh ? (
          <Button disabled={locked || disabled} onClick={() => void run("start", (runtime, id) => runtime.start(id, { brief: form.brief, options: form.options })).then((ok) => { if (ok) setDirty(false); })}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}{t("autopilot.actions.start")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={locked || !dirty} onClick={() => void run("configure", (runtime, id) => runtime.configure(id, { brief: form.brief, options: form.options }), t("autopilot.setup.saved")).then((ok) => { if (ok) setDirty(false); })}>
            <Save className="h-3.5 w-3.5" />{t("autopilot.setup.save")}
          </Button>
        )}
      </div>
    </div>
  );

  if (fresh) return <Card title={t("autopilot.setup.title")} icon={<Rocket className="h-4 w-4 text-primary" />}>{body}</Card>;
  return (
    <details className="rounded-2xl border bg-card shadow-sm">
      <summary className="cursor-pointer list-none p-4 text-base font-semibold sm:p-5 [&::-webkit-details-marker]:hidden">{t("autopilot.setup.settingsTitle")}</summary>
      <div className="px-4 pb-4 sm:px-5 sm:pb-5">{body}</div>
    </details>
  );
}

import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Github, Loader2, Play, Rocket, Save, RotateCcw } from "lucide-react";
import { DEFAULT_BRIEF, DEFAULT_OPTIONS, FROZEN_EDITS_MODES, autopilotPresetSkeleton, effectivePublish, type AutopilotBrief, type AutopilotLiveOptions, type AutopilotOptions, type AutopilotPublishMode, type AutopilotState, type StartOptions } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfigOverview } from "@/components/autopilot/config/ConfigOverview";
import { ConfigTabs, type ConfigTab } from "@/components/autopilot/config/ConfigTabs";
import { NumberField } from "@/components/autopilot/config/NumberField";
import { BookRunPreview } from "@/components/autopilot/config/RunPreview";
import { OperationNotice } from "@/components/autopilot/OperationNotice";
import { RetryLaterCard, readRetryLater, retryLaterForm, sameLongRetry, type RetryLaterCardHandle, type RetryLaterForm } from "@/components/autopilot/config/RetryLaterCard";
import type { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { FROZEN_SERVER_VERSION } from "@/autopilot/frozenChapters";
import type { OutlineBrief } from "@/autopilot/outlineBrief";
import type { OutlineBriefOfBook } from "@/autopilot/useOutlineBrief";
import type { BookStructure } from "@/types/book";
import { bookStorageMode, type BookEntry } from "@/types/settings";
import { cn } from "@/lib/utils";
import { OUTLINE_BRIEF_NOTICE_ID } from "@/autopilot/outlineBrief";
import { autoResumeOn, setAutoResume } from "@/autopilot/resume";
import "@/i18n/autopilotCallsSettings";

// The tab of the AI calls is a chunk of its own: nothing of it is loaded until the tab is drawn.
const AiCallsCard = lazy(() => import("@/components/autopilot/config/AiCallsCard"));

type RunAction = ReturnType<typeof useAutopilotActions>["run"];

// A typo guard, not a product limit: a book has no maximum number of chapters. The engine accepts the same range.
const MAX_CHAPTERS = 100_000;
// The same kind of guard for the token budget: a trillion tokens is more than any book will ever use, and a typo stays a typo.
const MAX_BUDGET_TOKENS = 1_000_000_000_000;

/** Where the book can be published, in the order the choice lists them: the most often first. */
const PUBLISH_MODES: readonly AutopilotPublishMode[] = ["step", "chapter", "off"];

/** The switches of the review: whether the run can change them while it goes on is said by `live`. */
const REVIEW_SWITCHES: Array<{ key: "readers" | "readersOnPlan" | "specialists" | "pauseAfterPlan" | "pauseAfterEachChapter"; live?: boolean }> = [
  { key: "readers" },
  { key: "readersOnPlan" },
  { key: "specialists" },
  { key: "pauseAfterPlan" },
  { key: "pauseAfterEachChapter", live: true },
];

export interface SetupCardProps {
  book: BookEntry;
  state: AutopilotState | null;
  /** The autopilot runs (here or elsewhere): only what can change during a run can be changed. */
  running: boolean;
  /** Something holds the book: an action of the page, the live panel or another tab. */
  busy: boolean;
  /** The autopilot cannot be started from here (no AI model, the book is not ready). */
  disabled: boolean;
  /** The director waits for an answer, which is given on the live page: the autopilot is not started from here then. */
  asking?: boolean;
  /** The autopilot runs on a personal server that cannot change its settings during a run (it predates the quick controls). */
  liveUnsupported?: boolean;
  /** The autopilot runs on a personal server that predates the frozen chapters: what it does with a changed one cannot be chosen. */
  frozenUnsupported?: boolean;
  /** The autopilot runs on a personal server that predates «Retry later»: it is shown off, and cannot be chosen. */
  retryUnsupported?: boolean;
  /** The autopilot runs on a personal server that resumes a run by itself after it restarts: the switch «Resume after a restart» is shown, and sent. */
  autoResume?: boolean;
  /** The personal server is too old to take the length of the book from its Scaletta: Save and Start are disabled, and the alert above says why. */
  outlineBriefUnsupported?: boolean;
  /** The run waits for a restart of «Retry later» now: turning it off would stop it, and the card says so beforehand. */
  waitingLong?: boolean;
  run: RunAction;
  /** Once the autopilot has started: the page opens the live page. */
  onStarted?: () => void;
  /** The brief and the chapter entries of the Scaletta, read by the page: what the run is started with. */
  outline: OutlineBriefOfBook;
  /** The part of the configuration that is selected, and the choice of another one. */
  tab: string;
  onTab: (key: string) => void;
  /** The reset of the autopilot: the bar at the top and the danger zone take it, with the same confirmation. */
  onReset: () => void;
  /** The permanent rules, the profiles and the danger zone: the page draws them, the tabs hold them. */
  rules?: ReactNode;
  profiles: ReactNode;
  danger?: ReactNode;
  /** The working branch and the structure of the book: what the preview of the run reads the book's files and chapters from. Without the branch there is no preview. */
  branch?: string;
  structure?: BookStructure;
}

/**
 * The configuration of the autopilot, in tabs: the overview (the state, and the Scaletta's brief and chapters, read only), the review (the simulated
 * readers, the specialists, the pauses, the sessions and the budgets, the frozen chapters), the retries («Retry later», and «Resume after a restart» for
 * a server that has it), publishing (on GitHub, every step, every chapter or never), the rules, the profiles and the danger zone. The options are saved
 * with the bar at the top («Salva»: `configure` while the autopilot is stopped, `updateOptions` for what can change during a run); «Azzera» is the reset.
 * The start button at the bottom starts the autopilot with the brief of the Scaletta (for a book that never started) or resumes it, and `onStarted`
 * takes the author to the live page. Values of «Retry later» the server would refuse are never sent: the card says what is wrong instead.
 */
export function SetupCard({ book, state, running, busy, disabled, asking = false, liveUnsupported = false, frozenUnsupported = false, retryUnsupported = false, autoResume = false, outlineBriefUnsupported = false, waitingLong = false, run, onStarted, outline, tab, onTab, onReset, rules, profiles, danger, branch, structure }: SetupCardProps) {
  const { t } = useTranslation();
  const github = bookStorageMode(book) === "github";
  const host = book.autopilotHost === "server" ? "server" : "browser";
  // «Resume by itself after a restart» of this browser: a choice of this device, on unless the author turned it off, saved at once.
  const [browserResume, setBrowserResume] = useState(() => autoResumeOn(book.id));
  useEffect(() => { setBrowserResume(autoResumeOn(book.id)); }, [book.id]);
  const fresh = !state;
  const initial = useMemo<AutopilotOptions>(() => state
    ? state.options
    : { ...DEFAULT_OPTIONS, syncAfterChapter: github, ...(book.startPreset ? autopilotPresetSkeleton(book.startPreset)?.options : {}) }, [state, github, book.startPreset]);
  const [options, setOptions] = useState<AutopilotOptions>(initial);
  const [retry, setRetry] = useState<RetryLaterForm>(() => retryLaterForm(initial.longRetry));
  const [dirty, setDirty] = useState(false);
  const retryCard = useRef<RetryLaterCardHandle>(null);
  useEffect(() => {
    if (dirty) return;
    setOptions(initial);
    setRetry(retryLaterForm(initial.longRetry));
  }, [initial, dirty]);

  // What the run is started with: the Scaletta's brief and its chapter entries. Without a readable Scaletta the words of the state (or the defaults) stand.
  const fallback: AutopilotBrief = state?.brief ?? DEFAULT_BRIEF;
  // Nothing is saved or started before the Scaletta is read, and never without it: the brief would be lost.
  const ready = outline.loaded && outline.readable;
  // A book with no chapter entries and no plan has nothing to write: the start says why and is not offered. Nothing stands in for the chapters.
  const noChapters = ready && outline.lastChapter === 0 && !(state?.plan?.chapters.length);
  const noChaptersId = "autopilot-no-chapters";
  const startDescribedBy = [outlineBriefUnsupported ? OUTLINE_BRIEF_NOTICE_ID : undefined, noChapters ? noChaptersId : undefined].filter(Boolean).join(" ") || undefined;
  const brief = useMemo<AutopilotBrief>(() => {
    const written: OutlineBrief | null = ready ? outline.brief : null;
    return {
      idea: written ? written.idea : fallback.idea,
      synopsis: written ? written.synopsis : fallback.synopsis,
      genre: written ? written.genre : fallback.genre,
      audience: written ? written.audience : fallback.audience,
      wordsPerScene: written ? written.wordsPerScene : fallback.wordsPerScene,
    };
  }, [outline, state, ready, fallback]);

  const patchOptions = (patch: Partial<AutopilotOptions>) => { setOptions((current) => ({ ...current, ...patch })); setDirty(true); };
  const retryChange = (next: RetryLaterForm) => { setRetry(next); setDirty(true); };
  // While a run goes on, only where the book is published and the pause after every chapter can change (not on a server that predates it).
  const locked = running || busy;
  const liveLocked = busy || (running && liveUnsupported);
  const frozenLocked = liveLocked || frozenUnsupported;
  // Asked every time unless the author chose otherwise: a state written before the option existed has none.
  const frozenEdits = options.frozenEdits ?? "ask";
  // What the host does when the author has not chosen: a server publishes after every step, this browser as the older switch says.
  const publish = effectivePublish(options, host === "server" ? "step" : undefined);
  const retryReading = readRetryLater(retry);
  // «Retry later» changed when the policy is not the one the state has; a server without it is never sent it.
  const retryChanged = !retryUnsupported && !sameLongRetry(retryReading.policy, initial.longRetry);
  // «Resume after a restart»: off unless the author turned it on, and only a server that has it is sent it.
  const resumeOn = options.resumeAfterRestart === true;
  const resumeChanged = autoResume && resumeOn !== (initial.resumeAfterRestart === true);

  /** The settings that can change during a run, as far as the author changed them. */
  const liveChanges = (): AutopilotLiveOptions => ({
    ...(options.publishEvery !== undefined && options.publishEvery !== initial.publishEvery ? { publishEvery: options.publishEvery } : {}),
    ...(options.pauseAfterEachChapter !== initial.pauseAfterEachChapter ? { pauseAfterEachChapter: options.pauseAfterEachChapter } : {}),
    ...(options.frozenEdits !== undefined && options.frozenEdits !== initial.frozenEdits ? { frozenEdits: options.frozenEdits } : {}),
    ...(retryChanged ? { longRetry: retryReading.policy } : {}),
    ...(resumeChanged ? { resumeAfterRestart: resumeOn } : {}),
  });

  /**
   * The options with «Retry later» as the card says (the policy, `null` to turn off one the book had, as `StartOptions` takes it, and nothing
   * when it stays off) and «Resume after a restart» as the switch says, `true` or `false`, for a server that has it and for no other host.
   */
  const sentOptions = (): StartOptions["options"] => {
    const { longRetry: _saved, resumeAfterRestart: _resume, ...plain } = options;
    const rest = autoResume ? { ...plain, resumeAfterRestart: resumeOn } : plain;
    return retryUnsupported ? rest : retryReading.policy ? { ...rest, longRetry: retryReading.policy } : initial.longRetry ? { ...rest, longRetry: null } : rest;
  };

  /** Whether «Retry later» can be sent as it is; when it cannot, the card shows what is wrong and takes the focus there. */
  const retryReady = (): boolean => {
    if (retryUnsupported || retryReading.valid) return true;
    retryCard.current?.showProblems();
    return false;
  };

  const save = () => {
    if (!running && !ready) return;
    if (!retryReady()) return;
    const changes = liveChanges();
    // During a run only the settings that can change are sent, and nothing when they are as they were (a server refuses an empty change).
    if (running && Object.keys(changes).length === 0) {
      setDirty(false);
      return;
    }
    const action = running
      ? run("options", (runtime, id) => runtime.updateOptions(id, changes), t("autopilot.setup.saved"))
      : run("configure", (runtime, id) => runtime.configure(id, { brief, options: sentOptions() }), t("autopilot.setup.saved"));
    void action.then((ok) => { if (ok) setDirty(false); });
  };

  const completed = state?.status === "completed";
  // The Scaletta asks for more chapters than the plan has: resuming extends the plan, so the button says it writes them.
  const extending = completed && Boolean(state?.plan && outline.lastChapter > state.plan.chapters.length);
  const startLabel = fresh
    ? t("autopilot.actions.start")
    : extending
      ? t("autopilot.actions.writeNewChapters")
      : state?.plan?.awaitingAuthor
        ? t("autopilot.actions.approvePlan")
        : state?.status === "error"
          ? t("autopilot.actions.retry")
          : t("autopilot.actions.resume");
  const canStart = !running && !asking && (fresh || !completed || extending);
  const start = () => {
    if (!ready || !retryReady()) return;
    void run("start", async (runtime, id) => {
      if (fresh) {
        await runtime.start(id, { brief, options: sentOptions() });
        return;
      }
      // What the author changed is saved first: the run starts with it.
      if (dirty) await runtime.configure(id, { brief, options: sentOptions() });
      await runtime.start(id);
    }).then((ok) => {
      if (!ok) return;
      setDirty(false);
      onStarted?.();
    });
  };

  const [callsOpened, setCallsOpened] = useState(tab === "calls");
  useEffect(() => { if (tab === "calls") setCallsOpened(true); }, [tab]);
  const previewForm = useMemo(() => ({ brief, options }), [brief, options]);
  const tabs: ConfigTab[] = [
    {
      key: "overview",
      label: t("autopilot.config.tabs.overview"),
      panel: (
        <ConfigOverview
          bookId={book.id}
          state={state}
          fresh={fresh}
          brief={outline.brief}
          chapters={outline.chapters}
          readable={outline.readable}
          loaded={outline.loaded}
          lastChapter={outline.lastChapter}
          noChapters={noChapters}
          preview={branch !== undefined && <BookRunPreview book={book} branch={branch} structure={structure} state={state} form={previewForm} dirty={dirty} scaletta={`${outline.chapters}/${outline.lastChapter}/${outline.loaded}`} />}
        />
      ),
    },
    {
      key: "review",
      label: t("autopilot.config.tabs.review"),
      panel: (
        <div className="space-y-5">
          <div className="space-y-2">
            {REVIEW_SWITCHES.map(({ key, live }) => (
              <label key={key} className="flex items-center justify-between gap-3 text-sm">
                <span>{t(`autopilot.setup.${key}`)}</span>
                <Switch checked={Boolean(options[key])} disabled={live ? liveLocked : locked} onCheckedChange={(checked) => patchOptions({ [key]: checked })} />
              </label>
            ))}
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{t("autopilot.setup.fillOutline")}</span>
              {/* On unless the author turned it off: a state written before the option existed has none. */}
              <Switch checked={options.fillOutline !== false} disabled={locked} onCheckedChange={(checked) => patchOptions({ fillOutline: checked })} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField id="autopilot-readers" label={t("autopilot.setup.maxReaders")} value={options.maxReaders} min={1} max={20} disabled={locked} onChange={(value) => patchOptions({ maxReaders: value })} />
            <NumberField id="autopilot-per-run" label={t("autopilot.setup.chaptersPerRun")} value={options.chaptersPerRun} min={0} max={MAX_CHAPTERS} disabled={locked} onChange={(value) => patchOptions({ chaptersPerRun: value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField id="autopilot-budget" label={t("autopilot.setup.budget")} value={options.budgetLimit} min={0} max={1_000_000} step={0.5} disabled={locked} describedBy="autopilot-budget-hint" onChange={(value) => patchOptions({ budgetLimit: value })} />
            <NumberField id="autopilot-budget-tokens" label={t("autopilot.setup.budgetTokens")} value={options.budgetTokens ?? 0} min={0} max={MAX_BUDGET_TOKENS} step={1000} disabled={locked} describedBy="autopilot-budget-tokens-hint" onChange={(value) => patchOptions({ budgetTokens: value })} />
          </div>
          <p id="autopilot-budget-hint" className="text-xs text-muted-foreground">{t("autopilot.setup.budgetHint")}</p>
          <p id="autopilot-budget-tokens-hint" className="text-xs text-muted-foreground">{t("autopilot.setup.budgetTokensHint")}</p>
          <fieldset className="space-y-2 pt-1" disabled={frozenLocked} aria-describedby="autopilot-frozen-edits-hint">
            <legend className="text-sm font-medium">{t("autopilot.config.frozenEdits.title")}</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {FROZEN_EDITS_MODES.map((mode) => (
                <div key={mode} className={cn("rounded-lg border p-2 transition", frozenEdits === mode ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40")}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                    <input type="radio" name="autopilot-frozen-edits" className="h-4 w-4 accent-primary" value={mode} checked={frozenEdits === mode} aria-describedby={`autopilot-frozen-edits-${mode}`} onChange={() => patchOptions({ frozenEdits: mode })} />
                    {t(`autopilot.config.frozenEdits.${mode}`)}
                  </label>
                  <p id={`autopilot-frozen-edits-${mode}`} className="mt-1 text-xs text-muted-foreground">{t(`autopilot.config.frozenEdits.${mode}Help`)}</p>
                </div>
              ))}
            </div>
            <p id="autopilot-frozen-edits-hint" className="text-xs text-muted-foreground">{frozenUnsupported ? t("autopilot.config.frozenEdits.oldServer", { version: FROZEN_SERVER_VERSION }) : t("autopilot.config.frozenEdits.hint")}</p>
          </fieldset>
        </div>
      ),
    },
    {
      key: "retries",
      label: t("autopilot.config.tabs.retries"),
      panel: (
        <RetryLaterCard
          ref={retryCard}
          form={retry}
          onChange={retryChange}
          locked={liveLocked}
          unsupported={retryUnsupported}
          running={running}
          waitingLong={waitingLong}
          autoResume={autoResume ? { on: resumeOn, onChange: (on) => patchOptions({ resumeAfterRestart: on }) } : undefined}
          browserResume={host === "browser" ? { on: browserResume, onChange: (on) => { setAutoResume(book.id, on); setBrowserResume(on); } } : undefined}
        />
      ),
    },
    {
      key: "publishing",
      label: t("autopilot.config.tabs.publishing"),
      panel: github ? (
        <fieldset className="space-y-2" disabled={liveLocked} aria-describedby="autopilot-publish-hint">
          <legend className="text-sm font-medium">{t("autopilot.quick.publish.heading")}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {PUBLISH_MODES.map((mode) => (
              <label key={mode} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border p-2 text-sm transition", publish === mode ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40")}>
                <input type="radio" name="autopilot-publish" className="h-4 w-4 accent-primary" value={mode} checked={publish === mode} onChange={() => patchOptions({ publishEvery: mode, syncAfterChapter: mode !== "off" })} />
                {t(`autopilot.quick.publish.choice.${mode}`)}
              </label>
            ))}
          </div>
          <p id="autopilot-publish-hint" className="text-xs text-muted-foreground">{t("autopilot.quick.publish.applies")}</p>
        </fieldset>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Github className="h-4 w-4" aria-hidden="true" />{t("autopilot.config.publishLocal")}</p>
      ),
    },
  ];
  // It checks the connection of the place it copies to: that is done when the tab is first opened, not on every visit to the settings.
  tabs.push({ key: "calls", label: t("autopilot.callsSettings.tab"), panel: callsOpened ? <Suspense fallback={<Loader2 className="h-4 w-4 animate-spin" aria-label={t("autopilot.current.loading")} />}><AiCallsCard book={book} /></Suspense> : null });
  if (rules) tabs.push({ key: "rules", label: t("autopilot.config.tabs.rules"), panel: rules });
  tabs.push({ key: "profiles", label: t("autopilot.config.tabs.profiles"), panel: profiles });
  if (danger) tabs.push({ key: "danger", label: t("autopilot.config.tabs.danger"), panel: danger });

  return (
    <div className="space-y-5">
      {!fresh && (
        <div data-autopilot-bar className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center justify-between gap-2 border-b bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy || !dirty || (!running && !ready) || outlineBriefUnsupported} aria-describedby={outlineBriefUnsupported ? OUTLINE_BRIEF_NOTICE_ID : undefined} onClick={save}>
              <Save className="h-4 w-4" aria-hidden="true" />{t("autopilot.setup.save")}
            </Button>
            {state && !running && (
              <Button variant="outline" disabled={busy} onClick={onReset}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />{t("autopilot.actions.reset")}
              </Button>
            )}
          </div>
          {dirty && <span className="text-xs font-medium text-muted-foreground">{t("autopilot.config.unsaved")}</span>}
        </div>
      )}

      <ConfigTabs label={t("autopilot.config.tabsLabel")} tabs={tabs} selected={tab} onSelect={onTab} />

      <div data-autopilot-start className={cn("space-y-2", (canStart || (completed && !running && !asking)) && "border-t pt-4")}>
        {canStart ? (
          <>
            <Button disabled={busy || disabled || !ready || noChapters || outlineBriefUnsupported} aria-describedby={startDescribedBy} onClick={start}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : fresh ? <Rocket className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}{startLabel}
            </Button>
            {noChapters && <p id={noChaptersId} className="text-sm font-medium">{t("autopilot.config.overview.noChapters")}</p>}
          </>
        ) : completed && !running && !asking ? (
          <p className="text-sm text-muted-foreground">{t("autopilot.config.completeHint")}</p>
        ) : null}
        <OperationNotice bookId={book.id} />
      </div>
    </div>
  );
}

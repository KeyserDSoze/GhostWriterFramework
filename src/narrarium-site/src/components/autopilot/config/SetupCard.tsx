import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { BookOpen, Github, Loader2, Play, Rocket, Save, ScanSearch } from "lucide-react";
import { DEFAULT_BRIEF, DEFAULT_OPTIONS, FROZEN_EDITS_MODES, effectivePublish, type AutopilotBrief, type AutopilotLiveOptions, type AutopilotOptions, type AutopilotPublishMode, type AutopilotState, type StartOptions } from "narrarium-engine";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/autopilot/Card";
import { PresetPicker } from "@/components/autopilot/config/PresetPicker";
import { BookRunPreview } from "@/components/autopilot/config/RunPreview";
import { OperationNotice } from "@/components/autopilot/OperationNotice";
import { RetryLaterCard, readRetryLater, retryLaterForm, sameLongRetry, type RetryLaterCardHandle, type RetryLaterForm } from "@/components/autopilot/config/RetryLaterCard";
import type { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { FROZEN_SERVER_VERSION } from "@/autopilot/frozenChapters";
import { applyPreset, presetOfForm } from "@/autopilot/runEstimate";
import type { BookStructure } from "@/types/book";
import { bookStorageMode, type BookEntry } from "@/types/settings";
import { cn } from "@/lib/utils";

type RunAction = ReturnType<typeof useAutopilotActions>["run"];

// A typo guard, not a product limit: a book has no maximum number of chapters. The engine accepts the same range.
const MAX_CHAPTERS = 100_000;
// The same kind of guard for the token budget: a trillion tokens is more than any book will ever use, and a typo stays a typo.
const MAX_BUDGET_TOKENS = 1_000_000_000_000;

/** Where the book can be published, in the order the choice lists them: the most often first. */
const PUBLISH_MODES: readonly AutopilotPublishMode[] = ["step", "chapter", "off"];

interface SetupForm {
  brief: AutopilotBrief;
  options: AutopilotOptions;
}

/** The switches of the review: whether the run can change them while it goes on is said by `live`. */
const REVIEW_SWITCHES: Array<{ key: "readers" | "readersOnPlan" | "specialists" | "pauseAfterPlan" | "pauseAfterEachChapter"; live?: boolean }> = [
  { key: "readers" },
  { key: "readersOnPlan" },
  { key: "specialists" },
  { key: "pauseAfterPlan" },
  { key: "pauseAfterEachChapter", live: true },
];

function NumberField({ id, label, value, min, max, step = 1, disabled, describedBy, onChange }: { id: string; label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; describedBy?: string; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const parse = (raw: string) => (raw.trim() === "" ? Number.NaN : Number(raw));
  return (
    // The label may take two lines where the field is narrow: the fields of a row stay on one line, whatever their labels do.
    <div className="flex h-full flex-col justify-between gap-1">
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
        aria-describedby={describedBy}
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

export interface SetupCardProps {
  book: BookEntry;
  state: AutopilotState | null;
  /** The chapters the book already has: a book that never started is continued after them. */
  existingChapters: number;
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
  /** The run waits for a restart of «Retry later» now: turning it off would stop it, and the card says so beforehand. */
  waitingLong?: boolean;
  run: RunAction;
  /** Once the autopilot has started: the page opens the live page. */
  onStarted?: () => void;
  /** What the page puts between the settings and the button that starts the autopilot (the rules, the profiles, the danger zone). */
  children?: ReactNode;
  /** The working branch and the structure of the book: what the preview of the run reads the book's files and chapters from. Without the branch there is no preview. */
  branch?: string;
  structure?: BookStructure;
}

/**
 * The brief and the settings of the autopilot, in four parts: the book (the idea, how long it is, the synopsis), the review (the simulated
 * readers, the specialists, the pauses, the sessions and the budgets), the retries («Retry later», and «Resume after a restart» for a server that
 * has it) and publishing (on GitHub, every step, every chapter or never). They are saved together with `configure` while the autopilot is stopped;
 * while it runs only where it publishes, the pause after every chapter, what it does with a changed frozen chapter, «Retry later» and «Resume after
 * a restart» can change, with `updateOptions`, and the rest is locked. The
 * button at the end starts the autopilot (with the form, for a book that never started; after saving what changed, for one that is stopped) and
 * `onStarted` takes the author to the live page. Values of «Retry later» it would refuse are never sent: the card says what is wrong instead.
 */
export function SetupCard({ book, state, existingChapters, running, busy, disabled, asking = false, liveUnsupported = false, frozenUnsupported = false, retryUnsupported = false, autoResume = false, waitingLong = false, run, onStarted, children, branch, structure }: SetupCardProps) {
  const { t } = useTranslation();
  const github = bookStorageMode(book) === "github";
  const host = book.autopilotHost === "server" ? "server" : "browser";
  const initial = useMemo<SetupForm>(() => state
    ? { brief: state.brief, options: state.options }
    : { brief: { ...DEFAULT_BRIEF, targetChapters: Math.max(DEFAULT_BRIEF.targetChapters, existingChapters + 1) }, options: { ...DEFAULT_OPTIONS, syncAfterChapter: github } }, [state, existingChapters, github]);
  const [form, setForm] = useState<SetupForm>(initial);
  const [retry, setRetry] = useState<RetryLaterForm>(() => retryLaterForm(initial.options.longRetry));
  const [dirty, setDirty] = useState(false);
  const retryCard = useRef<RetryLaterCardHandle>(null);
  useEffect(() => {
    if (dirty) return;
    setForm(initial);
    setRetry(retryLaterForm(initial.options.longRetry));
  }, [initial, dirty]);

  const brief = (patch: Partial<AutopilotBrief>) => { setForm((current) => ({ ...current, brief: { ...current.brief, ...patch } })); setDirty(true); };
  const options = (patch: Partial<AutopilotOptions>) => { setForm((current) => ({ ...current, options: { ...current.options, ...patch } })); setDirty(true); };
  const retryChange = (next: RetryLaterForm) => { setRetry(next); setDirty(true); };
  const choosePreset = (id: Parameters<typeof applyPreset>[1]) => { setForm((current) => applyPreset(current, id)); setDirty(true); };
  const fresh = !state;
  // While a run goes on, only where the book is published and the pause after every chapter can change (not on a server that predates it).
  const locked = running || busy;
  const liveLocked = busy || (running && liveUnsupported);
  const frozenLocked = liveLocked || frozenUnsupported;
  // Asked every time unless the author chose otherwise: a state written before the option existed has none.
  const frozenEdits = form.options.frozenEdits ?? "ask";
  // What the host does when the author has not chosen: a server publishes after every step, this browser as the older switch says.
  const publish = effectivePublish(form.options, host === "server" ? "step" : undefined);
  const retryReading = readRetryLater(retry);
  // «Retry later» changed when the policy is not the one the state has; a server without it is never sent it.
  const retryChanged = !retryUnsupported && !sameLongRetry(retryReading.policy, initial.options.longRetry);
  // «Resume after a restart»: off unless the author turned it on, and only a server that has it is sent it.
  const resumeOn = form.options.resumeAfterRestart === true;
  const resumeChanged = autoResume && resumeOn !== (initial.options.resumeAfterRestart === true);

  /** The settings that can change during a run, as far as the author changed them. */
  const liveChanges = (): AutopilotLiveOptions => ({
    ...(form.options.publishEvery !== undefined && form.options.publishEvery !== initial.options.publishEvery ? { publishEvery: form.options.publishEvery } : {}),
    ...(form.options.pauseAfterEachChapter !== initial.options.pauseAfterEachChapter ? { pauseAfterEachChapter: form.options.pauseAfterEachChapter } : {}),
    ...(form.options.frozenEdits !== undefined && form.options.frozenEdits !== initial.options.frozenEdits ? { frozenEdits: form.options.frozenEdits } : {}),
    ...(retryChanged ? { longRetry: retryReading.policy } : {}),
    ...(resumeChanged ? { resumeAfterRestart: resumeOn } : {}),
  });

  /**
   * The options of the form with «Retry later» as the card says (the policy, `null` to turn off one the book had, as `StartOptions` takes it, and nothing
   * when it stays off) and «Resume after a restart» as the switch says, `true` or `false`, for a server that has it and for no other host.
   */
  const sentOptions = (): StartOptions["options"] => {
    const { longRetry: _saved, resumeAfterRestart: _resume, ...plain } = form.options;
    const rest = autoResume ? { ...plain, resumeAfterRestart: resumeOn } : plain;
    return retryUnsupported ? rest : retryReading.policy ? { ...rest, longRetry: retryReading.policy } : initial.options.longRetry ? { ...rest, longRetry: null } : rest;
  };

  /** Whether «Retry later» can be sent as it is; when it cannot, the card shows what is wrong and takes the focus there. */
  const retryReady = (): boolean => {
    if (retryUnsupported || retryReading.valid) return true;
    retryCard.current?.showProblems();
    return false;
  };

  const save = () => {
    if (!retryReady()) return;
    const changes = liveChanges();
    // During a run only the settings that can change are sent, and nothing when they are as they were (a server refuses an empty change).
    if (running && Object.keys(changes).length === 0) {
      setDirty(false);
      return;
    }
    const action = running
      ? run("options", (runtime, id) => runtime.updateOptions(id, changes), t("autopilot.setup.saved"))
      : run("configure", (runtime, id) => runtime.configure(id, { brief: form.brief, options: sentOptions() }), t("autopilot.setup.saved"));
    void action.then((ok) => { if (ok) setDirty(false); });
  };

  const completed = state?.status === "completed";
  // The settings ask for more chapters than the plan has: resuming extends the plan, so the button says it writes them.
  const extending = completed && Boolean(state?.plan && form.brief.targetChapters > state.plan.chapters.length);
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
    if (!retryReady()) return;
    void run("start", async (runtime, id) => {
      if (fresh) {
        await runtime.start(id, { brief: form.brief, options: sentOptions() });
        return;
      }
      // What the author changed is saved first: the run starts with it.
      if (dirty) await runtime.configure(id, { brief: form.brief, options: sentOptions() });
      await runtime.start(id);
    }).then((ok) => {
      if (!ok) return;
      setDirty(false);
      onStarted?.();
    });
  };

  return (
    <div className="space-y-5">
      <Card id="autopilot-book" title={t("autopilot.config.sections.book")} icon={<BookOpen className="h-4 w-4 text-primary" aria-hidden="true" />}>
        {fresh && <p className="text-sm text-muted-foreground">{existingChapters > 0 ? t("autopilot.setup.existingBook") : t("autopilot.setup.description")}</p>}
        <PresetPicker value={presetOfForm(form)} disabled={locked} onChoose={choosePreset} />
        <div className="space-y-1.5">
          <Label htmlFor="autopilot-idea">{t("autopilot.setup.idea")}</Label>
          <AutoTextarea id="autopilot-idea" value={form.brief.idea} onChange={(event) => brief({ idea: event.target.value })} minRows={fresh ? 3 : 2} placeholder={t("autopilot.setup.ideaPlaceholder")} className="text-sm" disabled={locked} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <NumberField id="autopilot-chapters" label={t("autopilot.setup.chapters")} value={form.brief.targetChapters} min={1} max={MAX_CHAPTERS} disabled={locked} onChange={(value) => brief({ targetChapters: value })} />
          <NumberField id="autopilot-scenes" label={t("autopilot.setup.scenes")} value={form.brief.scenesPerChapter} min={1} max={20} disabled={locked} onChange={(value) => brief({ scenesPerChapter: value })} />
          <NumberField id="autopilot-words" label={t("autopilot.setup.words")} value={form.brief.wordsPerScene} min={200} max={8000} step={100} disabled={locked} describedBy="autopilot-words-hint" onChange={(value) => brief({ wordsPerScene: value })} />
        </div>
        <p id="autopilot-words-hint" className="text-xs text-muted-foreground">{t("autopilot.modelHint")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="autopilot-genre" className="text-xs">{t("autopilot.setup.genre")}</Label><Input id="autopilot-genre" className="h-9" value={form.brief.genre} disabled={locked} onChange={(event) => brief({ genre: event.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="autopilot-audience" className="text-xs">{t("autopilot.setup.audience")}</Label><Input id="autopilot-audience" className="h-9" value={form.brief.audience} disabled={locked} onChange={(event) => brief({ audience: event.target.value })} /></div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="autopilot-synopsis">{t("autopilot.setup.synopsis")}</Label>
          <AutoTextarea id="autopilot-synopsis" value={form.brief.synopsis} onChange={(event) => brief({ synopsis: event.target.value })} minRows={2} placeholder={t("autopilot.setup.synopsisPlaceholder")} className="text-sm" disabled={locked} aria-describedby="autopilot-synopsis-note" />
          <p id="autopilot-synopsis-note" className="text-xs text-muted-foreground">{t("autopilot.setup.synopsisOutline")} <Link className="font-medium text-foreground underline underline-offset-4" to={`/app/books/${encodeURIComponent(book.id)}/outline`}>{t("autopilot.setup.useOutline")}</Link></p>
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>{t("autopilot.setup.fillOutline")}</span>
          {/* On unless the author turned it off: a state written before the option existed has none. */}
          <Switch checked={form.options.fillOutline !== false} disabled={locked} onCheckedChange={(checked) => options({ fillOutline: checked })} />
        </label>
      </Card>

      <Card id="autopilot-review" title={t("autopilot.config.sections.review")} icon={<ScanSearch className="h-4 w-4 text-primary" aria-hidden="true" />}>
        <div className="space-y-2">
          {REVIEW_SWITCHES.map(({ key, live }) => (
            <label key={key} className="flex items-center justify-between gap-3 text-sm">
              <span>{t(`autopilot.setup.${key}`)}</span>
              <Switch checked={Boolean(form.options[key])} disabled={live ? liveLocked : locked} onCheckedChange={(checked) => options({ [key]: checked })} />
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 pt-1">
          <NumberField id="autopilot-readers" label={t("autopilot.setup.maxReaders")} value={form.options.maxReaders} min={1} max={20} disabled={locked} onChange={(value) => options({ maxReaders: value })} />
          <NumberField id="autopilot-per-run" label={t("autopilot.setup.chaptersPerRun")} value={form.options.chaptersPerRun} min={0} max={MAX_CHAPTERS} disabled={locked} onChange={(value) => options({ chaptersPerRun: value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <NumberField id="autopilot-budget" label={t("autopilot.setup.budget")} value={form.options.budgetLimit} min={0} max={1_000_000} step={0.5} disabled={locked} describedBy="autopilot-budget-hint" onChange={(value) => options({ budgetLimit: value })} />
          <NumberField id="autopilot-budget-tokens" label={t("autopilot.setup.budgetTokens")} value={form.options.budgetTokens ?? 0} min={0} max={MAX_BUDGET_TOKENS} step={1000} disabled={locked} describedBy="autopilot-budget-tokens-hint" onChange={(value) => options({ budgetTokens: value })} />
        </div>
        <p id="autopilot-budget-hint" className="text-xs text-muted-foreground">{t("autopilot.setup.budgetHint")}</p>
        <p id="autopilot-budget-tokens-hint" className="text-xs text-muted-foreground">{t("autopilot.setup.budgetTokensHint")}</p>
        <fieldset className="space-y-2 pt-1" disabled={frozenLocked} aria-describedby="autopilot-frozen-edits-hint">
          <legend className="text-sm font-medium">{t("autopilot.config.frozenEdits.title")}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {FROZEN_EDITS_MODES.map((mode) => (
              <div key={mode} className={cn("rounded-lg border p-2 transition", frozenEdits === mode ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40")}>
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                  <input type="radio" name="autopilot-frozen-edits" className="h-4 w-4 accent-primary" value={mode} checked={frozenEdits === mode} aria-describedby={`autopilot-frozen-edits-${mode}`} onChange={() => options({ frozenEdits: mode })} />
                  {t(`autopilot.config.frozenEdits.${mode}`)}
                </label>
                <p id={`autopilot-frozen-edits-${mode}`} className="mt-1 text-xs text-muted-foreground">{t(`autopilot.config.frozenEdits.${mode}Help`)}</p>
              </div>
            ))}
          </div>
          <p id="autopilot-frozen-edits-hint" className="text-xs text-muted-foreground">{frozenUnsupported ? t("autopilot.config.frozenEdits.oldServer", { version: FROZEN_SERVER_VERSION }) : t("autopilot.config.frozenEdits.hint")}</p>
        </fieldset>
      </Card>

      <RetryLaterCard
        ref={retryCard}
        form={retry}
        onChange={retryChange}
        locked={liveLocked}
        unsupported={retryUnsupported}
        running={running}
        waitingLong={waitingLong}
        autoResume={autoResume ? { on: resumeOn, onChange: (on) => options({ resumeAfterRestart: on }) } : undefined}
      />
      {branch !== undefined && <BookRunPreview book={book} branch={branch} structure={structure} state={state} form={form} dirty={dirty} />}

      <Card id="autopilot-publish" title={t("autopilot.config.sections.publish")} icon={<Github className="h-4 w-4 text-primary" aria-hidden="true" />}>
        {github ? (
          <fieldset className="space-y-2" disabled={liveLocked} aria-describedby="autopilot-publish-hint">
            <legend className="text-sm font-medium">{t("autopilot.quick.publish.heading")}</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {PUBLISH_MODES.map((mode) => (
                <label key={mode} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border p-2 text-sm transition", publish === mode ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40")}>
                  <input type="radio" name="autopilot-publish" className="h-4 w-4 accent-primary" value={mode} checked={publish === mode} onChange={() => options({ publishEvery: mode, syncAfterChapter: mode !== "off" })} />
                  {t(`autopilot.quick.publish.choice.${mode}`)}
                </label>
              ))}
            </div>
            <p id="autopilot-publish-hint" className="text-xs text-muted-foreground">{t("autopilot.quick.publish.applies")}</p>
          </fieldset>
        ) : (
          <p className="text-sm text-muted-foreground">{t("autopilot.config.publishLocal")}</p>
        )}
      </Card>

      {!fresh && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={busy || !dirty} onClick={save}>
            <Save className="h-4 w-4" aria-hidden="true" />{t("autopilot.setup.save")}
          </Button>
        </div>
      )}

      {children}

      <div data-autopilot-start className={cn("space-y-2", (canStart || (completed && !running && !asking)) && "border-t pt-4")}>
        {canStart ? (
          <Button disabled={busy || disabled} onClick={start}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : fresh ? <Rocket className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}{startLabel}
          </Button>
        ) : completed && !running && !asking ? (
          <p className="text-sm text-muted-foreground">{t("autopilot.config.completeHint")}</p>
        ) : null}
        <OperationNotice bookId={book.id} />
      </div>
    </div>
  );
}

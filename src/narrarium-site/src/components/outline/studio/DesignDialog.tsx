import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Compass, Loader2 } from "lucide-react";
import { DIRECTOR_FILE, REVIEW_MAX_ROUNDS, defaultDirector, parseDirector, type AutopilotState } from "narrarium-engine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { EstimateLine, OptionalNumberField, useProblemText } from "@/components/autopilot/review/ReviewFields";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { useBookAutopilotView } from "@/autopilot/hooks";
import { useAutopilotStore } from "@/autopilot/store";
import { useBookFiles } from "@/autopilot/useBookFiles";
import { useRunEstimateSources } from "@/autopilot/useRunEstimate";
import { estimateDesign } from "@/autopilot/runEstimate";
import { formatCount } from "@/autopilot/format";
import { MAX_MONEY_CAP, TARGET_MAX, TARGET_MIN, WILDCARDS_SERVER_VERSION, serverHasWildcards } from "@/autopilot/reviewPolicy";
import { useAutopilotStore } from "@/autopilot/store";
import { autopilotRoomEstimate } from "@/autopilot/wildcardsEstimate";
import { useSettingsStore } from "@/store/settingsStore";
import { defaultDesignChapters, readDesignForm, type DesignForm } from "@/outline/designModel";
import { WorkflowFields } from "@/components/outline/studio/WorkflowFields";
import { readWorkflowForm, serverHasDesignReview, workflowFormOf, type WorkflowForm } from "@/outline/designReviewModel";
import { useMoney } from "@/costs/useMoney";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

export interface DesignDialogProps {
  open: boolean;
  onClose: () => void;
  book: BookEntry;
  branch: string;
  structure: BookStructure | undefined;
  state: AutopilotState | null;
  /** The entries the Synopsis has: the design has at least as many chapters. */
  entries: number;
  onStarted: () => void;
}

/**
 * «Design the book»: the chapters, whether the simulated readers read the design, the vote it must reach, the reviews and the readings of the readers (the fields of
 * the review of a run), the money cap of the book, and what it will cost. Confirmed, the design run starts (`StartOptions.design`); the writing autopilot is not
 * started.
 */
export default function DesignDialog({ open, onClose, book, branch, structure, state, entries, onStarted }: DesignDialogProps) {
  const { t } = useTranslation();
  const id = useId();
  const money = useMoney();
  const problemText = useProblemText();
  const { run, busy } = useAutopilotActions(book.id);
  const directorFile = useBookFiles(book.id, open ? [DIRECTOR_FILE] : []);
  const director = useMemo(() => {
    const text = directorFile.files?.get(DIRECTOR_FILE);
    return text === undefined ? defaultDirector(structure?.language) : parseDirector(text, structure?.language);
  }, [directorFile.files, structure?.language]);
  const policy = state?.design?.review;
  const initial = useMemo<DesignForm>(() => ({
    chapters: String(state?.design?.chapters || defaultDesignChapters(entries)),
    readers: state?.options.readersOnPlan ?? true,
    target: policy?.targetScore !== undefined ? String(policy.targetScore) : "",
    rounds: policy?.maxRounds !== undefined ? String(policy.maxRounds) : "",
    readerRounds: policy?.readerRounds !== undefined ? String(policy.readerRounds) : "",
    campaignRounds: "",
    money: state && state.options.budgetLimit > 0 ? String(state.options.budgetLimit) : "",
    tokens: "",
    wildcardsDesign: state?.options.review?.wildcards?.design === true,
  }), [state, policy, entries]);
  const [form, setForm] = useState<DesignForm>(initial);
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!edited) setForm(initial);
  }, [initial, edited]);
  useEffect(() => {
    if (!open) setEdited(false);
  }, [open]);
  const change = (patch: Partial<DesignForm>) => {
    setEdited(true);
    setForm((now) => ({ ...now, ...patch }));
  };
  // What the design does besides designing the chapters: the form is the one the design before it had, else the defaults; the alternatives only for a book whose concept is not made.
  const serverInfo = useAutopilotStore((store) => store.server.info);
  const reviewsSupported = book.autopilotHost !== "server" || serverInfo === null || serverHasDesignReview(serverInfo);
  const alternativesAllowed = !state?.concept.done;
  const initialWorkflow = useMemo<WorkflowForm>(() => workflowFormOf(state?.design), [state?.design]);
  const [workflowForm, setWorkflowForm] = useState<WorkflowForm>(initialWorkflow);
  const [workflowEdited, setWorkflowEdited] = useState(false);
  useEffect(() => {
    if (!workflowEdited) setWorkflowForm(initialWorkflow);
  }, [initialWorkflow, workflowEdited]);
  useEffect(() => {
    if (!open) setWorkflowEdited(false);
  }, [open]);
  const changeWorkflow = (patch: Partial<WorkflowForm>) => {
    setWorkflowEdited(true);
    setWorkflowForm((now) => ({ ...now, ...patch }));
  };
  const workflow = readWorkflowForm(workflowForm, { supported: reviewsSupported, alternativesAllowed });
  const reading = readDesignForm(form, entries);
  // The room of the wildcards before the first review (`ReviewPolicy.wildcards.design`): the run's policy, given whole with the switch as the dialog says; never to a personal server that predates it.
  const settings = useSettingsStore((current) => current.settings);
  const serverInfo = useAutopilotStore((store) => store.server.info);
  const wildcardsUnsupported = book.autopilotHost === "server" && serverInfo !== null && !serverHasWildcards(serverInfo);
  const roomBefore = state?.options.review?.wildcards;
  const roomOn = !wildcardsUnsupported && form.wildcardsDesign === true;
  const roomChange = wildcardsUnsupported ? undefined : roomOn ? { ...(roomBefore ?? {}), design: true } : roomBefore?.design ? (roomBefore.plateau ? { ...roomBefore, design: false } : null) : undefined;
  const chapters = reading.input.chapters ?? 0;
  const maxRounds = reading.review.policy.maxRounds ?? 3;
  const readerRounds = reading.review.policy.readerRounds ?? 1;

  const view = useBookAutopilotView(book.id);
  const inputs = useRunEstimateSources({ book, branch, structure, state, activities: view.snapshot?.activities });
  const estimate = useMemo(() => (open && chapters > 0 ? estimateDesign(inputs.sources, state, { chapters, maxRounds, readerRounds, readers: form.readers, ...(workflow.workflow ? { workflow: workflow.workflow } : {}) }).estimate : null), [open, chapters, maxRounds, readerRounds, form.readers, inputs.sources, state, workflow.workflow]);
  const roomVoices = roomBefore?.voices ?? 4;
  const room = roomOn && chapters > 0 ? autopilotRoomEstimate(settings, { voices: roomVoices, chapters }) : null;
  const roomCalls = room ? `${formatCount(room.calls.min)}–${formatCount(room.calls.max)}` : "";
  const roomText = !room
    ? null
    : book.autopilotHost === "server"
      ? t("autopilot.review.wildcards.estimateServer", { voices: roomVoices, calls: roomCalls })
      : room.cost
        ? t("autopilot.review.wildcards.estimate", { voices: roomVoices, calls: roomCalls, cost: `${money.amount(room.cost.min, room.cost.currency, { zero: "amount" })}–${money.amount(room.cost.max, room.cost.currency, { zero: "amount" })}` })
        : t("autopilot.review.wildcards.estimateNoPrice", { voices: roomVoices, calls: roomCalls });
  const spentCurrency = state?.stats.currency || money.display;
  const spent = money.amount(state?.stats.cost ?? 0, state?.stats.currency, { zero: "amount" });
  const running = view.snapshot?.running === true || view.busyInAnotherTab;
  const canSubmit = reading.valid && !workflow.problem && chapters > 0 && busy === null && !running;

  const submit = async () => {
    if (!canSubmit) return;
    const done = await run("start", (runtime, bookId) => runtime.start(bookId, { design: { ...reading.input, ...(workflow.workflow ? { workflow: workflow.workflow } : {}) }, options: { readersOnPlan: form.readers, budgetLimit: reading.budgetLimit, ...(roomChange !== undefined ? { review: { wildcards: roomChange } } : {}) } }));
    if (done) {
      onStarted();
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && busy === null) onClose(); }}>
      <DialogContent data-design-dialog="" className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Compass className="h-5 w-5 text-primary" aria-hidden="true" />{t("design.dialog.title")}</DialogTitle>
          <DialogDescription>{t("design.dialog.intro")}</DialogDescription>
        </DialogHeader>
        {running && <Alert><AlertDescription>{t("design.studio.blocked.running")}</AlertDescription></Alert>}

        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={`${id}-chapters`} className="text-xs font-medium">{t("design.dialog.chapters.label")}</Label>
            <Input
              id={`${id}-chapters`}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={form.chapters}
              aria-invalid={reading.chaptersProblem ? true : undefined}
              aria-describedby={[`${id}-chapters-hint`, reading.chaptersProblem ? `${id}-chapters-problem` : ""].filter(Boolean).join(" ")}
              className="h-9"
              onChange={(event) => change({ chapters: event.target.value })}
            />
            <p id={`${id}-chapters-hint`} className="text-xs text-muted-foreground">{entries > 0 ? t("design.dialog.chapters.hint", { count: entries }) : t("design.dialog.chapters.hintNone")}</p>
            {reading.chaptersProblem && <p id={`${id}-chapters-problem`} className="text-xs font-medium text-destructive">{problemText(reading.chaptersProblem, { min: Math.max(1, entries), max: 500 })}</p>}
          </div>
          <label className="flex min-h-11 cursor-pointer items-start gap-2 self-center text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={form.readers} aria-describedby={`${id}-readers-hint`} onChange={(event) => change({ readers: event.target.checked })} />
            <span>
              <span className="font-medium">{t("design.dialog.readers.label")}</span>
              <span id={`${id}-readers-hint`} className="block text-xs text-muted-foreground">{t("design.dialog.readers.hint")}</span>
            </span>
          </label>
          <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" data-design-wildcards="" className="mt-0.5 h-4 w-4 accent-primary" checked={roomOn} disabled={wildcardsUnsupported} aria-labelledby={`${id}-wildcards-label`} aria-describedby={`${id}-wildcards-hint`} onChange={(event) => change({ wildcardsDesign: event.target.checked })} />
            <span className="min-w-0">
              <span id={`${id}-wildcards-label`} className="font-medium">{t("design.dialog.wildcards.label")}</span>
              <span id={`${id}-wildcards-hint`} className="block text-xs text-muted-foreground">
                {wildcardsUnsupported ? t("design.dialog.wildcards.oldServer", { version: WILDCARDS_SERVER_VERSION }) : t("design.dialog.wildcards.hint")}
                {roomText && <span data-design-wildcards-estimate="" className="block">{roomText}</span>}
              </span>
            </span>
          </label>
          <OptionalNumberField id={`${id}-target`} label={t("autopilot.review.target.label")} value={form.target} placeholder={t("autopilot.review.target.placeholder", { score: formatCount(director.approvalScore) })} hint={t("design.dialog.target.hint")} problem={problemText(reading.review.problems.target, { min: TARGET_MIN, max: TARGET_MAX })} unit="/10" decimals onChange={(value) => change({ target: value })} />
          <OptionalNumberField id={`${id}-rounds`} label={t("design.dialog.rounds.label")} value={form.rounds} placeholder="3" hint={t("design.dialog.rounds.hint")} problem={problemText(reading.review.problems.rounds, { min: 1, max: REVIEW_MAX_ROUNDS })} onChange={(value) => change({ rounds: value })} />
          <OptionalNumberField id={`${id}-reader-rounds`} label={t("design.dialog.readerRounds.label")} value={form.readerRounds} placeholder="1" hint={t("design.dialog.readerRounds.hint")} problem={problemText(reading.review.problems.readerRounds, { min: 1, max: REVIEW_MAX_ROUNDS })} disabled={!form.readers} onChange={(value) => change({ readerRounds: value })} />
          <OptionalNumberField
            id={`${id}-money`}
            label={t("autopilot.review.money.label", { currency: spentCurrency })}
            value={form.money}
            placeholder={t("autopilot.review.unlimited")}
            hint={t("autopilot.reviewBook.moneyHintNone", { spent })}
            problem={problemText(reading.review.problems.money, { min: 0, max: MAX_MONEY_CAP })}
            unit={spentCurrency}
            decimals
            onChange={(value) => change({ money: value })}
          />
        </div>

        <WorkflowFields form={workflowForm} onChange={changeWorkflow} supported={reviewsSupported} alternativesAllowed={alternativesAllowed} problem={workflow.problem} />

        {estimate && <EstimateLine label={t("design.dialog.estimate")} estimate={estimate} currency={inputs.sources.currency || "USD"} />}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy !== null}>{t("common.cancel")}</Button>
          <Button type="button" data-design-start="" onClick={() => void submit()} disabled={!canSubmit}>
            {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Compass className="h-4 w-4" aria-hidden="true" />}
            {t("design.dialog.submit", { count: chapters || defaultDesignChapters(entries) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

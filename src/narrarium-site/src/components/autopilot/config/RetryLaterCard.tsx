import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { LONG_RETRY_MAX_CYCLES, LONG_RETRY_MAX_MINUTES, type AutopilotLongRetry } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/autopilot/Card";
import { RECOMMENDED_LONG_RETRY, RETRY_SERVER_VERSION, readWhole, type WholeProblem } from "@/autopilot/retry";
import { cn } from "@/lib/utils";

/** «Retry later» as the form holds it: whether it is on, and the numbers as they were typed (they are read only when they are saved). */
export interface RetryLaterForm {
  on: boolean;
  minutes: string;
  limit: "count" | "unlimited";
  cycles: string;
}

/** The form of a policy, or of none: off, with the recommended values ready for when it is turned on. */
export function retryLaterForm(policy: AutopilotLongRetry | null | undefined): RetryLaterForm {
  const shown = policy ?? RECOMMENDED_LONG_RETRY;
  return {
    on: Boolean(policy),
    minutes: String(shown.everyMinutes),
    limit: shown.cycles === "unlimited" ? "unlimited" : "count",
    cycles: String(shown.cycles === "unlimited" ? RECOMMENDED_LONG_RETRY.cycles : shown.cycles),
  };
}

export interface RetryLaterReading {
  /** The policy to send: `null` when it is off. Read only when there is no problem. */
  policy: AutopilotLongRetry | null;
  problems: { every: WholeProblem | null; cycles: WholeProblem | null };
  valid: boolean;
}

/** What the form says, checked as the engine checks it (`longRetryProblem`): whole numbers in range, and «no limit» only when it was chosen in words. */
export function readRetryLater(form: RetryLaterForm): RetryLaterReading {
  if (!form.on) return { policy: null, problems: { every: null, cycles: null }, valid: true };
  const every = readWhole(form.minutes, 1, LONG_RETRY_MAX_MINUTES);
  const cycles = form.limit === "unlimited" ? null : readWhole(form.cycles, 1, LONG_RETRY_MAX_CYCLES);
  const problems = { every: every.problem, cycles: cycles?.problem ?? null };
  if (every.value === null || (cycles && cycles.value === null)) return { policy: null, problems, valid: false };
  return { policy: { everyMinutes: every.value, cycles: cycles ? (cycles.value as number) : "unlimited" }, problems, valid: true };
}

/** Whether two policies are the same, `null` and nothing being the same: off. */
export function sameLongRetry(left: AutopilotLongRetry | null | undefined, right: AutopilotLongRetry | null | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.everyMinutes === right.everyMinutes && left.cycles === right.cycles;
}

export interface RetryLaterCardHandle {
  /** Show every problem, and give the focus to the first field that has one. */
  showProblems: () => void;
}

export interface RetryLaterCardProps {
  form: RetryLaterForm;
  onChange: (form: RetryLaterForm) => void;
  /** Something holds the book, or the run cannot change it now. */
  locked: boolean;
  /** The personal server that runs the book does not have «Retry later». */
  unsupported: boolean;
  running: boolean;
  /** The run waits for a restart of «Retry later» now: turning it off would stop it. */
  waitingLong: boolean;
}

const ID = "autopilot-retry";

/**
 * «Retry later» in the configuration: a switch, off unless the author turns it on, with the consent in words always next to it (it is the description of the
 * switch); the minutes between two restarts and how many restarts, or the choice in words to go on until it works; and «Use recommended values». The numbers are
 * checked as they are typed and before anything is saved: a problem is said under its field, and nothing is rounded or cut to fit. It can change while a run goes
 * on, and the page says beforehand what turning it off does to a run that waits for it. A personal server that does not have it shows it off, and says why.
 */
export const RetryLaterCard = forwardRef<RetryLaterCardHandle, RetryLaterCardProps>(function RetryLaterCard({ form, onChange, locked, unsupported, running, waitingLong }, ref) {
  const { t } = useTranslation();
  const minutesRef = useRef<HTMLInputElement>(null);
  const cyclesRef = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState({ every: false, cycles: false });
  const [focusAsked, setFocusAsked] = useState(0);
  const reading = readRetryLater(form);
  const every = touched.every ? reading.problems.every : null;
  const cycles = touched.cycles ? reading.problems.cycles : null;
  const off = locked || unsupported;

  useImperativeHandle(ref, () => ({
    showProblems: () => {
      setTouched({ every: true, cycles: true });
      setFocusAsked((count) => count + 1);
    },
  }), []);
  // The focus goes to the first field with a problem once the problem is on the screen: the field is read out with it.
  useEffect(() => {
    if (!focusAsked) return;
    if (reading.problems.every) minutesRef.current?.focus();
    else if (reading.problems.cycles) cyclesRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAsked]);

  const change = (patch: Partial<RetryLaterForm>) => onChange({ ...form, ...patch });
  const note = unsupported ? t("autopilot.config.retryLater.oldServer", { version: RETRY_SERVER_VERSION }) : running ? t("autopilot.config.retryLater.running") : null;
  const describedBy = (...ids: Array<string | false>) => ids.filter(Boolean).join(" ") || undefined;

  return (
    <Card id={ID} title={t("autopilot.config.sections.retry")} icon={<RotateCcw className="h-4 w-4 text-primary" aria-hidden="true" />}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${ID}-later`} className="text-sm font-medium">{t("autopilot.config.retryLater.label")}</Label>
          <p id={`${ID}-consent`} className="text-xs text-muted-foreground">{t("autopilot.config.retryLater.consent")}</p>
        </div>
        <Switch
          id={`${ID}-later`}
          className="mt-0.5"
          checked={form.on && !unsupported}
          disabled={off}
          aria-describedby={describedBy(`${ID}-consent`, note !== null && `${ID}-note`)}
          onCheckedChange={(on) => change({ on })}
        />
      </div>
      {note && <p id={`${ID}-note`} className="text-xs text-muted-foreground">{note}</p>}
      {waitingLong && !unsupported && (
        <p data-retry-waiting-now className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-xs font-medium">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-800 dark:text-amber-300" aria-hidden="true" />
          <span>{t("autopilot.config.retryLater.waitingNow")}</span>
        </p>
      )}
      {form.on && !unsupported && (
        <div className="space-y-3 border-t pt-3">
          <div className="max-w-xs space-y-1">
            <Label htmlFor={`${ID}-every`} className="text-xs">{t("autopilot.config.retryLater.every")}</Label>
            <Input
              ref={minutesRef}
              id={`${ID}-every`}
              type="number"
              inputMode="numeric"
              min={1}
              max={LONG_RETRY_MAX_MINUTES}
              step={1}
              className="h-11 sm:h-9"
              value={form.minutes}
              disabled={off}
              aria-invalid={every ? true : undefined}
              aria-describedby={describedBy(`${ID}-every-hint`, every !== null && `${ID}-every-error`)}
              onChange={(event) => change({ minutes: event.target.value })}
              onBlur={() => setTouched((current) => ({ ...current, every: true }))}
            />
            <p id={`${ID}-every-hint`} className="text-xs text-muted-foreground">{t("autopilot.config.retryLater.everyHint")}</p>
            {every && <p id={`${ID}-every-error`} className="text-xs font-medium text-destructive">{t(`autopilot.config.retryLater.errors.every.${every}`)}</p>}
          </div>
          <fieldset className="space-y-2" disabled={off}>
            <legend className="text-sm font-medium">{t("autopilot.config.retryLater.cycles.legend")}</legend>
            <div className={cn("space-y-2 rounded-lg border p-2", form.limit === "count" && "border-primary/60 bg-primary/5")}>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium sm:min-h-9">
                <input type="radio" name={`${ID}-limit`} className="h-4 w-4 accent-primary" value="count" checked={form.limit === "count"} onChange={() => change({ limit: "count" })} />
                {t("autopilot.config.retryLater.cycles.limit")}
              </label>
              <div className="max-w-xs space-y-1 pl-6">
                <Label htmlFor={`${ID}-cycles`} className="text-xs">{t("autopilot.config.retryLater.cycles.count")}</Label>
                <Input
                  ref={cyclesRef}
                  id={`${ID}-cycles`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={LONG_RETRY_MAX_CYCLES}
                  step={1}
                  className="h-11 sm:h-9"
                  value={form.cycles}
                  disabled={off || form.limit === "unlimited"}
                  aria-invalid={cycles ? true : undefined}
                  aria-describedby={cycles ? `${ID}-cycles-error` : undefined}
                  onChange={(event) => change({ cycles: event.target.value })}
                  onBlur={() => setTouched((current) => ({ ...current, cycles: true }))}
                />
                {cycles && <p id={`${ID}-cycles-error`} className="text-xs font-medium text-destructive">{t(`autopilot.config.retryLater.errors.cycles.${cycles}`)}</p>}
              </div>
            </div>
            <label className={cn("flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border p-2 text-sm font-medium sm:min-h-9", form.limit === "unlimited" && "border-primary/60 bg-primary/5")}>
              <input type="radio" name={`${ID}-limit`} className="h-4 w-4 accent-primary" value="unlimited" checked={form.limit === "unlimited"} onChange={() => change({ limit: "unlimited" })} />
              {t("autopilot.config.retryLater.cycles.unlimited")}
            </label>
          </fieldset>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              disabled={off}
              aria-describedby={`${ID}-recommended`}
              onClick={() => {
                setTouched({ every: false, cycles: false });
                change({ minutes: String(RECOMMENDED_LONG_RETRY.everyMinutes), limit: "count", cycles: String(RECOMMENDED_LONG_RETRY.cycles) });
              }}
            >
              {t("autopilot.config.retryLater.recommended")}
            </Button>
            <p id={`${ID}-recommended`} className="text-xs text-muted-foreground">{t("autopilot.config.retryLater.recommendedHint")}</p>
          </div>
        </div>
      )}
    </Card>
  );
});

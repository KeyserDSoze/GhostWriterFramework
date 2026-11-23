import type { AutopilotActivity } from "./types.js";

/**
 * The tasks whose step makes two calls: writing a scene is the scene and then its summary, the repair and the revision likewise. The activity of a step
 * records the model of its LAST call and the tokens of all of them, so when the model that writes and the model of the simple tasks are not the same,
 * the step is the summary model's and its speed is nobody's. A host that routes them to different models passes this as `ignoreTasks`.
 */
export const TWO_CALL_TASKS: readonly string[] = Object.freeze(["write", "repair", "revise"]);

/** What a model was measured at: tokens written per second, and how many steps it comes from. */
export interface MeasuredSpeed {
  tokensPerSecond: number;
  samples: number;
}

export interface MeasuredSpeedOptions {
  /** How many of the latest steps of each model are read (default 20); a value that is not a number from 1 up is the default. */
  last?: number;
  /** The shortest step that tells something, in seconds (default 1). A step takes some time at any rate: the speed is a division. */
  minSeconds?: number;
  /** Tasks that are not read (see `TWO_CALL_TASKS`). */
  ignoreTasks?: readonly string[];
}

const DEFAULT_LAST = 20;
const DEFAULT_MIN_SECONDS = 1;

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function momentOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function median(sorted: number[]): number {
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * How fast each model writes, from the log of the activities of a book: tokens a second, the median of the latest steps of the model that ended
 * succeeded. A step with no data is not a sample (not succeeded, no model, no tokens written, no or invalid dates, or shorter than
 * `options.minSeconds`); a model with no sample is not in the answer, so that a speed is never made up.
 *
 * A step is timed from start to end, so prefill, network time and the work between the calls are in it: it is the speed the book actually had, which
 * is what the time of an estimate (the tokens a run writes at this speed) is meant to be. It is a function of the log: no clock, nothing changed.
 */
export function measuredSpeed(activities: readonly Partial<AutopilotActivity>[] | null | undefined, options: MeasuredSpeedOptions = {}): Map<string, MeasuredSpeed> {
  const speeds = new Map<string, MeasuredSpeed>();
  if (!Array.isArray(activities)) return speeds;
  const settings = options && typeof options === "object" ? options : {};
  const last = isNumber(settings.last) && settings.last >= 1 ? Math.floor(settings.last) : DEFAULT_LAST;
  const minSeconds = isNumber(settings.minSeconds) ? Math.max(0, settings.minSeconds) : DEFAULT_MIN_SECONDS;
  const ignored = new Set(Array.isArray(settings.ignoreTasks) ? settings.ignoreTasks.filter((task): task is string => typeof task === "string") : []);
  const samples = new Map<string, Array<{ ended: number; speed: number }>>();
  for (let index = 0; index < activities.length; index += 1) {
    const entry = activities[index] as Partial<AutopilotActivity> | null | undefined;
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.status !== "succeeded") continue;
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    if (!model || (typeof entry.task === "string" && ignored.has(entry.task))) continue;
    const usage = entry.usage;
    const written = usage && typeof usage === "object" ? usage.outputTokens : undefined;
    if (!isNumber(written) || written <= 0) continue;
    const started = momentOf(entry.startedAt);
    const ended = momentOf(entry.endedAt);
    if (started === undefined || ended === undefined) continue;
    const seconds = (ended - started) / 1000;
    if (!(seconds > 0) || seconds < minSeconds) continue;
    const list = samples.get(model);
    const sample = { ended, speed: written / seconds };
    if (list) list.push(sample);
    else samples.set(model, [sample]);
  }
  for (const [model, list] of samples) {
    // The latest by the moment they ended; the log's own order decides between steps that ended together.
    const latest = list.map((sample, order) => ({ ...sample, order })).sort((left, right) => left.ended - right.ended || left.order - right.order).slice(-last);
    speeds.set(model, { tokensPerSecond: median(latest.map((sample) => sample.speed).sort((left, right) => left - right)), samples: latest.length });
  }
  return speeds;
}

import type { ActivityStatus, AutopilotActivity, AutopilotEvent } from "narrarium-engine";
import { autopilotLiveHref } from "@/autopilot/pageRoute";

/**
 * What the autopilot is writing and what it did last, as the dock, the band of the Autopilot page and the cards of the page of every book show
 * them: the last lines of the text that streams (the tail the `task-progress` events carry) and the last steps that are over, each a way to the
 * step on the Autopilot page. Pure: the components only draw what is here.
 */

/** The lines of the streaming text that are shown: three, two on a phone. */
export const STREAM_LINES = 3;
export const STREAM_LINES_PHONE = 2;
/** A phone, upright or sideways: where the mini-player is a sheet, and where two lines of text are enough. */
export const PHONE_SCREENS = "(max-width: 639px), (max-height: 600px)";
/** The steps that are over that are listed. */
export const LAST_DONE = 3;
/**
 * The most of the text the lines hold: more than three lines of the widest panel, so that they are always full, and no more, so that the block of the
 * step in the history, which shows the text whole, is not the same text twice (it shows it only when there is more of it than this).
 */
export const STREAM_CHARACTERS = 320;
/** The lines follow the text at most this often (four times a second). */
export const STREAM_THROTTLE_MS = 250;
/** A screen reader is told something new at most this often. */
export const ANNOUNCE_INTERVAL_MS = 10_000;

/** The prefix of the anchor of a step on the Autopilot page: `#task-<activity id>`. */
export const TASK_HASH_PREFIX = "task-";

/** The id of the element of a step on the Autopilot page (its row, or the block of the step that runs), which a link to it points at. */
export function taskElementId(activityId: string): string {
  return `${TASK_HASH_PREFIX}${activityId}`;
}

/** The step a hash points at (`#task-activity_…`), or `null` when it points at something else. */
export function taskIdOfHash(hash: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null;
  }
  if (!id.startsWith(TASK_HASH_PREFIX)) return null;
  const activityId = id.slice(TASK_HASH_PREFIX.length);
  return activityId ? activityId : null;
}

/** The address of a step on the Autopilot page of its book: the page opens its history there, with the step open and focused. */
export function taskHref(bookId: string, activityId: string): string {
  return `${autopilotLiveHref(bookId)}#${encodeURIComponent(taskElementId(activityId))}`;
}

const FINISHED: ReadonlySet<ActivityStatus> = new Set(["succeeded", "failed", "cancelled"]);

const time = (iso: string | undefined): number => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : 0;
};

/**
 * The last steps that are over, the newest first: the log of the book and the steps the feed finished that the log does not have yet (the feed's
 * copy of a step is the newer one). A step that is still running is not over, and neither is one a run that was interrupted left behind as running.
 */
export function latestFinished(activities: readonly AutopilotActivity[], events: readonly AutopilotEvent[], options: { runningId?: string | null; limit?: number } = {}): AutopilotActivity[] {
  const limit = options.limit ?? LAST_DONE;
  if (limit <= 0) return [];
  const byId = new Map<string, AutopilotActivity>();
  for (const activity of activities) byId.set(activity.id, activity);
  for (const event of events) if (event.type === "task-finished") byId.set(event.activity.id, event.activity);
  // Between two steps that ended at the same moment (a clock that counts in seconds), the later in the log is the newer.
  return [...byId.values()]
    .map((activity, index) => ({ activity, index }))
    .filter(({ activity }) => activity.id !== options.runningId && FINISHED.has(activity.status) && Boolean(activity.endedAt))
    .sort((a, b) => time(b.activity.endedAt) - time(a.activity.endedAt) || b.index - a.index)
    .slice(0, limit)
    .map(({ activity }) => activity);
}

/**
 * The end of the streaming text as the lines show it: the last `max` characters of the tail the event carries, with its line breaks. When that is only
 * the end of a longer text (`characters`, the length of the whole, says so, or the tail is longer than `max`) it begins at its first whole word, after
 * an ellipsis. The lines keep the last of it in sight.
 */
export function streamTail(preview: string, characters = preview.length, max = STREAM_CHARACTERS): string {
  const whole = preview.trimEnd();
  if (!whole.trim()) return "";
  const text = whole.length > max ? whole.slice(whole.length - max) : whole;
  if (text.length === whole.length && characters <= preview.length) return text.trimStart();
  const space = text.search(/\s/);
  const start = space >= 0 && space < 24 ? space : 0;
  return `…${text.slice(start).trimStart()}`;
}

/** How important an announcement is: a failure goes before the end of a step, which goes before «answering». */
export type AnnouncementPriority = 1 | 2 | 3;

type VoiceListener = (bookId: string, text: string, priority: AnnouncementPriority) => void;
const voiceListeners = new Set<VoiceListener>();

/**
 * Says `text` about a book in the polite voice of the surfaces that follow it (the band of its Autopilot page): another part of the page (the task view,
 * for the calls it follows) speaks with the same voice and at the same pace, so that a screen reader hears one line, not two that say the same.
 */
export function sayInLiveVoice(bookId: string, text: string, priority: AnnouncementPriority): void {
  for (const listener of voiceListeners) listener(bookId, text, priority);
}

/** Listens to what other parts of the page say through `sayInLiveVoice`; returns the way to stop. */
export function listenToLiveVoice(listener: VoiceListener): () => void {
  voiceListeners.add(listener);
  return () => {
    voiceListeners.delete(listener);
  };
}

/**
 * One polite voice for a screen reader, which never says more than one thing every `interval` milliseconds: what comes while it waits is kept
 * (the most important, and among equals the newest) and said when the time comes. `say` receives the text; the caller puts it in a status region.
 */
export class PoliteAnnouncer {
  private last = Number.NEGATIVE_INFINITY;
  private pending: { text: string; priority: AnnouncementPriority } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly say: (text: string) => void,
    private readonly interval = ANNOUNCE_INTERVAL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  push(text: string, priority: AnnouncementPriority): void {
    if (!text) return;
    if (!this.pending || priority >= this.pending.priority) this.pending = { text, priority };
    this.schedule();
  }

  /** Nothing more is said (the region that said it is gone). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = this.last + this.interval - this.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    const next = this.pending;
    this.pending = null;
    if (!next) return;
    this.last = this.now();
    this.say(next.text);
  }
}

import type { ActivityStatus, AutopilotActivity, AutopilotEvent, AutopilotFinalReview, AutopilotTaskKind, ChapterRound, InsightTone } from "narrarium-engine";
import { parseVerdictLine } from "@/autopilot/bandModel";

/**
 * The history of a book as one list, made of what the interface receives: the activities of the log (what each step was, how it went, what it
 * cost) and the events of the feed (the insights and the warnings of the steps, the retries, the runs). Pure: the components only draw what is
 * here. What the engine says as data (the rounds of a chapter with their votes, the verdict on the book) is read here, before what can be worked
 * out from the steps; the steps are what a state that an older engine wrote has to go by.
 */

/** The rows drawn in a group before the author asks for more, how many more each time, and the most there ever are in a group. */
export const GROUP_ROWS = 40;
export const ROW_STEP = 40;
export const MAX_ROWS = 200;
/** The notes of the runs that are kept (the newest): the log of the steps has at most 200, and so the notes around them. */
export const MAX_MARKERS = 60;

/** How long before the first step of the log a note of the run still belongs to it, and how far apart the clocks of two machines may be. */
const REACH_MS = 10 * 60 * 1000;
const CLOCK_SLACK_MS = 2000;
/** The runner never waits longer than this before a retry: a retry notice older than that after a failure is not about it. */
const RETRY_REACH_MS = 6 * 60 * 1000;

export const TIMELINE_FILTERS = ["all", "problems", "director", "readers", "writing"] as const;
export type TimelineFilter = (typeof TIMELINE_FILTERS)[number];

/** Who does a step. The specialists have no filter of their own: their steps are in “all”, and in “problems” when they found one. */
export type StepCategory = "director" | "readers" | "specialists" | "writing" | "other";

const CATEGORY: Partial<Record<AutopilotTaskKind, StepCategory>> = {
  "director-review": "director",
  "plan-review": "director",
  final: "director",
  impact: "director",
  reader: "readers",
  "readers-summary": "readers",
  "plan-reader": "readers",
  specialists: "specialists",
  concept: "writing",
  "summarize-imported": "writing",
  plan: "writing",
  replan: "writing",
  scenes: "writing",
  write: "writing",
  repair: "writing",
  revise: "writing",
  consolidate: "writing",
};

export function categoryOf(task: AutopilotTaskKind): StepCategory {
  return CATEGORY[task] ?? "other";
}

export type NoticeEvent = Extract<AutopilotEvent, { type: "insight" | "sync" }>;

/** An insight or a sync notice of a step, shown under it. */
export interface TimelineNote {
  key: string;
  at: string;
  tone: InsightTone;
  event: NoticeEvent;
}

/** The notice the runner gave when a failure was going to be retried: which retry, of how many, after how long. */
export interface RetryNote {
  key: string;
  at: string;
  event: Extract<AutopilotEvent, { type: "insight" }>;
  attempt?: number;
  retries?: number;
  waitMs?: number;
}

export interface TimelineAttempt {
  activity: AutopilotActivity;
  /** The notice of the retry that followed this attempt, when its failure was retried. */
  retry: RetryNote | null;
}

export interface TokenTotals {
  input: number;
  output: number;
  cached: number;
}

export interface TimelineStep {
  kind: "step";
  /** The id of the first attempt: the same for as long as the step is in the log. */
  key: string;
  /** Oldest first; at least one. */
  attempts: TimelineAttempt[];
  /** The attempt that counts: the last one. */
  last: AutopilotActivity;
  status: ActivityStatus;
  category: StepCategory;
  /** From the first attempt to the end of the last. */
  startedAt: string;
  endedAt?: string;
  /** What the step took, all its attempts together. */
  durationMs: number;
  cost: number;
  tokens: TokenTotals | null;
  /** The insights and the sync notices of the step, in the order they came. */
  notes: TimelineNote[];
  /** The attempts before the last that did not work. */
  failedAttempts: number;
  /** Something to look at: the last attempt did not work, an attempt did not, or a note is a warning. */
  problem: boolean;
  /** Changes whenever what a row shows changes, so that a row that shows the same as before is not drawn again. */
  version: string;
}

/** A note of the run that belongs to no step: a run that started or ended, a notice that names no step. */
export interface TimelineMarker {
  kind: "marker";
  key: string;
  at: string;
  tone: InsightTone;
  event: AutopilotEvent;
  problem: boolean;
}

export type TimelineRow = TimelineStep | TimelineMarker;

/**
 * The director's verdict and score of a round, or of the book. The score is the vote the plan recorded for the round, when it did; the verdict is what the
 * review wrote (the plan does not record it: a round that has no review in the log has a score and no verdict, and none is guessed). The readers' average (the
 * first round only) and what the director decided are the plan's too.
 */
export interface RoundResult {
  verdict?: "approve" | "revise" | "rewrite";
  score: number;
  readers?: number;
  accepted?: number;
  rejected?: number;
}

export type GroupKind = "chapter" | "plan" | "final" | "other";

export interface TimelineGroup {
  /** `chapter:4:2` (a chapter and its round), `plan`, `final` or `other`. */
  key: string;
  kind: GroupKind;
  chapterNumber?: number;
  round?: number;
  /** The newest first. */
  rows: TimelineRow[];
  steps: number;
  failed: number;
  problems: number;
  result: RoundResult | null;
  /** The step that runs now belongs here. */
  running: boolean;
  /** When the newest thing in it happened, in milliseconds. */
  at: number;
}

export interface Timeline {
  groups: TimelineGroup[];
  /** Steps in all the groups. */
  steps: number;
  /** What the author hid until a moment: rows that are not in the groups. */
  hidden: number;
  /** The group that is open when the author has not chosen: the one that runs, else the newest. */
  open: string | null;
}

export interface TimelineInput {
  activities: readonly AutopilotActivity[];
  /** The events of the book, in any order. */
  events: readonly AutopilotEvent[];
  /** The step that runs now, which has no row: the band says what it is. Only the group it belongs to is needed. */
  running?: Pick<AutopilotActivity, "id" | "task" | "chapterNumber" | "startedAt"> | null;
  /** Hide what was over before this moment (an ISO time). */
  since?: string | null;
  /**
   * The rounds of review the plan recorded for a chapter, oldest first (`PlannedChapter.rounds`); `undefined` for a chapter without a record (a state from an engine
   * that did not record them). Asked once for each chapter of the log, and not for the others: a plan has no maximum number of chapters.
   */
  rounds?: (chapter: number) => readonly ChapterRound[] | undefined;
  /** What the engine says of the whole book, when it says it: the verdict and the score of the group of the final review. */
  finalReview?: Pick<AutopilotFinalReview, "verdict" | "score"> | null;
}

const time = (iso: string | undefined): number => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : 0;
};

const endOf = (activity: AutopilotActivity): number => time(activity.endedAt ?? activity.startedAt);

const stepKey = (activity: AutopilotActivity): string => `${activity.task}|${activity.chapterNumber ?? ""}|${activity.sceneNumber ?? ""}|${activity.reader ?? ""}`;

const eventKey = (event: AutopilotEvent): string => `${event.bookId}:${event.seq}:${event.at}`;

/** The steps that are not about a chapter, and where they go: the concept and the plan together, the review of the book, the rest. */
const BOOK_LEVEL: Partial<Record<AutopilotTaskKind, GroupKind>> = {
  concept: "plan",
  plan: "plan",
  "plan-reader": "plan",
  "plan-review": "plan",
  final: "final",
  impact: "other",
};

/** The log, with the steps that the feed finished and the log does not have yet, oldest first. A step is in once. */
export function mergeLog(activities: readonly AutopilotActivity[], events: readonly AutopilotEvent[], skip: string | undefined): AutopilotActivity[] {
  const byId = new Map<string, AutopilotActivity>();
  for (const activity of activities) if (activity.id !== skip) byId.set(activity.id, activity);
  for (const event of events) if (event.type === "task-finished" && event.activity.id !== skip && !byId.has(event.activity.id)) byId.set(event.activity.id, event.activity);
  return [...byId.values()]
    .map((activity, index) => ({ activity, index }))
    .sort((a, b) => time(a.activity.startedAt) - time(b.activity.startedAt) || a.index - b.index)
    .map((entry) => entry.activity);
}

interface Draft {
  key: string;
  attempts: AutopilotActivity[];
  retries: Map<string, RetryNote>;
  notes: TimelineNote[];
  group: string;
}

/** The group a step belongs to: its chapter and the round of the review it is in, or what its kind is. */
function groupOf(activity: Pick<AutopilotActivity, "task" | "chapterNumber">, reviews: Map<number, number>): string {
  const book = BOOK_LEVEL[activity.task];
  if (book) return book;
  if (activity.chapterNumber === undefined) return "other";
  const done = reviews.get(activity.chapterNumber) ?? 0;
  // The closing belongs to the review that approved; any other step after a review that asked for fixes is in the next round.
  const round = activity.task === "consolidate" ? Math.max(1, done) : done + 1;
  return `chapter:${activity.chapterNumber}:${round}`;
}

function kindOf(key: string): GroupKind {
  return key.startsWith("chapter:") ? "chapter" : (key as GroupKind);
}

/** The verdict and the score of the director in a step that holds them: what a round has when the plan did not record it (a state that an older engine wrote). */
export function roundResultOf(step: TimelineStep): RoundResult | null {
  if (step.last.status !== "succeeded" || (step.last.task !== "director-review" && step.last.task !== "final")) return null;
  const line = parseVerdictLine(step.last.summary);
  return line ? { verdict: line.verdict, score: line.score } : null;
}

/**
 * What the plan recorded of a round: its vote goes before the one in the words of the review, and so does its verdict (what the round decided, which is not always what the model
 * said: an approval under the approval score of the director is withheld). A round that has no vote has what the review wrote, and one that has no verdict keeps the verdict of the words.
 */
function withRecord(written: RoundResult | null, entry: ChapterRound | undefined): RoundResult | null {
  if (!entry) return written;
  const score = typeof entry.director === "number" ? entry.director : written?.score;
  if (score === undefined) return null;
  const verdict = entry.verdict === "approve" || entry.verdict === "revise" ? entry.verdict : written?.verdict;
  return {
    ...(verdict ? { verdict } : {}),
    score,
    ...(typeof entry.readers === "number" ? { readers: entry.readers } : {}),
    ...(typeof entry.accepted === "number" ? { accepted: entry.accepted } : {}),
    ...(typeof entry.rejected === "number" ? { rejected: entry.rejected } : {}),
  };
}

/** A wait of «Retry later» is a row of its own that says the run waits: a note, not a problem (the failure before it is one already, and so is the end of the restarts). */
const isRetryWait = (event: AutopilotEvent): boolean => event.type === "insight" && event.code === "longRetryWait";

function toneOfMarker(event: AutopilotEvent): InsightTone {
  if (isRetryWait(event)) return "info";
  if (event.type === "insight" || event.type === "sync") return event.tone;
  if (event.type === "run-ended") return event.status === "completed" ? "ok" : event.status === "error" ? "critical" : event.status === "waiting-author" ? "warning" : "info";
  return "info";
}

function isProblemMarker(event: AutopilotEvent): boolean {
  if (isRetryWait(event)) return false;
  if (event.type === "run-ended") return event.status === "error";
  if (event.type === "insight" || event.type === "sync") return event.tone === "warning" || event.tone === "critical";
  return false;
}

function stepOf(draft: Draft): TimelineStep {
  const attempts = draft.attempts.map((activity) => ({ activity, retry: draft.retries.get(activity.id) ?? null }));
  const last = draft.attempts[draft.attempts.length - 1];
  const first = draft.attempts[0];
  let durationMs = 0;
  let cost = 0;
  const used: TokenTotals = { input: 0, output: 0, cached: 0 };
  let counted = false;
  for (const activity of draft.attempts) {
    if (activity.endedAt) durationMs += Math.max(0, time(activity.endedAt) - time(activity.startedAt));
    cost += activity.cost ?? 0;
    if (activity.usage) {
      counted = true;
      used.input += activity.usage.inputTokens;
      used.output += activity.usage.outputTokens;
      used.cached += activity.usage.cachedInputTokens ?? 0;
    }
  }
  const tokens: TokenTotals | null = counted ? used : null;
  const failedAttempts = draft.attempts.slice(0, -1).filter((activity) => activity.status !== "succeeded").length;
  const problem = last.status === "failed" || last.status === "cancelled" || failedAttempts > 0 || draft.notes.some((note) => note.tone === "warning" || note.tone === "critical");
  const version = [draft.key, ...attempts.map((attempt) => `${attempt.activity.id}:${attempt.activity.status}:${attempt.activity.endedAt ?? ""}:${attempt.retry?.key ?? ""}`), ...draft.notes.map((note) => note.key)].join("|");
  return { kind: "step", key: draft.key, attempts, last, status: last.status, category: categoryOf(last.task), startedAt: first.startedAt, endedAt: last.endedAt, durationMs, cost, tokens, notes: draft.notes, failedAttempts, problem, version };
}

const rowTime = (row: TimelineRow): number => (row.kind === "step" ? endOf(row.last) : time(row.at));

function statsOf(rows: readonly TimelineRow[]): Pick<TimelineGroup, "steps" | "failed" | "problems"> {
  let steps = 0;
  let failed = 0;
  let problems = 0;
  for (const row of rows) {
    if (row.kind === "step") {
      steps += 1;
      if (row.status === "failed") failed += 1;
    }
    if (row.problem) problems += 1;
  }
  return { steps, failed, problems };
}

function resultOf(rows: readonly TimelineRow[]): RoundResult | null {
  for (const row of rows) {
    if (row.kind !== "step") continue;
    const result = roundResultOf(row);
    if (result) return result;
  }
  return null;
}

/** The whole timeline of a book: the steps and what happened around them, in groups. */
export function buildTimeline({ activities, events, running = null, since = null, rounds, finalReview = null }: TimelineInput): Timeline {
  const log = mergeLog(activities, events, running?.id);

  // The steps: an activity that repeats a step that did not work is one more attempt of it.
  const drafts: Draft[] = [];
  const lastByKey = new Map<string, Draft>();
  for (const activity of log) {
    const key = stepKey(activity);
    const previous = lastByKey.get(key);
    if (previous && previous.attempts[previous.attempts.length - 1].status !== "succeeded") {
      previous.attempts.push(activity);
      continue;
    }
    const draft: Draft = { key: activity.id, attempts: [activity], retries: new Map(), notes: [], group: "" };
    drafts.push(draft);
    lastByKey.set(key, draft);
  }

  // The plan's record of the rounds of a chapter, asked once for each chapter the log has.
  const recorded = new Map<number, readonly ChapterRound[] | undefined>();
  const recordOf = (chapter: number): readonly ChapterRound[] | undefined => {
    if (!recorded.has(chapter)) recorded.set(chapter, rounds?.(chapter));
    return recorded.get(chapter);
  };

  // The rounds: how many reviews of the director a chapter had before a step says which round it is in. The log keeps the last 200 steps, so the first reviews of
  // the oldest chapter in it may be gone: the plan's record says how many there were (the log is the fallback, for a state that has no record). A record that is
  // shorter than the log is not used for the chapter: the page has a step of the log a moment before it has the plan that records it, and a record may have begun in
  // the middle of the chapter. Either way it cannot be said which round of the log each of its votes is, and a vote on the wrong round is worse than none.
  const reviews = new Map<number, number>();
  const usable = new Map<number, readonly ChapterRound[]>();
  if (rounds) {
    const logged = new Map<number, number>();
    const chapters = new Set<number>();
    for (const draft of drafts) {
      const last = draft.attempts[draft.attempts.length - 1];
      if (last.chapterNumber === undefined) continue;
      chapters.add(last.chapterNumber);
      if (last.task === "director-review" && last.status === "succeeded") logged.set(last.chapterNumber, (logged.get(last.chapterNumber) ?? 0) + 1);
    }
    if (running?.chapterNumber !== undefined) chapters.add(running.chapterNumber);
    for (const chapter of chapters) {
      const record = recordOf(chapter);
      const inLog = logged.get(chapter) ?? 0;
      if (!record || record.length < inLog) continue;
      usable.set(chapter, record);
      if (record.length > inLog) reviews.set(chapter, record.length - inLog);
    }
  }
  for (const draft of drafts) {
    const last = draft.attempts[draft.attempts.length - 1];
    draft.group = groupOf(last, reviews);
    if (last.task === "director-review" && last.status === "succeeded" && last.chapterNumber !== undefined) reviews.set(last.chapterNumber, (reviews.get(last.chapterNumber) ?? 0) + 1);
  }
  const runningGroup = running ? groupOf(running, reviews) : null;

  const byActivity = new Map<string, Draft>();
  for (const draft of drafts) for (const attempt of draft.attempts) byActivity.set(attempt.id, draft);
  const failedAttempts = drafts.flatMap((draft) => draft.attempts.filter((attempt) => attempt.status !== "succeeded" && attempt.endedAt).map((attempt) => ({ draft, attempt })));

  // The events of the feed, in the order they happened: the notes of a step, the retries, and the notes of the run.
  const ordered = [...events].sort((a, b) => time(a.at) - time(b.at) || a.seq - b.seq);
  const seen = new Set<string>();
  const firstStart = drafts.length ? Math.min(...drafts.map((draft) => time(draft.attempts[0].startedAt))) : 0;
  const loose: TimelineMarker[] = [];
  for (const event of ordered) {
    if (event.type !== "insight" && event.type !== "sync" && event.type !== "run-started" && event.type !== "run-ended") continue;
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    const at = time(event.at);
    if (event.type === "insight" || event.type === "sync") {
      const draft = event.activityId ? byActivity.get(event.activityId) : undefined;
      if (draft) {
        draft.notes.push({ key, at: event.at, tone: event.tone, event });
        continue;
      }
      // What the step that runs says is told under it once it is over: it has no row yet.
      if (event.activityId && running && event.activityId === running.id) continue;
      if (event.type === "insight" && (event.code === "failureRetry" || event.code === "conflictRetry")) {
        const owner = [...failedAttempts].reverse().find((entry) => endOf(entry.attempt) - CLOCK_SLACK_MS <= at && at - endOf(entry.attempt) <= RETRY_REACH_MS && !entry.draft.retries.has(entry.attempt.id));
        if (owner) {
          owner.draft.retries.set(owner.attempt.id, { key, at: event.at, event, attempt: event.attempt, retries: event.retries, waitMs: event.waitMs });
          continue;
        }
      }
    }
    loose.push({ kind: "marker", key, at: event.at, tone: toneOfMarker(event), event, problem: isProblemMarker(event) });
  }

  // Build the groups from the steps.
  const groups = new Map<string, TimelineGroup>();
  const ensure = (key: string): TimelineGroup => {
    let group = groups.get(key);
    if (!group) {
      const kind = kindOf(key);
      const [, chapter, round] = kind === "chapter" ? key.split(":") : [];
      group = { key, kind, ...(kind === "chapter" ? { chapterNumber: Number(chapter), round: Number(round) } : {}), rows: [], steps: 0, failed: 0, problems: 0, result: null, running: false, at: 0 };
      groups.set(key, group);
    }
    return group;
  };
  const sinceMs = since ? time(since) : 0;
  let hidden = 0;
  for (const draft of drafts) {
    const step = stepOf(draft);
    if (sinceMs && endOf(step.last) <= sinceMs) {
      hidden += 1;
      continue;
    }
    ensure(draft.group).rows.push(step);
  }

  // The notes of the run go to the group of the step they came after (a run that starts, to the step it begins with).
  const markers: Array<{ marker: TimelineMarker; group: string }> = [];
  const keptLoose = loose.filter((marker) => {
    if (!drafts.length) return true;
    return time(marker.at) >= firstStart - REACH_MS;
  });
  for (const marker of keptLoose) {
    const at = time(marker.at);
    if (!drafts.length) {
      markers.push({ marker, group: "other" });
      continue;
    }
    let target: Draft | undefined;
    if (marker.event.type === "run-started") {
      target = drafts.find((draft) => time(draft.attempts[0].startedAt) >= at - CLOCK_SLACK_MS);
      if (!target && runningGroup) {
        markers.push({ marker, group: runningGroup });
        continue;
      }
    }
    if (!target) {
      for (let index = drafts.length - 1; index >= 0; index -= 1) {
        if (time(drafts[index].attempts[0].startedAt) <= at + CLOCK_SLACK_MS) {
          target = drafts[index];
          break;
        }
      }
    }
    markers.push({ marker, group: (target ?? drafts[0]).group });
  }
  const newest = [...markers].sort((a, b) => time(b.marker.at) - time(a.marker.at)).slice(0, MAX_MARKERS);
  for (const { marker, group } of newest) {
    if (sinceMs && time(marker.at) <= sinceMs) {
      hidden += 1;
      continue;
    }
    ensure(group).rows.push(marker);
  }

  if (running && runningGroup) ensure(runningGroup).running = true;

  // Each group: its rows from the newest to the oldest, what they add up to, and the verdict of the round.
  const resultFor = (group: TimelineGroup, rows: readonly TimelineRow[]): RoundResult | null => {
    const written = resultOf(rows);
    if (group.kind === "final") return finalReview ? { verdict: finalReview.verdict, score: finalReview.score } : written;
    if (group.kind !== "chapter" || group.chapterNumber === undefined || group.round === undefined) return written;
    const record = usable.get(group.chapterNumber);
    return withRecord(written, record && group.round >= 1 && group.round <= record.length ? record[group.round - 1] : undefined);
  };
  const list: TimelineGroup[] = [];
  for (const group of groups.values()) {
    const rows = group.rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => rowTime(b.row) - rowTime(a.row) || b.index - a.index)
      .map((entry) => entry.row);
    const stepTimes = rows.filter((row) => row.kind === "step").map(rowTime);
    const at = stepTimes.length ? Math.max(...stepTimes) : rows.length ? rowTime(rows[0]) : time(running?.startedAt);
    list.push({ ...group, rows, ...statsOf(rows), result: resultFor(group, rows), at });
  }
  list.sort((a, b) => Number(b.running) - Number(a.running) || b.at - a.at);
  const steps = list.reduce((sum, group) => sum + group.steps, 0);
  return { groups: list, steps, hidden, open: list.find((group) => group.running)?.key ?? list[0]?.key ?? null };
}

const keeps = (row: TimelineRow, filter: TimelineFilter): boolean => {
  if (filter === "all") return true;
  if (filter === "problems") return row.problem;
  return row.kind === "step" && row.category === filter;
};

/** Only the rows a filter shows, and no group left without any (but the one that runs, which is the one that is open). */
export function filterTimeline(timeline: Timeline, filter: TimelineFilter): Timeline {
  if (filter === "all") return timeline;
  const groups: TimelineGroup[] = [];
  for (const group of timeline.groups) {
    const rows = group.rows.filter((row) => keeps(row, filter));
    if (rows.length || group.running) groups.push({ ...group, rows, ...statsOf(rows) });
  }
  return { ...timeline, groups, steps: groups.reduce((sum, group) => sum + group.steps, 0), open: groups.find((group) => group.running)?.key ?? groups[0]?.key ?? null };
}

/** How many rows each filter would show. */
export function filterCounts(timeline: Timeline): Record<TimelineFilter, number> {
  const counts = { all: 0, problems: 0, director: 0, readers: 0, writing: 0 } satisfies Record<TimelineFilter, number>;
  for (const group of timeline.groups) {
    for (const row of group.rows) {
      for (const filter of TIMELINE_FILTERS) if (keeps(row, filter)) counts[filter] += 1;
    }
  }
  return counts;
}

/** The size of the window of rows of a group after the author asks for more. */
export function nextLimit(current: number, total: number): number {
  return Math.min(current + ROW_STEP, MAX_ROWS, total);
}

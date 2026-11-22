import { act } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_OPTIONS, type AutopilotActivity, type AutopilotEvent, type AutopilotPhase, type AutopilotState, type AutopilotStats, type ChapterReview, type PlannedChapter } from "narrarium-engine";
import { useAutopilotStore } from "@/autopilot/store";
import { longPlan, planOf } from "./autopilotFixtures";
import { LOCAL_BOOK, T0, seedBar, type BarSeed } from "./quickCommands";

/** The moment the fake clock of the tests stands at: 86 seconds after a step that started at `T0`. */
export const NOW = "2026-11-21T10:01:26.000Z";

export function activityOf(task: AutopilotActivity["task"], patch: Partial<AutopilotActivity> = {}): AutopilotActivity {
  return { id: `activity-${task}-${patch.chapterNumber ?? 0}-${patch.sceneNumber ?? 0}-${patch.startedAt ?? T0}`, runId: "run-1", task, phase: "write", title: "", reason: "", next: "", status: "succeeded", startedAt: T0, endedAt: "2026-11-21T10:00:30.000Z", ...patch };
}

/** A step that is running now, started at `T0` (so that it has been going on for 86 seconds at `NOW`). */
export function runningStep(task: AutopilotActivity["task"], title: string, patch: Partial<AutopilotActivity> = {}): AutopilotActivity {
  return activityOf(task, { id: `live-${task}`, title, status: "running", endedAt: undefined, startedAt: T0, ...patch });
}

export interface RunSeed extends BarSeed {
  /** The chapters of the plan; by default twelve, four of them approved and the fifth being written. */
  chapters?: PlannedChapter[];
  phase?: AutopilotPhase;
  message?: string | null;
  review?: ChapterReview | null;
  options?: Partial<AutopilotState["options"]>;
  stats?: Partial<AutopilotStats>;
  activities?: AutopilotActivity[];
  /** The step that runs now, with the text it streams. */
  live?: { activity: AutopilotActivity; characters?: number; preview?: string } | null;
  feed?: AutopilotEvent[];
}

/** The autopilot of one book in the middle of its work: what the page, the band and the live panel read, in one call. */
export function seedRun(seed: RunSeed = {}) {
  const chapters = seed.chapters ?? longPlan(12, 4);
  const statePatch: Partial<AutopilotState> = {
    plan: planOf(chapters),
    phase: seed.phase ?? "write",
    message: seed.message ?? null,
    review: seed.review ?? null,
    stats: { tasks: 30, aiCalls: 40, inputTokens: 90_000, outputTokens: 20_000, cost: 0.5, currency: "USD", failures: 0, ...seed.stats },
    options: { ...DEFAULT_OPTIONS, ...seed.options },
    ...seed.statePatch,
  };
  const seeded = seedBar({ ...seed, statePatch });
  const id = seeded.book.id;
  useAutopilotStore.setState((store) => {
    const view = store.views[id];
    return {
      views: { ...store.views, [id]: { ...view, snapshot: { ...view.snapshot!, activities: seed.activities ?? [], live: seed.live ? { activity: seed.live.activity, characters: seed.live.characters ?? 0, preview: seed.live.preview ?? "" } : null } } },
      live: { [id]: seed.live ? { activity: seed.live.activity, characters: seed.live.characters ?? 0, preview: seed.live.preview ?? "" } : null },
      feed: (seed.feed ?? []).map((event) => ({ event, bookTitle: seeded.book.name })),
    };
  });
  return seeded;
}

export const eventOf = (body: Record<string, unknown>, seq: number, bookId = LOCAL_BOOK.id) => ({ bookId, at: new Date(Date.parse(T0) + seq * 1000).toISOString(), seq, ...body }) as AutopilotEvent;
export const ingest = (event: AutopilotEvent, title = LOCAL_BOOK.name) => act(() => { useAutopilotStore.getState().ingest(event, title); });

export const finishedEvent = (activity: AutopilotActivity, seq: number, bookId = LOCAL_BOOK.id) => eventOf({ type: "task-finished", activity: { ...activity, status: "succeeded", endedAt: "2026-11-21T10:01:00.000Z" } }, seq, bookId);

/** A fake clock that moves only the date: the timers and the promises of the tests stay as they are. */
export function freezeClock(at = NOW): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
}

/**
 * A page of the width of a phone, or of whatever width: `ResizeObserver` tells whoever watches an element that it is `width` pixels wide
 * as soon as it starts to. Radix asks for it too, so it has the rest of the interface.
 */
export function stubWidth(width: number): void {
  vi.stubGlobal("ResizeObserver", class {
    private readonly callback: (entries: Array<{ target: Element; contentRect: { width: number; height: number } }>) => void;
    constructor(callback: (entries: Array<{ target: Element; contentRect: { width: number; height: number } }>) => void) { this.callback = callback; }
    observe(target: Element) { this.callback([{ target, contentRect: { width, height: 800 } }]); }
    unobserve() {}
    disconnect() {}
  });
}

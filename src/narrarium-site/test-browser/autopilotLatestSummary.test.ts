import { describe, expect, it } from "vitest";
import { createAutopilotState, summarizeAutopilotState, type AutopilotState, type AutopilotStateSummary } from "narrarium-engine";
import { latestSummary } from "@/autopilot/summary";
import { selectAutopilotControl } from "@/autopilot/useAutopilotControl";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T10:01:00.000Z";
const state = (patch: Partial<AutopilotState> = {}): AutopilotState => ({ ...createAutopilotState(new Date(T0)), status: "running", phase: "write", updatedAt: T0, ...patch });
const live = (patch: Partial<AutopilotStateSummary> = {}, state_ = state()): AutopilotStateSummary => ({ ...summarizeAutopilotState(state_), ...patch });

describe("the summary the page follows", () => {
  it("is the one of the newest event, also when it has the time of the downloaded state: a pause that waits does not write the state", () => {
    const downloaded = state();
    const event = live({ pausePending: "after-chapter", publish: "step" });
    expect(event.updatedAt).toBe(downloaded.updatedAt);
    expect(latestSummary(downloaded, event)).toBe(event);
    expect(latestSummary(downloaded, event)?.pausePending).toBe("after-chapter");
  });

  it("is the downloaded state when it is newer than the last event", () => {
    const old = live({ pausePending: "after-step" });
    const newer = state({ updatedAt: T1, status: "paused" });
    expect(latestSummary(newer, old)).toMatchObject({ status: "paused", updatedAt: T1 });
    expect(latestSummary(newer, old)?.pausePending).toBeUndefined();
  });

  it("is a summary from an event that is newer than the downloaded state", () => {
    const event = live({ updatedAt: T1, progress: { chapters: 3, chaptersDone: 1, scenes: 6, scenesWritten: 2, words: 900 } });
    expect(latestSummary(state(), event)).toBe(event);
  });

  it("takes what the engine says of its own session, from the download, when no event was heard: the state alone cannot say the pause, the limits or where the book is published", () => {
    const downloaded = state();
    const fromTheSession = live({ pausePending: "after-step", limits: { steps: 2, stepsDone: 1, chaptersDone: 0 }, publish: "chapter" });
    expect(latestSummary(downloaded, undefined, fromTheSession)).toBe(fromTheSession);
  });

  it("does not take the summary of a download for another state of the book", () => {
    const stale = live({ pausePending: "after-step", updatedAt: T0 });
    expect(latestSummary(state({ updatedAt: T1 }), undefined, stale)?.pausePending).toBeUndefined();
  });

  it("is nothing for a book whose autopilot was not downloaded or was reset", () => {
    expect(latestSummary(null, live())).toBeNull();
    expect(latestSummary(null, undefined, live())).toBeNull();
  });
});

describe("who can command the run, reading the summary the page follows", () => {
  it("still reads a run of this client as one that can be commanded when the summary says what waits", () => {
    const summary = live({ pausePending: "after-step" });
    const control = selectAutopilotControl({ snapshot: { bookId: "b", state: state(), activities: [], live: null, running: true, host: null }, busyInAnotherTab: false, summary, lastSignal: undefined }, Date.now());
    expect(control).toMatchObject({ running: true, controllable: true });
    expect(control.summary?.pausePending).toBe("after-step");
  });
});

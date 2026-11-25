import { describe, expect, it } from "vitest";
import type { AutopilotActivity } from "narrarium-engine";
import { attemptCost, emptyCostView, joinCosts, liveStepCost, runCost, runIdOf, stepCost } from "@/autopilot/costModel";
import type { TaskCost } from "@/autopilot/taskCosts";

const RELABEL = { from: "USD", to: "EUR", until: "2026-11-25T12:00:00.000Z" };

function activity(id: string, patch: Partial<AutopilotActivity> = {}): AutopilotActivity {
  return { id, runId: "run-1", task: "write", phase: "write", title: id, reason: "", next: "", status: "succeeded", startedAt: "2026-11-21T10:00:00.000Z", endedAt: "2026-11-21T10:00:30.000Z", ...patch };
}

function record(task: string, patch: Partial<TaskCost> = {}): TaskCost {
  return { bookId: "book-1", task, calls: 1, money: { EUR: 0.004 }, estimated: {}, inputTokens: 1000, cachedTokens: 200, outputTokens: 300, estimatedTokens: 0, unpricedCalls: 0, unknownUsageCalls: 0, models: ["gpt-5"], unpriced: [], at: "2026-11-21T10:00:30.000Z", ...patch };
}

const tasksOf = (...records: TaskCost[]) => Object.fromEntries(records.map((entry) => [`${entry.bookId}\u0000${entry.task}`, entry]));

describe("what an attempt of a step cost", () => {
  it("is this browser's record of its calls when this browser ran it", () => {
    const view = attemptCost(activity("a1", { cost: 9 }), record("a1", { calls: 3, unpricedCalls: 1, unpriced: [{ integrationId: "int-2", model: "free" }] }), "USD");
    expect(view).toEqual({ money: { EUR: 0.004 }, estimated: {}, calls: 3, inputTokens: 1000, cachedTokens: 200, outputTokens: 300, estimatedTokens: 0, unpricedCalls: 1, unknownUsageCalls: 0, unpriced: [{ integrationId: "int-2", model: "free" }], source: "device" });
  });

  it("is the engine's record of it when it ran elsewhere: its cost in the currency the run recorded, its tokens, and no calls, which are not known here", () => {
    const view = attemptCost(activity("a1", { cost: 0.02, usage: { inputTokens: 800, cachedInputTokens: 100, outputTokens: 200 } as AutopilotActivity["usage"] }), undefined, "USD");
    expect(view).toMatchObject({ money: { USD: 0.02 }, calls: null, inputTokens: 800, cachedTokens: 100, outputTokens: 200, source: "autopilot" });
  });

  it("is nothing for a step that spent nothing, and has no money where no currency was recorded", () => {
    expect(attemptCost(activity("a1"), undefined, "USD")).toEqual(emptyCostView());
    expect(attemptCost(activity("a1", { cost: 0.02 }), undefined, undefined).money).toEqual({});
  });

  it("shows relabelled what a relabel names, by the moment of the record or of the step", () => {
    expect(attemptCost(activity("a1"), record("a1", { money: { USD: 0.01 } }), "USD", [RELABEL]).money).toEqual({ "USD>EUR": 0.01 });
    expect(attemptCost(activity("a1"), record("a1", { money: { USD: 0.01 }, at: "2026-11-30T10:00:00.000Z" }), "USD", [RELABEL]).money, "recorded after the relabel").toEqual({ USD: 0.01 });
    expect(attemptCost(activity("a1", { cost: 0.02 }), undefined, "USD", [RELABEL]).money).toEqual({ "USD>EUR": 0.02 });
  });
});

describe("what a step and a run cost", () => {
  it("adds the attempts of a step, the retries and the billed fallbacks, money by currency and the models without a price once each", () => {
    const tasks = tasksOf(
      record("a1", { calls: 2, unpricedCalls: 1, unpriced: [{ integrationId: "int-2", model: "free" }] }),
      record("a2", { calls: 1, money: { USD: 0.003 }, unpricedCalls: 1, unpriced: [{ integrationId: "int-2", model: "free" }] }),
    );
    const view = stepCost("book-1", [activity("a1", { status: "failed" }), activity("a2")], tasks, "EUR");
    expect(view).toMatchObject({ money: { EUR: 0.004, USD: 0.003 }, calls: 3, inputTokens: 2000, unpricedCalls: 2, unpriced: [{ integrationId: "int-2", model: "free" }], source: "device" });
    expect(stepCost(undefined, [activity("a1"), activity("a2")], tasks, "EUR"), "found by the activities alone").toEqual(view);
  });

  it("says the calls only while every attempt knows them, and where the numbers come from", () => {
    const mixed = stepCost("book-1", [activity("a1"), activity("a2", { cost: 0.01 })], tasksOf(record("a1")), "EUR");
    expect(mixed).toMatchObject({ calls: null, source: "mixed" });
    expect(mixed.money.EUR).toBeCloseTo(0.014, 12);
    expect(joinCosts([]).source).toBe("none");
    expect(joinCosts([emptyCostView(), attemptCost(activity("a2", { cost: 0.01 }), undefined, "EUR")]).source).toBe("autopilot");
  });

  it("speaks of the run that runs, else of the newest one there is a step of", () => {
    expect(runIdOf("run-9", [activity("a1")])).toBe("run-9");
    expect(runIdOf(null, [activity("a1", { runId: "run-1", startedAt: "2026-11-21T10:00:00.000Z" }), activity("a2", { runId: "run-2", startedAt: "2026-11-21T11:00:00.000Z" })])).toBe("run-2");
    expect(runIdOf(undefined, [])).toBeNull();
  });

  it("adds the steps of the run and the step that runs now, a step that is both counted once, and no step of another run", () => {
    const tasks = tasksOf(record("a1"), record("a2"), record("live"), record("other", { money: { EUR: 5 } }));
    const steps = [activity("a1"), activity("a2"), activity("other", { runId: "run-0" })];
    const live = activity("live", { status: "running", endedAt: undefined });
    expect(runCost("book-1", "run-1", steps, live, tasks, "EUR").money.EUR).toBeCloseTo(0.012, 12);
    expect(runCost("book-1", "run-1", [...steps, live], live, tasks, "EUR").money.EUR, "saved while it is still shown").toBeCloseTo(0.012, 12);
    expect(runCost("book-1", "run-1", steps, activity("live", { runId: "run-0" }), tasks, "EUR").money.EUR).toBeCloseTo(0.008, 12);
    expect(runCost("book-1", null, steps, live, tasks, "EUR")).toEqual(emptyCostView());
  });

  it("says what the step that runs spent so far only when this browser records its calls", () => {
    const live = activity("live", { status: "running", endedAt: undefined, cost: 0.5 });
    expect(liveStepCost("book-1", live, tasksOf(record("live", { calls: 4 }))) ).toMatchObject({ calls: 4, money: { EUR: 0.004 }, source: "device" });
    expect(liveStepCost("book-1", live, {})).toBeNull();
    expect(liveStepCost("book-1", null, tasksOf(record("live")))).toBeNull();
  });
});

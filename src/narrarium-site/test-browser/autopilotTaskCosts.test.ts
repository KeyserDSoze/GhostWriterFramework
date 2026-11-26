import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TASKS, boundTasks, resetTaskCosts, taskCostByTask, taskCostOf, useTaskCosts, withCall, type TaskCost } from "@/autopilot/taskCosts";
import { recordUsage, type RecordedUsage, type UsageRecord } from "@/costs/recordUsage";
import { ownCallTask } from "@/costs/usageTasks";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { resetCosts } from "./helpers/costs";

const STORAGE_KEY = "narrarium-task-costs-v1";
const AT = "2026-11-21T10:00:30.000Z";

/** A call of a step of the autopilot of `book-1`: priced, with its tokens reported. */
const CALL: UsageRecord = { origin: "autopilot", bookId: "book-1", task: "activity-1", capability: "autopilot", integrationId: "int-1", model: "gpt-5", usage: { inputTokens: 1000, cachedTokens: 200, outputTokens: 300 }, usageKnown: true, cost: 0.004, costKnown: true, priced: true, currency: "EUR" };

/** What the recorder hears of a call: its record, its source and the row it adds. */
function heard(patch: Partial<UsageRecord> = {}): RecordedUsage {
  return recordUsage({ ...CALL, ...patch });
}

beforeEach(() => {
  localStorage.clear();
  resetCosts();
  resetTaskCosts();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, costCurrency: "EUR" } });
});

afterEach(() => {
  resetTaskCosts();
  localStorage.clear();
});

describe("what a step of a run of this browser used, call by call", () => {
  it("counts its calls, its money by currency and its tokens, as the recorder heard them", () => {
    const first = withCall(undefined, heard(), AT);
    expect(first).toEqual({
      bookId: "book-1", task: "activity-1", calls: 1, money: { EUR: 0.004 }, estimated: {}, inputTokens: 1000, cachedTokens: 200, outputTokens: 300,
      estimatedTokens: 0, unpricedCalls: 0, unknownUsageCalls: 0, models: ["gpt-5"], unpriced: [], at: AT,
    });
    const second = withCall(first, heard({ cost: 0.006, usage: { inputTokens: 500, cachedTokens: 0, outputTokens: 100 } }), "2026-11-21T10:00:40.000Z");
    expect(second).toMatchObject({ calls: 2, inputTokens: 1500, outputTokens: 400, models: ["gpt-5"], at: "2026-11-21T10:00:40.000Z" });
    expect(second.money.EUR).toBeCloseTo(0.01, 12);
  });

  it("keeps the money of another currency apart, never added to the first", () => {
    const step = withCall(withCall(undefined, heard(), AT), heard({ currency: "USD", cost: 0.002 }), AT);
    expect(step.money).toEqual({ EUR: 0.004, USD: 0.002 });
  });

  it("lists the models asked in the order of their first call, and the ones without a price once each, with their integration", () => {
    let step = withCall(undefined, heard(), AT);
    step = withCall(step, heard({ integrationId: "int-2", model: "free-model", priced: false, cost: undefined, costKnown: false }), AT);
    step = withCall(step, heard({ integrationId: "int-2", model: "free-model", priced: false, cost: undefined, costKnown: false }), AT);
    expect(step.models).toEqual(["gpt-5", "free-model"]);
    expect(step.unpriced).toEqual([{ integrationId: "int-2", model: "free-model" }]);
    expect(step.unpricedCalls).toBe(2);
    expect(step.money, "a call without a price adds no money").toEqual({ EUR: 0.004 });
  });

  it("keeps what the calls whose tokens were not reported are estimated to have used apart from what was measured", () => {
    const step = withCall(withCall(undefined, heard(), AT), heard({ usageKnown: false, costKnown: false, cost: 0.001, usage: { inputTokens: 400, cachedTokens: 0, outputTokens: 100 } }), AT);
    expect(step).toMatchObject({ calls: 2, unknownUsageCalls: 1, estimatedTokens: 500, estimated: { EUR: 0.001 }, money: { EUR: 0.004 }, inputTokens: 1000, outputTokens: 300 });
  });

  it("counts a failed attempt that used nothing as a call, and as nothing else", () => {
    const step = withCall(undefined, heard({ usage: null, usageKnown: false, cost: undefined, costKnown: false }), AT);
    expect(step).toMatchObject({ calls: 1, money: {}, estimated: {}, inputTokens: 0, unknownUsageCalls: 0, unpricedCalls: 0 });
  });

  it("keeps the newest steps only, by the end of their last call", () => {
    const tasks: Record<string, TaskCost> = {};
    for (let index = 0; index < MAX_TASKS + 5; index += 1) {
      const at = new Date(Date.parse(AT) + index * 1000).toISOString();
      tasks[`book-1\u0000activity-${index}`] = { ...withCall(undefined, heard({ task: `activity-${index}` }), at) };
    }
    const kept = boundTasks(tasks);
    expect(Object.keys(kept)).toHaveLength(MAX_TASKS);
    expect(kept["book-1\u0000activity-0"], "the oldest is forgotten").toBeUndefined();
    expect(kept[`book-1\u0000activity-${MAX_TASKS + 4}`]).toBeDefined();
    const few = { a: tasks["book-1\u0000activity-1"] };
    expect(boundTasks(few), "a few are kept as they are").toBe(few);
  });
});

describe("the steps are kept as the recorder hears the calls", () => {
  it("keeps a call of a step of the autopilot with its step, found by its book or by its activity alone", () => {
    recordUsage(CALL);
    recordUsage({ ...CALL, cost: 0.001 });
    const tasks = useTaskCosts.getState().tasks;
    expect(taskCostOf(tasks, "book-1", "activity-1")).toMatchObject({ calls: 2, bookId: "book-1", task: "activity-1" });
    expect(taskCostOf(tasks, "book-2", "activity-1")).toBeUndefined();
    expect(taskCostByTask(tasks, "activity-1")).toMatchObject({ calls: 2 });
    expect(taskCostByTask(tasks, "activity-2")).toBeUndefined();
  });

  it("keeps nothing of a call that is not of a step of the autopilot: the Copilot's, a feature's, a run's call outside its steps", () => {
    recordUsage({ ...CALL, origin: "copilot", task: "copilot-1" });
    recordUsage({ ...CALL, origin: undefined, task: undefined, capability: "editor-actions" });
    recordUsage({ ...CALL, task: ownCallTask() });
    recordUsage({ ...CALL, bookId: "" });
    expect(useTaskCosts.getState().tasks).toEqual({});
  });

  it("writes them at once when the page is left or put away right after a call, without waiting for the moment it waits for", () => {
    recordUsage(CALL);
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"), "reloaded or closed").toHaveProperty(["book-1\u0000activity-1", "calls"], 1);

    localStorage.clear();
    recordUsage({ ...CALL, cost: 0.001 });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    visibility.mockRestore();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"), "put away").toHaveProperty(["book-1\u0000activity-1", "calls"], 2);
  });

  it("keeps them on this device, and reads what another tab of this browser wrote", async () => {
    recordUsage(CALL);
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toHaveProperty(["book-1\u0000activity-1", "calls"], 1), { timeout: 20_000 });

    const other = { "book-1\u0000activity-9": { ...useTaskCosts.getState().tasks["book-1\u0000activity-1"], task: "activity-9", calls: 7 } };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(other));
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    expect(taskCostOf(useTaskCosts.getState().tasks, "book-1", "activity-9")).toMatchObject({ calls: 7 });

    localStorage.setItem(STORAGE_KEY, "not json");
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    expect(useTaskCosts.getState().tasks, "what cannot be read is nothing").toEqual({});
  });
});

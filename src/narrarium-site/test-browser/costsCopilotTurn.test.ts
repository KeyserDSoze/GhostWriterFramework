import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeTextRouted, completeToolRouted } from "@/assistant/router";
import { resetTaskCosts, useTaskCosts } from "@/autopilot/taskCosts";
import { useCostsStore } from "@/costs/costsStore";
import { ledgerRows } from "@/costs/ledger";
import { beginUsageTask, isOwnCallTask, ownCallTask, usageTaskOf } from "@/costs/usageTasks";
import { assertProvidersClean, type ProviderCall } from "./helpers/fakeProvider";
import { compatible, SCHEMA } from "./helpers/aiFixtures";
import { MESSAGES, provide, resetStores, routeOf, speak, speakCall } from "./helpers/copilotHarness";

const rows = () => ledgerRows(useCostsStore.getState().file.ledger);
const total = (field: "calls" | "tasks") => rows().reduce((sum, row) => sum + row[field], 0);

describe("the task a call belongs to, by the signal of its request", () => {
  it("is the task begun on that signal, and none for another signal or none", () => {
    const turn = new AbortController();
    const end = beginUsageTask(turn.signal, { task: "copilot-1", origin: "copilot" });
    expect(usageTaskOf(turn.signal)).toEqual({ task: "copilot-1", origin: "copilot" });
    expect(usageTaskOf(new AbortController().signal)).toBeUndefined();
    expect(usageTaskOf(undefined)).toBeUndefined();
    end();
    expect(usageTaskOf(turn.signal), "the turn ended").toBeUndefined();
  });

  it("is never ended by an older turn on the same signal", () => {
    const turn = new AbortController();
    const endFirst = beginUsageTask(turn.signal, { task: "copilot-1", origin: "copilot" });
    beginUsageTask(turn.signal, { task: "copilot-2", origin: "copilot" });
    endFirst();
    expect(usageTaskOf(turn.signal)).toEqual({ task: "copilot-2", origin: "copilot" });
  });

  it("is a task of its own for a call that belongs to none, each one different", () => {
    const one = ownCallTask();
    expect(isOwnCallTask(one)).toBe(true);
    expect(ownCallTask()).not.toBe(one);
    expect(isOwnCallTask("copilot-1")).toBe(false);
    expect(isOwnCallTask("activity-1")).toBe(false);
  });
});

describe("one turn of the Copilot is one task, its whole tool loop included", () => {
  const a = compatible("a");
  const reply = (call: ProviderCall) => (call.body?.tools ? speakCall({ ok: true })(call) : speak("ok")(call));

  beforeEach(() => {
    resetStores();
    resetTaskCosts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    assertProvidersClean();
  });

  it("counts every call of a turn, a tool call included, under one task of the Copilot, and a request outside a turn as a task of its own", async () => {
    provide([a], reply);
    const turn = new AbortController();
    const end = beginUsageTask(turn.signal, { task: "copilot-turn-1", origin: "copilot" });
    await completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, signal: turn.signal });
    await completeToolRouted(routeOf("default", [a]), MESSAGES, "default", SCHEMA, { accountScope: null, signal: turn.signal, label: "pipeline:refine-prose" });
    await completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, signal: turn.signal });
    end();
    await vi.waitFor(() => expect(total("calls")).toBe(3));
    expect(total("tasks"), "the three calls of the turn are one task").toBe(1);
    expect(rows().every((row) => row.source === "copilot" && row.bookId === "book-1"), "a tool the turn ran is the Copilot's too").toBe(true);

    await completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, signal: new AbortController().signal });
    await completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null });
    await vi.waitFor(() => expect(total("calls")).toBe(5));
    expect(total("tasks"), "each request outside a turn is a task of its own").toBe(3);
    expect(useTaskCosts.getState().tasks, "no call of the Copilot is a step of the autopilot").toEqual({});
  });
});

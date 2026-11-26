import { describe, expect, it } from "vitest";
import type { AutopilotStats } from "narrarium-engine";
import { bookAutopilotOf } from "@/components/costs/dashboard/useBookAutopilots";

const stats = (cost: number): AutopilotStats => ({ tasks: 1, aiCalls: 2, inputTokens: 3, outputTokens: 4, cost, failures: 0, currency: "USD" }) as AutopilotStats;
const state = (cost: number, at: string, budgetLimit = 5) => ({ status: "paused", updatedAt: at, options: { budgetLimit }, stats: stats(cost) });
const view = (patch: Record<string, unknown>) => ({ snapshot: { bookId: "b", state: null, summary: null, activities: [], live: null, running: false, host: null, ...patch } });

describe("what the dashboard knows of a book's autopilot", () => {
  it("knows nothing until the store holds something of the book", () => {
    expect(bookAutopilotOf({ views: {}, summaries: {} }, "b")).toEqual({ read: false, status: null, options: null, stats: null, publish: null, limitReached: null });
  });

  it("is read, with no status, for a book whose autopilot never started", () => {
    const known = bookAutopilotOf({ views: { b: view({}) } as never, summaries: {} }, "b");
    expect(known).toMatchObject({ read: true, status: null, options: null, stats: null });
  });

  it("takes the budget from the saved state and the spend from the newest of the saved summary and the live one", () => {
    const saved = state(1, "2026-11-26T10:00:00.000Z");
    const views = { b: view({ state: saved, summary: { status: "paused", stats: stats(1), updatedAt: saved.updatedAt, publish: "chapter" } }) } as never;
    expect(bookAutopilotOf({ views, summaries: {} }, "b")).toMatchObject({ read: true, status: "paused", options: { budgetLimit: 5 }, stats: { cost: 1 }, publish: "chapter" });
    const live = { status: "running", stats: stats(2.5), updatedAt: "2026-11-26T10:05:00.000Z", publish: "step" } as never;
    expect(bookAutopilotOf({ views, summaries: { b: live } }, "b"), "a live summary newer than the saved state").toMatchObject({ status: "running", stats: { cost: 2.5 }, publish: "step", options: { budgetLimit: 5 } });
    const older = { status: "running", stats: stats(9), updatedAt: "2026-11-26T09:00:00.000Z" } as never;
    expect(bookAutopilotOf({ views, summaries: { b: older } }, "b"), "an older one is not believed").toMatchObject({ status: "paused", stats: { cost: 1 } });
  });

  it("knows a book from its live summary alone (a book on the personal server that has not sent its state)", () => {
    const live = { status: "running", stats: stats(0.5), updatedAt: "2026-11-26T10:05:00.000Z" } as never;
    expect(bookAutopilotOf({ views: {}, summaries: { b: live } }, "b")).toMatchObject({ read: true, status: "running", options: null, stats: { cost: 0.5 } });
  });

  it("takes the limit that stopped the run, with the numbers the engine compared, from the newest of the saved state and the live summary, and drops it once a start takes it away", () => {
    const stopped = { kind: "money", used: 5.02, limit: 5, currency: "USD", at: "2026-11-26T10:00:00.000Z" };
    const saved = { ...state(5.02, "2026-11-26T10:00:00.000Z"), limitReached: stopped };
    const views = { b: view({ state: saved, summary: { status: "paused", stats: stats(5.02), updatedAt: saved.updatedAt, limitReached: stopped } }) } as never;
    expect(bookAutopilotOf({ views, summaries: {} }, "b").limitReached).toEqual(stopped);
    const restarted = { status: "running", stats: stats(5.02), updatedAt: "2026-11-26T10:05:00.000Z" } as never;
    expect(bookAutopilotOf({ views, summaries: { b: restarted } }, "b").limitReached, "a start takes it away").toBeNull();
    expect(bookAutopilotOf({ views: { b: view({ state: state(1, "2026-11-26T10:00:00.000Z") }) } as never, summaries: {} }, "b").limitReached).toBeNull();
  });
});

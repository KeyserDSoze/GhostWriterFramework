import { describe, expect, it, vi } from "vitest";
import { createRoutingExecutionBudget } from "@/assistant/routingExecutionBudget";
import { DEFAULT_SETTINGS } from "@/types/settings";

describe("operation-wide routing budgets", () => {
  it("accumulates token attempts and estimated cost across calls", () => {
    const settings = { ...DEFAULT_SETTINGS, routingExecution: { maxCandidates: 2, maxTotalDurationMs: 1_000, maxTokenAttempts: 10, maxEstimatedCost: 1 } };
    const budget = createRoutingExecutionBudget(settings);
    budget.reserve({ tokens: 6, cost: 0.4 });
    expect(() => budget.reserve({ tokens: 5, cost: 0.4 })).toThrowError(expect.objectContaining({ name: "RoutingExecutionBudgetError" }));
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  it("aborts from the configured total duration", async () => {
    vi.useFakeTimers();
    const settings = { ...DEFAULT_SETTINGS, routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxTotalDurationMs: 5 } };
    const budget = createRoutingExecutionBudget(settings);
    await vi.advanceTimersByTimeAsync(5);
    expect(budget.signal.reason).toMatchObject({ name: "RoutingExecutionBudgetError" });
    budget.dispose();
    vi.useRealTimers();
  });
});

import { describe, expect, it } from "vitest";
import type { AutopilotErrorDetail, AutopilotRouteStep } from "narrarium-engine";
import { errorFacts, routeOf, routeTellsMore, timeoutOf } from "@/autopilot/errorModel";

const step = (patch: Partial<AutopilotRouteStep> = {}): AutopilotRouteStep => ({ position: 0, integrationId: "a", integrationName: "Alpha", provider: "openai", model: "alpha-model", outcome: "failed", ...patch });

describe("the route of a failure", () => {
  it("is what the detail says, in order, and nothing when it says none", () => {
    expect(routeOf({})).toEqual([]);
    expect(routeOf({ route: "garbage" } as unknown as AutopilotErrorDetail)).toEqual([]);
    const route = [step(), step({ position: 1, model: "beta-model" })];
    expect(routeOf({ route })).toBe(route);
  });

  it("tells more than the facts of the last candidate when there were several, or when one was left out, and not for one candidate asked alone", () => {
    expect(routeTellsMore([])).toBe(false);
    expect(routeTellsMore([step()])).toBe(false);
    expect(routeTellsMore([step(), step({ position: 1 })])).toBe(true);
    expect(routeTellsMore([step({ position: 1, outcome: "left-out", leftOut: "budget" })])).toBe(true);
  });

  it("says the deadline that ran out was the routing time that was left only when the last candidate that was asked says it", () => {
    const timeout = { timeoutPhase: "total" as const, timeoutMs: 179_800 };
    expect(timeoutOf({ ...timeout })).toEqual({ phase: "total", ms: 179_800 });
    expect(timeoutOf({ ...timeout, route: [step({ outcome: "timeout", routing: true })] })).toEqual({ phase: "total", ms: 179_800, routing: true });
    expect(timeoutOf({ ...timeout, route: [step({ outcome: "timeout", routing: true }), step({ position: 1, outcome: "left-out", leftOut: "out-of-time" })] })).toEqual({ phase: "total", ms: 179_800, routing: true });
    expect(timeoutOf({ ...timeout, route: [step({ outcome: "timeout", routing: true }), step({ position: 1, outcome: "timeout" })] })).toEqual({ phase: "total", ms: 179_800 });
    expect(timeoutOf({})).toBeNull();
  });

  it("leaves the endpoint, the model, the provider and the integration out of the facts when the route lists them all, and keeps the status and the retry", () => {
    const detail: AutopilotErrorDetail = { endpoint: "https://beta.example.test", model: "beta-model", provider: "openai", integration: "b", status: 503, attempt: 2, retries: 3 };
    expect(errorFacts(detail).map((fact) => fact.key)).toEqual(["endpoint", "model", "provider", "integration", "status", "attempt"]);
    expect(errorFacts(detail, undefined, true).map((fact) => fact.key)).toEqual(["status", "attempt"]);
  });
});

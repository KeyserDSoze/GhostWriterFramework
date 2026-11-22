import { describe, expect, it } from "vitest";
import { AI_CAPABILITIES } from "narrarium-engine";
import { AUTOPILOT_TASKS, toolsOnlyReport } from "@/router/toolsOnly";
import { DEFAULT_SETTINGS, type AIIntegration, type AppSettings, type ChatModel, type RoutingTaskKind, type TaskRoute } from "@/types/settings";

const model = (name: string, extra: Partial<ChatModel> = {}): ChatModel => ({ id: `id-${name}`, name, capabilities: ["default"], ...extra });
const integration = (id: string, models: ChatModel[]): AIIntegration => ({ id, name: id.toUpperCase(), provider: "openai", endpoint: `https://${id}.example.test/v1`, apiKey: `sk-${id}-0123456789abcdef`, chatModels: models });
const settings = (integrations: AIIntegration[], taskRouting: Partial<Record<RoutingTaskKind, TaskRoute>> = {}, extra: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_SETTINGS,
  aiIntegrations: integrations,
  defaultWritingIntegrationId: integrations[0]?.id,
  taskRouting,
  ...extra,
});
const route = (...targets: Array<[string, string]>): TaskRoute => ({ primary: { integrationId: targets[0][0], model: targets[0][1] }, fallbacks: targets.slice(1).map(([integrationId, name]) => ({ integrationId, model: name })) });

const NO_TOOLS = model("lame", { supportsToolCalls: false });
const NOTHING = { blocked: [], skipped: [] };

describe("which tasks «Tools only» affects", () => {
  it("are the capabilities of the engine's agents, in the engine's order: the writer, the director, the readers, their summary, the specialists and the summaries", () => {
    expect([...AUTOPILOT_TASKS]).toEqual(Object.values(AI_CAPABILITIES));
  });

  it("are not the tasks of the Copilot and of the editor: a model without tool calls on them is not the autopilot's business", () => {
    const only = settings([integration("a", [NO_TOOLS])], { copilot: route(["a", "lame"]), "editor-actions": route(["a", "lame"]), audit: route(["a", "lame"]) });
    for (const task of ["copilot", "editor-actions", "audit"] as const) {
      expect(toolsOnlyReport(only).blocked).not.toContain(task);
      expect(toolsOnlyReport(only).skipped.map((entry) => entry.task)).not.toContain(task);
    }
  });
});

describe("what «Tools only» does to the models of a task", () => {
  it("says nothing while it is off: a model without tool calls is asked as it always was", () => {
    const off = settings([integration("a", [NO_TOOLS])], { autopilot: route(["a", "lame"]) }, { aiToolsOnly: false });
    expect(toolsOnlyReport(off)).toEqual(NOTHING);
  });

  it("says nothing when every model can call functions, or never said it cannot: only an explicit false skips", () => {
    const capable = settings([integration("a", [model("fine", { supportsToolCalls: true }), model("unsaid")])], { autopilot: route(["a", "fine"], ["a", "unsaid"]), director: route(["a", "unsaid"]) });
    expect(toolsOnlyReport(capable)).toEqual(NOTHING);
  });

  it("blocks a task whose every model is marked as without tool calls: the autopilot would stop on it with a configuration error", () => {
    const stuck = settings([integration("a", [NO_TOOLS, model("also-lame", { supportsToolCalls: false })])], { director: route(["a", "lame"], ["a", "also-lame"]) });
    expect(toolsOnlyReport(stuck).blocked).toContain("director");
    expect(toolsOnlyReport(stuck).skipped.map((entry) => entry.task)).not.toContain("director");
  });

  it("skips, and does not block, a model without tool calls that has a fallback that can: it names the model", () => {
    const mixed = settings([integration("a", [NO_TOOLS]), integration("b", [model("fine")])], { autopilot: route(["a", "lame"], ["b", "fine"]) });
    const report = toolsOnlyReport(mixed);
    expect(report.blocked).not.toContain("autopilot");
    expect(report.skipped).toContainEqual({ task: "autopilot", models: ["lame"] });
  });

  it("reads a task with no route of its own as the engine does, by the model it would take", () => {
    const lone = settings([integration("a", [model("lame", { supportsToolCalls: false })])]);
    expect(toolsOnlyReport(lone).blocked).toEqual([...AUTOPILOT_TASKS]);
  });

  it("has nothing to say about a task with no model at all: that is another error (nothing is routed to it)", () => {
    expect(toolsOnlyReport(settings([]))).toEqual(NOTHING);
  });

  it("cuts the route at the limit of candidates before it skips: a fallback beyond the limit is not there to rescue the task", () => {
    const cut = settings([integration("a", [NO_TOOLS]), integration("b", [model("fine")])], { autopilot: route(["a", "lame"], ["b", "fine"]) }, { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxCandidates: 1 } });
    expect(toolsOnlyReport(cut).blocked).toContain("autopilot");
  });

  it("keeps the content inside the primary's account when the privacy setting says so: a fallback in another account is not there to rescue the task", () => {
    const apart = settings([integration("a", [NO_TOOLS]), integration("b", [model("fine")])], { autopilot: route(["a", "lame"], ["b", "fine"]) }, { fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: false } });
    expect(toolsOnlyReport(apart).blocked).toContain("autopilot");
    const open = { ...apart, fallbackDisclosure: { sameBoundaryOnly: false, requireAcknowledgement: false } };
    expect(toolsOnlyReport(open).blocked).not.toContain("autopilot");
  });

  it("lists every task that is affected, each once, in the engine's order", () => {
    const many = settings([integration("a", [NO_TOOLS]), integration("b", [model("fine")])], {
      "simple-tasks": route(["a", "lame"]),
      autopilot: route(["a", "lame"], ["b", "fine"]),
      director: route(["b", "fine"]),
      "reader-evaluation": route(["b", "fine"]),
      "reader-evaluation-summary": route(["b", "fine"]),
      review: route(["a", "lame"]),
    });
    const report = toolsOnlyReport(many);
    expect(report.blocked).toEqual(["review", "simple-tasks"]);
    expect(report.skipped).toEqual([{ task: "autopilot", models: ["lame"] }]);
  });
});

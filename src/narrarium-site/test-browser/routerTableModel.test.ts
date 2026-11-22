import { describe, expect, it } from "vitest";
import { AI_CAPABILITIES } from "narrarium-engine";
import { BROWSER_ROUTING_ID } from "@/assistant/router";
import {
  ROUTER_SECTIONS,
  SECTION_TASKS,
  TEXT_GROUPS,
  TEXT_GROUP_IDS,
  TEXT_TASK_ORDER,
  applyBulkChange,
  buildRow,
  canAddLevel,
  clearTargetAt,
  commonModelChoices,
  countAtLevel,
  dataLevelCount,
  fillability,
  levelCount,
  modelChoicesFor,
  normalizeRoutingTarget,
  putRoute,
  removeLevel,
  swapLevels,
  takesThinking,
  targetAt,
  taskIntegrationChoices,
  tasksInGroup,
  visibleTasks,
  withTargetAt,
  type RowFilters,
  type Routing,
} from "@/router/routerTableModel";
import { CHAT_CAPABILITIES, DEFAULT_SETTINGS, ROUTING_TASKS, type AIIntegration, type AppSettings, type ChatCapability, type ChatModel, type RoutingTarget, type RoutingTaskKind, type TaskRoute } from "@/types/settings";

const model = (name: string, capabilities: ChatCapability[], extra: Partial<ChatModel> = {}): ChatModel => ({ id: `id-${name}`, name, capabilities, ...extra });

const LLM: AIIntegration = {
  id: "llm", name: "LlmProxy", provider: "openai", apiKey: "k", endpoint: "http://llm.test/v1",
  chatModels: [
    model("muse-big", ["default", "autopilot", "director", "copilot", "review"]),
    model("muse-small", ["simple-tasks", "chat-resume"]),
    model("legacy", ["default"], { supportsToolCalls: false }),
  ],
  modelSpeechToText: "whisper-large", modelTextToSpeech: "kokoro", modelImageGeneration: "sd-turbo",
};
const AZURE: AIIntegration = {
  id: "az", name: "Studio Azure", provider: "azure_openai", apiKey: "k", endpoint: "https://a.openai.azure.com",
  chatModels: [model("gpt-4o", ["default"]), model("gpt-4.1", ["default"])],
  modelSpeechToText: "whisper-1", modelTextToSpeech: "tts-1", modelImageGeneration: "gpt-image-1",
};
const GITHUB: AIIntegration = {
  id: "gh", name: "GitHub Models", provider: "github_models", apiKey: "k",
  chatModels: [model("mini", ["default", "simple-tasks"]), model("llama", ["default", "review"])],
};
const M365: AIIntegration = { id: "m365", name: "Copilot 365", provider: "m365_copilot", apiKey: "" };
const INTEGRATIONS = [LLM, AZURE, GITHUB, M365];

const to = (integrationId: string, modelName: string, thinking?: RoutingTarget["thinking"]): RoutingTarget => ({ integrationId, model: modelName, ...(thinking ? { thinking } : {}) });
const route = (primary: RoutingTarget | undefined, ...fallbacks: RoutingTarget[]): TaskRoute => ({ primary, fallbacks });
const settingsOf = (routing?: Routing, patch: Partial<AppSettings> = {}): AppSettings => ({ ...DEFAULT_SETTINGS, aiIntegrations: INTEGRATIONS, defaultWritingIntegrationId: "llm", defaultReviewIntegrationId: "llm", taskRouting: routing, ...patch });
const TEXT = SECTION_TASKS.text;

describe("the four sections and the groups of the text table", () => {
  it("has one section for text, one for each of the three media tasks, and together they cover every routable task once", () => {
    expect(ROUTER_SECTIONS).toEqual(["text", "tts", "stt", "image"]);
    expect(SECTION_TASKS.tts).toEqual(["tts"]);
    expect(SECTION_TASKS.stt).toEqual(["stt"]);
    expect(SECTION_TASKS.image).toEqual(["image"]);
    const all = ROUTER_SECTIONS.flatMap((section) => SECTION_TASKS[section]);
    expect(all).toHaveLength(ROUTING_TASKS.length);
    expect([...all].sort()).toEqual([...ROUTING_TASKS].sort());
  });

  it("lists the 14 chat tasks in the text section, the default route first, with no media task among them", () => {
    expect(TEXT).toHaveLength(14);
    expect(TEXT[0]).toBe("default");
    expect([...TEXT].sort()).toEqual([...CHAT_CAPABILITIES].sort());
    expect(TEXT).toEqual(TEXT_TASK_ORDER);
  });

  // The assignment, written out: each task sits where it is used (the engine's AI_CAPABILITIES, the Copilot, the editor, the review pages, research).
  it("documents where every chat task is used", () => {
    expect(TEXT_GROUP_IDS).toEqual(["autopilot", "copilot", "review", "research"]);
    expect(TEXT_GROUPS).toEqual({
      // What the autopilot asks the router for: the writer, the director, the simulated readers and their summary, the specialists (review) and the summaries (simple-tasks).
      autopilot: ["autopilot", "director", "reader-evaluation", "reader-evaluation-summary", "review", "simple-tasks"],
      // The interactive side: the Copilot and what it writes with the default model, the editor actions, quick decisions and the resume of chats.
      copilot: ["default", "copilot", "editor-actions", "simple-tasks", "chat-resume"],
      // The judging side: chapter and paragraph evaluations, the readers, the audit and the rewrite from the readers' feedback.
      review: ["review", "reader-evaluation", "reader-evaluation-summary", "audit", "rewrite-from-reader-feedback"],
      research: ["deep-research", "create-from-research"],
    });
  });

  it("keeps the autopilot group equal to what the engine's autopilot asks for", () => {
    expect([...TEXT_GROUPS.autopilot].sort()).toEqual([...new Set(Object.values(AI_CAPABILITIES))].sort());
  });

  it("puts every chat task in at least one group, the default route only with the Copilot, and invents no task", () => {
    const grouped = new Set(TEXT_GROUP_IDS.flatMap((group) => TEXT_GROUPS[group]));
    expect([...grouped].sort()).toEqual([...CHAT_CAPABILITIES].sort());
    expect(TEXT_GROUP_IDS.filter((group) => TEXT_GROUPS[group].includes("default"))).toEqual(["copilot"]);
    for (const group of TEXT_GROUP_IDS) expect(new Set(TEXT_GROUPS[group]).size, group).toBe(TEXT_GROUPS[group].length);
  });

  it("shows every task for \"all\", in the order of the table, and a group in its own order", () => {
    expect(tasksInGroup("all")).toEqual(TEXT_TASK_ORDER);
    expect(tasksInGroup("research")).toEqual(["deep-research", "create-from-research"]);
    expect(tasksInGroup("copilot")).toEqual(["default", "copilot", "editor-actions", "simple-tasks", "chat-resume"]);
  });
});

describe("tabs: the levels of a route", () => {
  const full = route(to("llm", "muse-big"), to("az", "gpt-4o"), to("gh", "mini"));

  it("reads level 0 as the primary and level k as fallback k", () => {
    expect(targetAt(full, 0)).toEqual(to("llm", "muse-big"));
    expect(targetAt(full, 1)).toEqual(to("az", "gpt-4o"));
    expect(targetAt(full, 2)).toEqual(to("gh", "mini"));
    expect(targetAt(full, 3)).toBeUndefined();
    expect(targetAt(undefined, 0)).toBeUndefined();
    expect(targetAt(route(undefined, to("az", "gpt-4o")), 0)).toBeUndefined();
  });

  it("says which empty cells can be filled: the primary always, a fallback only right after a filled level", () => {
    expect(fillability(undefined, 0)).toEqual({ ok: true });
    expect(fillability(undefined, 1)).toEqual({ ok: false, reason: "no-primary" });
    expect(fillability(route(to("llm", "muse-big")), 1)).toEqual({ ok: true });
    expect(fillability(route(to("llm", "muse-big")), 2)).toEqual({ ok: false, reason: "gap" });
    expect(fillability(route(to("llm", "muse-big"), to("az", "gpt-4o")), 2)).toEqual({ ok: true });
    expect(fillability(route(undefined, to("az", "gpt-4o")), 1)).toEqual({ ok: false, reason: "no-primary" });
    expect(fillability(full, 1)).toEqual({ ok: true });
  });

  it("sets and replaces a target without touching the others, and refuses to leave a hole", () => {
    expect(withTargetAt(undefined, 0, to("llm", "muse-big"))).toEqual(route(to("llm", "muse-big")));
    expect(withTargetAt(route(to("llm", "muse-big")), 1, to("az", "gpt-4o"))).toEqual(route(to("llm", "muse-big"), to("az", "gpt-4o")));
    expect(withTargetAt(full, 1, to("gh", "llama"))).toEqual(route(to("llm", "muse-big"), to("gh", "llama"), to("gh", "mini")));
    expect(() => withTargetAt(route(to("llm", "muse-big")), 2, to("az", "gpt-4o"))).toThrow(RangeError);
    expect(() => withTargetAt(undefined, 1, to("az", "gpt-4o"))).toThrow(RangeError);
  });

  it("clears a fallback and lets the next ones move up, so the fallbacks stay one after the other", () => {
    expect(withTargetAt(full, 1, undefined)).toEqual(route(to("llm", "muse-big"), to("gh", "mini")));
    expect(withTargetAt(full, 2, undefined)).toEqual(route(to("llm", "muse-big"), to("az", "gpt-4o")));
  });

  it("promotes the first fallback when the primary is cleared, and has no route left when the last target goes", () => {
    expect(withTargetAt(full, 0, undefined)).toEqual(route(to("az", "gpt-4o"), to("gh", "mini")));
    expect(withTargetAt(route(to("llm", "muse-big")), 0, undefined)).toBeUndefined();
    expect(withTargetAt(undefined, 0, undefined)).toBeUndefined();
  });

  it("stores a route under its task, and removes the task when nothing is left", () => {
    const routing: Routing = { default: route(to("llm", "muse-big")), director: route(to("az", "gpt-4o")) };
    const stored = putRoute(routing, "audit", route(to("gh", "llama")));
    expect(Object.keys(stored)).toEqual(["default", "director", "audit"]);
    expect(putRoute(stored, "audit", undefined)).toEqual(routing);
    expect(putRoute(undefined, "audit", undefined)).toEqual({});
    expect(routing).toEqual({ default: route(to("llm", "muse-big")), director: route(to("az", "gpt-4o")) });
  });

  it("counts the tabs: the primary, the deepest fallback among the rows, and the empty tabs the author added", () => {
    const routing: Routing = { default: full, director: route(to("llm", "muse-big"), to("az", "gpt-4o")), tts: route(to(BROWSER_ROUTING_ID, "browser"), to("az", "tts-1"), to("llm", "kokoro"), to("az", "tts-1")) };
    expect(dataLevelCount(undefined, TEXT)).toBe(1);
    expect(dataLevelCount({}, TEXT)).toBe(1);
    expect(dataLevelCount(routing, TEXT)).toBe(3);
    expect(dataLevelCount(routing, SECTION_TASKS.tts)).toBe(4);
    expect(levelCount(routing, TEXT, 0)).toBe(3);
    expect(levelCount(routing, TEXT, 5)).toBe(5);
    expect(levelCount(undefined, TEXT, 0)).toBe(1);
    expect(levelCount(undefined, TEXT, 2)).toBe(2);
  });

  it("allows a new tab while the chain stays within the candidates limit (the primary counts as one)", () => {
    expect(canAddLevel(1, 4)).toBe(true);
    expect(canAddLevel(3, 4)).toBe(true);
    expect(canAddLevel(4, 4)).toBe(false);
    expect(canAddLevel(5, 4)).toBe(false);
    expect(canAddLevel(1, 1)).toBe(false);
  });

  it("counts how many rows have a target on a tab", () => {
    const routing: Routing = { default: full, director: route(to("llm", "muse-big"), to("az", "gpt-4o")), audit: route(to("gh", "llama")) };
    expect(countAtLevel(routing, TEXT, 0)).toBe(3);
    expect(countAtLevel(routing, TEXT, 1)).toBe(2);
    expect(countAtLevel(routing, TEXT, 2)).toBe(1);
    expect(countAtLevel(routing, ["audit"], 1)).toBe(0);
    expect(countAtLevel(routing, TEXT, 3)).toBe(0);
  });
});

describe("which endpoints and models a task may use", () => {
  const names = (task: RoutingTaskKind) => taskIntegrationChoices(INTEGRATIONS, task, "Browser").map((choice) => choice.id);

  it("offers the browser only for the two speech tasks, and the media endpoints only to OpenAI and Azure", () => {
    expect(names("tts")).toEqual([BROWSER_ROUTING_ID, "llm", "az"]);
    expect(names("stt")).toEqual([BROWSER_ROUTING_ID, "llm", "az"]);
    expect(names("image")).toEqual(["llm", "az"]);
    expect(taskIntegrationChoices(INTEGRATIONS, "tts", "Browser (built-in)")[0]).toEqual({ id: BROWSER_ROUTING_ID, label: "Browser (built-in)" });
  });

  it("offers every integration that can chat, never Microsoft 365, labelled with its name", () => {
    expect(names("director")).toEqual(["llm", "az", "gh"]);
    expect(taskIntegrationChoices(INTEGRATIONS, "default", "Browser").map((choice) => choice.label)).toEqual(["LlmProxy", "Studio Azure", "GitHub Models"]);
    expect(taskIntegrationChoices([{ ...LLM, name: "" }], "default", "Browser")[0].label).toBe("openai");
  });

  it("lists the chat models that carry the capability of the task or \"default\"", () => {
    expect(modelChoicesFor(INTEGRATIONS, "llm", "director")).toEqual(["muse-big", "legacy"]);
    expect(modelChoicesFor(INTEGRATIONS, "llm", "simple-tasks")).toEqual(["muse-big", "muse-small", "legacy"]);
    expect(modelChoicesFor(INTEGRATIONS, "gh", "review")).toEqual(["mini", "llama"]);
    expect(modelChoicesFor(INTEGRATIONS, "nobody", "director")).toEqual([]);
    expect(modelChoicesFor(INTEGRATIONS, undefined, "director")).toEqual([]);
  });

  it("offers the one model an integration names for each media task, and \"browser\" for the browser", () => {
    expect(modelChoicesFor(INTEGRATIONS, "llm", "tts")).toEqual(["kokoro"]);
    expect(modelChoicesFor(INTEGRATIONS, "az", "stt")).toEqual(["whisper-1"]);
    expect(modelChoicesFor(INTEGRATIONS, "az", "image")).toEqual(["gpt-image-1"]);
    expect(modelChoicesFor(INTEGRATIONS, BROWSER_ROUTING_ID, "tts")).toEqual(["browser"]);
    expect(modelChoicesFor([{ ...AZURE, modelTextToSpeech: "  " }], "az", "tts")).toEqual([]);
  });

  it("offers, for a bulk edit, only the models valid for every chosen task on the endpoint", () => {
    expect(commonModelChoices(INTEGRATIONS, "llm", ["director", "simple-tasks"])).toEqual(["muse-big", "legacy"]);
    expect(commonModelChoices(INTEGRATIONS, "llm", ["simple-tasks", "chat-resume"])).toEqual(["muse-big", "muse-small", "legacy"]);
    expect(commonModelChoices(INTEGRATIONS, "llm", [])).toEqual([]);
    expect(commonModelChoices(INTEGRATIONS, "gh", ["review"])).toEqual(["mini", "llama"]);
    expect(commonModelChoices(INTEGRATIONS, "gh", ["review", "director"])).toEqual(["mini", "llama"]);
    expect(commonModelChoices([{ ...GITHUB, chatModels: [model("only-review", ["review"])] }], "gh", ["review", "director"])).toEqual([]);
  });

  it("normalizes a target: trimmed model, thinking kept for chat only, the browser only for speech", () => {
    expect(normalizeRoutingTarget(to("llm", " muse-big ", "high"), "director")).toEqual(to("llm", "muse-big", "high"));
    expect(normalizeRoutingTarget(to("llm", "muse-big", "automatic"), "director")).toEqual(to("llm", "muse-big", "automatic"));
    expect(normalizeRoutingTarget({ integrationId: "llm", model: "muse-big", thinking: "extreme" as never }, "director")).toEqual(to("llm", "muse-big"));
    expect(normalizeRoutingTarget(to("az", "tts-1", "high"), "tts")).toEqual(to("az", "tts-1"));
    expect(normalizeRoutingTarget(to(BROWSER_ROUTING_ID, "whatever", "high"), "stt")).toEqual(to(BROWSER_ROUTING_ID, "browser"));
    expect(normalizeRoutingTarget(to(BROWSER_ROUTING_ID, "browser"), "image")).toBeUndefined();
    expect(normalizeRoutingTarget(to(BROWSER_ROUTING_ID, "browser"), "director")).toBeUndefined();
    expect(normalizeRoutingTarget(to("llm", "  "), "director")).toBeUndefined();
    expect(normalizeRoutingTarget(undefined, "director")).toBeUndefined();
  });

  it("keeps no thinking on the Default row: it only chooses the endpoint of the tasks without a route, and the level is the endpoint's", () => {
    expect(normalizeRoutingTarget(to("llm", "muse-big", "high"), "default")).toEqual(to("llm", "muse-big"));
    expect(normalizeRoutingTarget(to("llm", "muse-big", "automatic"), "default")).toEqual(to("llm", "muse-big"));
    expect(normalizeRoutingTarget(to("llm", "muse-big", "high"), "editor-actions")).toEqual(to("llm", "muse-big", "high"));
  });

  it("knows which tasks take a thinking level: the chat tasks but the Default row, and none of the media", () => {
    expect(takesThinking("default")).toBe(false);
    for (const task of CHAT_CAPABILITIES.filter((entry) => entry !== "default")) expect(takesThinking(task), task).toBe(true);
    for (const task of ["tts", "stt", "image"] as const) expect(takesThinking(task), task).toBe(false);
  });
});

describe("a row of the table", () => {
  const routing: Routing = {
    director: route(to("llm", "muse-big", "high"), to("az", "gpt-4o", "xhigh")),
    audit: route(undefined, to("az", "gpt-4o")),
    copilot: route(to("llm", "legacy")),
  };

  it("shows its own target on the tab, with the badge, and nothing inherited", () => {
    const row = buildRow(settingsOf(routing), "director", 0);
    expect(row).toMatchObject({ task: "director", level: 0, target: to("llm", "muse-big", "high"), custom: true, routed: true, orphan: false });
    expect(row.effective).toBeUndefined();
    expect(row.blocked).toBeUndefined();
    expect(buildRow(settingsOf(routing), "director", 1)).toMatchObject({ target: to("az", "gpt-4o", "xhigh"), custom: true });
  });

  it("shows the effective value, from the router's own resolution, on a row without a route", () => {
    const base = settingsOf(undefined);
    const row = buildRow(base, "director", 0);
    expect(row).toMatchObject({ target: undefined, custom: false, routed: false });
    expect(row.effective).toMatchObject({ integrationName: "LlmProxy", model: "muse-big" });
    // the chain the router would try: the second and third candidates are what the Fallback tabs show, dimmed
    expect(buildRow(base, "director", 1).effective).toMatchObject({ integrationName: "Studio Azure", model: "gpt-4o" });
    expect(buildRow(base, "director", 2).effective).toMatchObject({ integrationName: "GitHub Models", model: "mini" });
    expect(buildRow(base, "director", 3).effective).toBeUndefined();
    expect(buildRow(base, "simple-tasks", 0).effective).toMatchObject({ integrationName: "LlmProxy", model: "muse-small" });
  });

  it("inherits the route of the default for the editor actions, as the router does", () => {
    const base = settingsOf({ default: route(to("gh", "llama"), to("az", "gpt-4.1")) });
    expect(buildRow(base, "editor-actions", 0).effective).toMatchObject({ integrationName: "GitHub Models", model: "llama" });
    expect(buildRow(base, "editor-actions", 1).effective).toMatchObject({ integrationName: "Studio Azure", model: "gpt-4.1" });
    expect(buildRow(base, "editor-actions", 0).routed).toBe(false);
  });

  it("leaves out of the effective chain the candidates that would cross an account boundary, when the author asked for that", () => {
    const strict = settingsOf(undefined, { fallbackDisclosure: { sameBoundaryOnly: true, requireAcknowledgement: false } });
    expect(buildRow(strict, "director", 0).effective).toMatchObject({ integrationName: "LlmProxy" });
    expect(buildRow(strict, "director", 1).effective).toBeUndefined();
  });

  it("shows the browser voice as a target of its own, and the voice of the default integration as the effective one without a route", () => {
    const row = buildRow(settingsOf({ tts: route(to(BROWSER_ROUTING_ID, "browser")) }), "tts", 0);
    expect(row.target).toEqual(to(BROWSER_ROUTING_ID, "browser"));
    expect(row.custom).toBe(true);
    expect(buildRow(settingsOf(undefined), "tts", 0).effective).toMatchObject({ integrationName: "LlmProxy", model: "kokoro" });
  });

  it("shows no effective value on a routed row whose tab is empty: the cell says there is nothing there", () => {
    const row = buildRow(settingsOf(routing), "copilot", 1);
    expect(row).toMatchObject({ target: undefined, custom: false, routed: true });
    expect(row.effective).toBeUndefined();
  });

  it("explains why an empty fallback cell cannot be filled yet", () => {
    expect(buildRow(settingsOf(routing), "copilot", 2)).toMatchObject({ blocked: "gap" });
    expect(buildRow(settingsOf(routing), "default", 1)).toMatchObject({ blocked: "no-primary" });
    expect(buildRow(settingsOf(routing), "copilot", 1).blocked).toBeUndefined();
    expect(buildRow(settingsOf(routing), "default", 0).blocked).toBeUndefined();
  });

  it("flags a task that has fallbacks and no primary, on every tab, so the empty primary is where it is told", () => {
    const row = buildRow(settingsOf(routing), "audit", 1);
    expect(row).toMatchObject({ target: to("az", "gpt-4o"), orphan: true, custom: true });
    expect(buildRow(settingsOf(routing), "audit", 0)).toMatchObject({ target: undefined, orphan: true, routed: true });
    expect(buildRow(settingsOf(routing), "director", 1).orphan).toBe(false);
    expect(buildRow(settingsOf(routing), "director", 0).orphan).toBe(false);
    expect(buildRow(settingsOf(routing), "deep-research", 0).orphan).toBe(false);
  });

  it("warns about a model without tool calls on the tasks the autopilot runs, unless the author turned «Tools only» off", () => {
    const agents: Routing = { ...routing, review: route(to("llm", "legacy")), default: route(to("llm", "legacy")) };
    expect(buildRow(settingsOf(agents), "review", 0).toolWarning).toBe(true);
    expect(buildRow(settingsOf(agents, { aiToolsOnly: true }), "review", 0).toolWarning).toBe(true);
    expect(buildRow(settingsOf(agents, { aiToolsOnly: false }), "review", 0).toolWarning).toBe(false);
    expect(buildRow(settingsOf(agents), "director", 0).toolWarning, "a model that can call tools").toBe(false);
  });

  it("does not warn about a model without tool calls on the Copilot's tasks, nor on the Default row: «Tools only» is the autopilot's, and the Default row only chooses an endpoint", () => {
    const agents: Routing = { ...routing, copilot: route(to("llm", "legacy")), "editor-actions": route(to("llm", "legacy")), default: route(to("llm", "legacy")) };
    for (const task of ["copilot", "editor-actions", "default"] as const) expect(buildRow(settingsOf(agents), task, 0).toolWarning, task).toBe(false);
  });

  it("flags a target whose integration or model no longer exists, instead of showing a blank", () => {
    const stale: Routing = { review: route(to("gone", "x")), director: route(to("llm", "removed")) };
    expect(buildRow(settingsOf(stale), "review", 0)).toMatchObject({ missing: { integration: true, model: true } });
    expect(buildRow(settingsOf(stale), "director", 0)).toMatchObject({ missing: { integration: false, model: true } });
    expect(buildRow(settingsOf(routing), "director", 0)).toMatchObject({ missing: { integration: false, model: false } });
  });

  it("carries the thinking the integration would give, so a blank thinking can say what it inherits", () => {
    const withDefault = settingsOf({ director: route(to("llm", "muse-big")) }, { aiIntegrations: [{ ...LLM, thinking: "medium" }, AZURE, GITHUB, M365] });
    expect(buildRow(withDefault, "director", 0).inheritedThinking).toBe("medium");
    expect(buildRow(withDefault, "audit", 0).inheritedThinking).toBe("medium");
    expect(buildRow(settingsOf({ director: route(to("az", "gpt-4o")) }), "director", 0).inheritedThinking).toBeUndefined();
  });
});

describe("filters, and the count under them", () => {
  const routing: Routing = {
    default: route(to("llm", "muse-big"), to("az", "gpt-4o")),
    director: route(to("llm", "muse-big", "high")),
    review: route(to("gh", "llama")),
  };
  const search = (task: RoutingTaskKind) => `${task.replace(/-/g, " ")} ${task === "director" ? "Direttore giudica il piano" : ""}`;
  const none: RowFilters = { group: "all", query: "", onlyCustom: false };
  const shown = (level: number, filters = none, patch: Partial<AppSettings> = {}) => visibleTasks({ settings: settingsOf(routing, patch), section: "text", level, filters, searchText: search });

  it("shows the whole text section, and the single task of a media section", () => {
    expect(shown(0)).toEqual(TEXT_TASK_ORDER);
    expect(visibleTasks({ settings: settingsOf(routing), section: "tts", level: 0, filters: none, searchText: search })).toEqual(["tts"]);
    expect(visibleTasks({ settings: settingsOf(routing), section: "image", level: 3, filters: none, searchText: search })).toEqual(["image"]);
  });

  it("keeps only the tasks of a group", () => {
    expect(shown(0, { ...none, group: "research" })).toEqual(["deep-research", "create-from-research"]);
    expect(shown(0, { ...none, group: "review" })).toEqual(TEXT_GROUPS.review);
  });

  it("matches the text typed against the name and the help line, ignoring case and accents", () => {
    expect(shown(0, { ...none, query: "DIRETTORE" })).toEqual(["director"]);
    expect(shown(0, { ...none, query: "  giudica " })).toEqual(["director"]);
    expect(shown(0, { ...none, query: "reader" })).toEqual(["reader-evaluation", "reader-evaluation-summary", "rewrite-from-reader-feedback"]);
    expect(shown(0, { ...none, query: "zzz" })).toEqual([]);
  });

  it("keeps only the customized rows of the tab on show: a row is customized where it has its own target", () => {
    expect(shown(0, { ...none, onlyCustom: true })).toEqual(["default", "director", "review"]);
    expect(shown(1, { ...none, onlyCustom: true })).toEqual(["default"]);
    expect(shown(2, { ...none, onlyCustom: true })).toEqual([]);
  });

  it("combines the three filters", () => {
    expect(shown(0, { group: "review", query: "", onlyCustom: true })).toEqual(["review"]);
    expect(shown(0, { group: "autopilot", query: "director", onlyCustom: true })).toEqual(["director"]);
    expect(shown(0, { group: "research", query: "director", onlyCustom: false })).toEqual([]);
  });
});

describe("changing the target of rows, all together", () => {
  const rows: Routing = {
    director: route(to("llm", "muse-big", "high")),
    autopilot: route(to("az", "gpt-4.1", "medium")),
    review: route(to("gh", "mini")),
    copilot: route(to("llm", "legacy", "automatic")),
  };
  const apply = (change: Parameters<typeof applyBulkChange>[0]["change"], tasks: readonly RoutingTaskKind[], level = 0, routing: Routing | undefined = rows, maxCandidates = 4) =>
    applyBulkChange({ routing, integrations: INTEGRATIONS, tasks, level, change, maxCandidates });
  const targetsOf = (routing: Routing, tasks: readonly RoutingTaskKind[], level = 0) => tasks.map((task) => targetAt(routing[task], level));

  it("(a) changes endpoint and model for every selected row and leaves their thinking as it was", () => {
    const outcome = apply({ endpointId: "az", model: "gpt-4o" }, ["director", "autopilot", "review", "copilot"]);
    expect(targetsOf(outcome.routing, ["director", "autopilot", "review", "copilot"])).toEqual([
      to("az", "gpt-4o", "high"),
      to("az", "gpt-4o", "medium"),
      to("az", "gpt-4o"),
      to("az", "gpt-4o", "automatic"),
    ]);
    expect(outcome.changed).toEqual(["director", "autopilot", "review", "copilot"]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.created).toEqual([]);
    expect(outcome.adjusted).toEqual([]);
  });

  it("(b) changes only the model, with the endpoint left alone, and leaves the thinking as it was", () => {
    const outcome = apply({ model: "legacy" }, ["director", "copilot"]);
    expect(targetsOf(outcome.routing, ["director", "copilot"])).toEqual([to("llm", "legacy", "high"), to("llm", "legacy", "automatic")]);
    expect(outcome.changed).toEqual(["director"]);
    expect(outcome.unchanged).toEqual(["copilot"]);
  });

  it("(c) changes everything, thinking included, on every row of the section, giving a target to the rows that had none", () => {
    const outcome = apply({ endpointId: "gh", model: "mini", thinking: "xhigh" }, TEXT);
    // The Default row takes the endpoint and the model and not the level: it has none of its own.
    expect(targetsOf(outcome.routing, TEXT)).toEqual(TEXT.map((task) => (task === "default" ? to("gh", "mini") : to("gh", "mini", "xhigh"))));
    // every row changed: even the one that already pointed at gh/mini gains the thinking
    expect(outcome.changed).toEqual([...TEXT]);
    expect(outcome.created).toEqual(TEXT.filter((task) => !rows[task]));
    expect(outcome.created).toHaveLength(10);
    expect(outcome.skipped).toEqual([]);
  });

  it("changes only the thinking, keeping endpoint and model; inherit removes it, automatic is a value of its own", () => {
    const high = apply({ thinking: "low" }, ["director", "autopilot"]);
    expect(targetsOf(high.routing, ["director", "autopilot"])).toEqual([to("llm", "muse-big", "low"), to("az", "gpt-4.1", "low")]);
    const inherit = apply({ thinking: "inherit" }, ["director", "autopilot", "review"]);
    expect(targetsOf(inherit.routing, ["director", "autopilot", "review"])).toEqual([to("llm", "muse-big"), to("az", "gpt-4.1"), to("gh", "mini")]);
    expect(inherit.unchanged).toEqual(["review"]);
    expect("thinking" in inherit.routing.director!.primary!).toBe(false);
    const automatic = apply({ thinking: "automatic" }, ["review"]);
    expect(automatic.routing.review!.primary).toEqual(to("gh", "mini", "automatic"));
  });

  it("keeps the model when the new endpoint has it for the task, and tells which rows had to take the first valid one", () => {
    const routing: Routing = { director: route(to("llm", "muse-big")), audit: route(to("az", "gpt-4o")), review: route(to("gh", "llama")) };
    const outcome = apply({ endpointId: "az" }, ["director", "audit", "review"], 0, routing);
    expect(targetsOf(outcome.routing, ["director", "audit", "review"])).toEqual([to("az", "gpt-4o"), to("az", "gpt-4o"), to("az", "gpt-4o")]);
    expect(outcome.adjusted).toEqual(["director", "review"]);
    expect(outcome.unchanged).toEqual(["audit"]);
    const keeping = apply({ endpointId: "gh" }, ["review", "audit"], 0, { review: route(to("llm", "muse-big")), audit: route(to("gh", "llama")) });
    expect(keeping.routing.audit!.primary).toEqual(to("gh", "llama"));
    expect(keeping.routing.review!.primary).toEqual(to("gh", "mini"));
    expect(keeping.adjusted).toEqual(["review"]);
  });

  it("gives a row without a target on the tab the endpoint, and the first valid model when no model was chosen", () => {
    const outcome = apply({ endpointId: "llm" }, ["simple-tasks", "audit"], 0, {});
    expect(outcome.routing["simple-tasks"]!.primary).toEqual(to("llm", "muse-big"));
    expect(outcome.routing.audit!.primary).toEqual(to("llm", "muse-big"));
    expect(outcome.created).toEqual(["simple-tasks", "audit"]);
    expect(outcome.adjusted).toEqual(["simple-tasks", "audit"]);
    const chosen = apply({ endpointId: "llm", model: "muse-small" }, ["simple-tasks"], 0, {});
    expect(chosen.routing["simple-tasks"]!.primary).toEqual(to("llm", "muse-small"));
    expect(chosen.adjusted).toEqual([]);
  });

  it("does not give a target to a row that has none when no endpoint was chosen: it has nowhere to point", () => {
    const outcome = apply({ model: "legacy", thinking: "high" }, ["director", "audit"], 0, { director: rows.director });
    expect(outcome.changed).toEqual(["director"]);
    expect(outcome.skipped).toEqual([{ task: "audit", reason: "no-target" }]);
    expect(outcome.routing.audit).toBeUndefined();
  });

  it("refuses a model that is not valid for the task, and an endpoint with no valid model, leaving the row alone", () => {
    const refused = apply({ endpointId: "llm", model: "muse-small" }, ["director", "simple-tasks"], 0, { director: rows.director, "simple-tasks": route(to("gh", "mini")) });
    expect(refused.skipped).toEqual([{ task: "director", reason: "invalid-model" }]);
    expect(refused.routing.director).toEqual(rows.director);
    expect(refused.routing["simple-tasks"]!.primary).toEqual(to("llm", "muse-small"));
    const empty = apply({ endpointId: "m365" }, ["director"], 0, { director: rows.director });
    expect(empty.skipped).toEqual([{ task: "director", reason: "no-model" }]);
    const noModels = applyBulkChange({ routing: rows, integrations: [{ ...GITHUB, chatModels: [] }], tasks: ["director"], level: 0, change: { endpointId: "gh" }, maxCandidates: 4 });
    expect(noModels.skipped).toEqual([{ task: "director", reason: "no-model" }]);
  });

  it("works on a fallback tab: the fallback of a row is replaced, filled where it is the next one, and never invented without a primary", () => {
    const routing: Routing = {
      director: route(to("llm", "muse-big"), to("az", "gpt-4o", "high")),
      audit: route(to("gh", "llama")),
      "chat-resume": route(undefined, to("az", "gpt-4o")),
    };
    const outcome = apply({ endpointId: "gh", model: "mini" }, ["director", "audit", "review", "chat-resume"], 1, routing);
    // replaced, and the thinking of that fallback stays
    expect(outcome.routing.director).toEqual(route(to("llm", "muse-big"), to("gh", "mini", "high")));
    // the next free fallback after the primary
    expect(outcome.routing.audit).toEqual(route(to("gh", "llama"), to("gh", "mini")));
    expect(outcome.created).toEqual(["audit"]);
    // no route at all: a fallback would have nothing in front of it
    expect(outcome.skipped).toEqual([{ task: "review", reason: "no-primary" }]);
    expect(outcome.routing.review).toBeUndefined();
    // a fallback that already exists can still be edited, even though it has no primary
    expect(outcome.routing["chat-resume"]).toEqual(route(undefined, to("gh", "mini")));
    expect(outcome.changed).toEqual(["director", "audit", "chat-resume"]);
  });

  it("does not fill a tab two steps past the last filled one, and does not pass the limit of candidates", () => {
    const routing: Routing = { director: route(to("llm", "muse-big")), audit: route(to("gh", "llama"), to("az", "gpt-4o"), to("llm", "legacy")) };
    const gap = apply({ endpointId: "az", model: "gpt-4o" }, ["director"], 2, routing);
    expect(gap.skipped).toEqual([{ task: "director", reason: "gap" }]);
    const limit = apply({ endpointId: "az", model: "gpt-4o" }, ["audit"], 3, routing, 3);
    expect(limit.skipped).toEqual([{ task: "audit", reason: "limit" }]);
    const allowed = apply({ endpointId: "az", model: "gpt-4o" }, ["audit"], 3, routing, 4);
    expect(allowed.routing.audit!.fallbacks).toHaveLength(3);
  });

  it("changes a media row, with the browser as an endpoint of its own and no thinking", () => {
    const routing: Routing = { tts: route(to("az", "tts-1")) };
    const toBrowser = applyBulkChange({ routing, integrations: INTEGRATIONS, tasks: ["tts"], level: 0, change: { endpointId: BROWSER_ROUTING_ID }, maxCandidates: 4 });
    expect(toBrowser.routing.tts!.primary).toEqual(to(BROWSER_ROUTING_ID, "browser"));
    const toLlm = applyBulkChange({ routing: toBrowser.routing, integrations: INTEGRATIONS, tasks: ["tts"], level: 0, change: { endpointId: "llm" }, maxCandidates: 4 });
    expect(toLlm.routing.tts!.primary).toEqual(to("llm", "kokoro"));
    const noImageBrowser = applyBulkChange({ routing: {}, integrations: INTEGRATIONS, tasks: ["image"], level: 0, change: { endpointId: BROWSER_ROUTING_ID }, maxCandidates: 4 });
    expect(noImageBrowser.skipped).toEqual([{ task: "image", reason: "no-model" }]);
    const thinking = applyBulkChange({ routing, integrations: INTEGRATIONS, tasks: ["tts"], level: 0, change: { thinking: "high" }, maxCandidates: 4 });
    expect(thinking.routing.tts!.primary).toEqual(to("az", "tts-1"));
  });

  it("does nothing, and says so, when nothing was asked for or everything is already so", () => {
    const nothing = apply({}, ["director"]);
    expect(nothing.changed).toEqual([]);
    expect(nothing.routing).toBe(rows);
    const same = apply({ endpointId: "llm", model: "muse-big", thinking: "high" }, ["director"]);
    expect(same.changed).toEqual([]);
    expect(same.unchanged).toEqual(["director"]);
    expect(same.routing).toBe(rows);
  });

  it("never changes what it was given, and shares the routes it did not touch", () => {
    const before = JSON.stringify(rows);
    const outcome = apply({ model: "legacy" }, ["director"]);
    expect(JSON.stringify(rows)).toBe(before);
    expect(outcome.routing.autopilot).toBe(rows.autopilot);
    expect(outcome.routing.director).not.toBe(rows.director);
  });

  it("clears the target of a row on a tab, moving the next ones up, and reports the rows that had it", () => {
    const routing: Routing = { director: route(to("llm", "muse-big"), to("az", "gpt-4o"), to("gh", "mini")), audit: route(to("gh", "llama")) };
    const outcome = clearTargetAt(routing, ["director", "audit", "review"], 1);
    expect(outcome.routing.director).toEqual(route(to("llm", "muse-big"), to("gh", "mini")));
    expect(outcome.routing.audit).toEqual(route(to("gh", "llama")));
    expect(outcome.cleared).toEqual(["director"]);
    expect(outcome.promoted).toEqual([]);
    const primary = clearTargetAt(routing, ["director", "audit"], 0);
    expect(primary.routing.director).toEqual(route(to("az", "gpt-4o"), to("gh", "mini")));
    expect(primary.routing.audit).toBeUndefined();
    expect(primary.cleared).toEqual(["director", "audit"]);
    expect(primary.promoted).toEqual(["director"]);
  });
});

describe("swapping two tabs", () => {
  const routing: Routing = {
    director: route(to("llm", "muse-big", "high"), to("az", "gpt-4o", "low"), to("gh", "mini")),
    autopilot: route(to("az", "gpt-4.1"), to("llm", "muse-big", "medium")),
    audit: route(to("gh", "llama")),
    review: route(undefined, to("az", "gpt-4o")),
  };

  it("exchanges the whole target of the two tabs, thinking included, for every row that has both", () => {
    const outcome = swapLevels(routing, ["director", "autopilot"], 0, 1);
    expect(outcome.routing.director).toEqual(route(to("az", "gpt-4o", "low"), to("llm", "muse-big", "high"), to("gh", "mini")));
    expect(outcome.routing.autopilot).toEqual(route(to("llm", "muse-big", "medium"), to("az", "gpt-4.1")));
    expect(outcome.swapped).toEqual(["director", "autopilot"]);
    expect(outcome.skipped).toEqual([]);
  });

  it("swapping twice puts everything back", () => {
    const once = swapLevels(routing, ["director", "autopilot"], 0, 1);
    const twice = swapLevels(once.routing, ["director", "autopilot"], 0, 1);
    expect(twice.routing.director).toEqual(routing.director);
    expect(twice.routing.autopilot).toEqual(routing.autopilot);
  });

  it("swaps the same way in either direction, and between two fallbacks", () => {
    const a = swapLevels(routing, ["director"], 1, 0);
    const b = swapLevels(routing, ["director"], 0, 1);
    expect(a.routing.director).toEqual(b.routing.director);
    const fallbacks = swapLevels(routing, ["director"], 1, 2);
    expect(fallbacks.routing.director).toEqual(route(to("llm", "muse-big", "high"), to("gh", "mini"), to("az", "gpt-4o", "low")));
  });

  it("skips a row that would be left with a hole (a fallback with nothing in front of it), and says why", () => {
    const outcome = swapLevels(routing, ["director", "audit", "autopilot"], 0, 1);
    expect(outcome.swapped).toEqual(["director", "autopilot"]);
    expect(outcome.skipped).toEqual([{ task: "audit", reason: "gap" }]);
    expect(outcome.routing.audit).toBe(routing.audit);
    const far = swapLevels(routing, ["autopilot"], 1, 2);
    expect(far.skipped).toEqual([{ task: "autopilot", reason: "gap" }]);
  });

  it("repairs a fallback that has no primary by moving it up, and leaves rows with nothing on the two tabs alone", () => {
    const outcome = swapLevels(routing, ["review", "deep-research"], 0, 1);
    expect(outcome.routing.review).toEqual(route(to("az", "gpt-4o")));
    expect(outcome.swapped).toEqual(["review"]);
    expect(outcome.unchanged).toEqual(["deep-research"]);
    expect(outcome.routing["deep-research"]).toBeUndefined();
  });

  it("does nothing when asked to swap a tab with itself", () => {
    const outcome = swapLevels(routing, TEXT, 1, 1);
    expect(outcome.swapped).toEqual([]);
    expect(outcome.routing).toBe(routing);
  });

  it("swaps every row of the section when all of them are given, and counts them", () => {
    const outcome = swapLevels(routing, TEXT, 0, 1);
    // in the order of the table; "review" had a fallback and no primary, and the swap puts that fallback where it belongs
    expect(outcome.swapped).toEqual(["autopilot", "director", "review"]);
    expect(outcome.skipped).toEqual([{ task: "audit", reason: "gap" }]);
  });

  it("never changes what it was given", () => {
    const before = JSON.stringify(routing);
    swapLevels(routing, TEXT, 0, 2);
    expect(JSON.stringify(routing)).toBe(before);
  });
});

describe("deleting a tab", () => {
  const routing: Routing = {
    director: route(to("llm", "muse-big"), to("az", "gpt-4o"), to("gh", "mini")),
    autopilot: route(to("az", "gpt-4.1"), to("llm", "muse-big")),
    audit: route(to("gh", "llama")),
  };

  it("takes the level away from every row and moves the later ones up", () => {
    const outcome = removeLevel(routing, TEXT, 1);
    expect(outcome.routing.director).toEqual(route(to("llm", "muse-big"), to("gh", "mini")));
    expect(outcome.routing.autopilot).toEqual(route(to("az", "gpt-4.1")));
    expect(outcome.routing.audit).toBe(routing.audit);
    // in the order of the table
    expect(outcome.lost).toEqual(["autopilot", "director"]);
    expect(outcome.shifted).toEqual(["director"]);
  });

  it("takes it away only from the rows that were asked", () => {
    const outcome = removeLevel(routing, ["director"], 2);
    expect(outcome.routing.director).toEqual(route(to("llm", "muse-big"), to("az", "gpt-4o")));
    expect(outcome.routing.autopilot).toBe(routing.autopilot);
    expect(outcome.lost).toEqual(["director"]);
    expect(outcome.shifted).toEqual([]);
  });

  it("does not delete the primary tab: that is what a swap and a clear are for", () => {
    expect(() => removeLevel(routing, TEXT, 0)).toThrow(RangeError);
  });

  it("reports nothing lost for a tab no row has, and leaves the routing as it was", () => {
    const outcome = removeLevel(routing, TEXT, 3);
    expect(outcome.lost).toEqual([]);
    expect(outcome.routing).toBe(routing);
  });
});

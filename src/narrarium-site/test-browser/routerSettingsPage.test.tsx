import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { CHAT_CAPABILITIES, DEFAULT_SETTINGS, type AIIntegration, type AppSettings, type RoutingTarget, type RoutingTaskKind, type TaskRoute } from "@/types/settings";
import { TEXT_GROUPS, TEXT_TASK_ORDER } from "@/router/routerTableModel";
import { chooseMenuItem, chooseOption, openMenu, openSelect, optionNames, polyfillRadix } from "./helpers/radix";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const LLM: AIIntegration = {
  id: "llm", name: "LlmProxy", provider: "openai", endpoint: "http://llm.test/v1", apiKey: "k",
  chatModels: [
    { id: "m1", name: "muse-big", capabilities: ["default", "autopilot", "director", "copilot", "review"] },
    { id: "m2", name: "muse-small", capabilities: ["simple-tasks", "chat-resume"] },
    { id: "m3", name: "legacy", capabilities: ["default"], supportsToolCalls: false },
  ],
  modelSpeechToText: "whisper-large", modelTextToSpeech: "kokoro", modelImageGeneration: "sd-turbo",
};
const AZURE: AIIntegration = {
  id: "az", name: "Studio Azure", provider: "azure_openai", endpoint: "https://a.openai.azure.com", apiKey: "k", apiVersion: "2024-10-21",
  chatModels: [{ id: "a1", name: "gpt-4o", capabilities: ["default"] }, { id: "a2", name: "gpt-4.1", capabilities: ["default"] }],
  modelSpeechToText: "whisper-1", modelTextToSpeech: "tts-1", modelImageGeneration: "gpt-image-1",
};
const GITHUB: AIIntegration = {
  id: "gh", name: "GitHub Models", provider: "github_models", apiKey: "k",
  chatModels: [{ id: "g1", name: "mini", capabilities: ["default", "simple-tasks"] }, { id: "g2", name: "llama", capabilities: ["default", "review"] }],
};

const to = (integrationId: string, model: string, thinking?: RoutingTarget["thinking"]): RoutingTarget => ({ integrationId, model, ...(thinking ? { thinking } : {}) });
const route = (primary: RoutingTarget | undefined, ...fallbacks: RoutingTarget[]): TaskRoute => ({ primary, fallbacks });
const ROUTING = (): NonNullable<AppSettings["taskRouting"]> => ({
  default: route(to("llm", "muse-big"), to("az", "gpt-4o")),
  autopilot: route(to("az", "gpt-4.1", "medium"), to("llm", "muse-big", "high"), to("gh", "mini")),
  director: route(to("llm", "muse-big", "high"), to("az", "gpt-4o", "xhigh")),
  review: route(to("gh", "llama", "low"), to("az", "gpt-4.1")),
  copilot: route(to("az", "gpt-4o", "automatic")),
  "reader-evaluation": route(to("llm", "legacy")),
  tts: route(to("__browser__", "browser"), to("az", "tts-1")),
  stt: route(to("az", "whisper-1")),
  image: route(to("az", "gpt-image-1"), to("llm", "sd-turbo")),
});

async function show(language: Language = "en", patch: Partial<AppSettings> = {}) {
  await i18n.changeLanguage(language);
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language }, aiIntegrations: [LLM, AZURE, GITHUB], defaultWritingIntegrationId: "llm", defaultReviewIntegrationId: "llm", taskRouting: ROUTING(), ...patch },
  });
  return render(<MemoryRouter initialEntries={["/app/settings/ai-router"]}><SettingsPage /></MemoryRouter>);
}

const routing = () => useSettingsStore.getState().settings.taskRouting ?? {};
const tabName = (level: number) => (level === 0 ? t("routing.primary") : t("routing.fallbackN", { n: level }));
const label = (task: string) => (task === "default" ? t("routing.table.defaultRow") : t(`routing.task.${task}`));
const sectionTitle = (id: "text" | "tts" | "stt" | "image") => (id === "text" ? t("routing.sections.text.title") : t(`routing.task.${id}`));
const section = (id: "text" | "tts" | "stt" | "image" = "text") => within(screen.getByRole("region", { name: sectionTitle(id) }));
const endpoint = (task: string, level = 0) => screen.getByRole("combobox", { name: t("routing.cell.endpoint", { task: label(task), tab: tabName(level) }) });
const modelBox = (task: string, level = 0) => screen.getByRole("combobox", { name: t("routing.cell.model", { task: label(task), tab: tabName(level) }) });
const thinkingBox = (task: string, level = 0) => screen.getByRole("combobox", { name: t("routing.cell.thinking", { task: label(task), tab: tabName(level) }) });
const rowCheckbox = (task: string) => screen.getByRole("checkbox", { name: t("routing.cell.select", { task: label(task) }) });
const rowOf = (task: string, level = 0) => endpoint(task, level).closest("tr") as HTMLElement;
const tab = (name: string, scope = section()) => scope.getByRole("tab", { name });
const status = (id: "text" | "tts" | "stt" | "image" = "text") => section(id).getByRole("status");
const select = (...tasks: string[]) => tasks.forEach((task) => fireEvent.click(rowCheckbox(task)));
const goToTab = async (name: string) => {
  fireEvent.mouseDown(tab(name));
  fireEvent.click(tab(name));
  await waitFor(() => expect(tab(name)).toHaveAttribute("aria-selected", "true"));
};

vi.setConfig({ testTimeout: 60_000 });
beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("R1 — the page: the options, then one table per kind of task", () => {
  it.each(LANGUAGES)("keeps the privacy switches and the limits in a collapsible box, followed by four sections with their own tabs (%s)", async (language) => {
    await show(language);
    const options = screen.getByText(t("routing.options.title")).closest("details") as HTMLDetailsElement;
    expect(options).not.toBeNull();
    expect(within(options).getAllByRole("switch")).toHaveLength(2);
    expect(within(options).getAllByRole("spinbutton")).toHaveLength(4);
    expect(within(options).getByText(t("routing.sameBoundaryOnly"))).toBeInTheDocument();

    const regions = (["text", "tts", "stt", "image"] as const).map((id) => screen.getByRole("region", { name: sectionTitle(id) }));
    expect(regions.map((region) => region.querySelector("h2")?.textContent)).toEqual(["text", "tts", "stt", "image"].map((id) => sectionTitle(id as "text")));
    for (const [index, region] of regions.entries()) {
      expect(options.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING, `section ${index} comes after the options`).toBeTruthy();
      if (index > 0) expect(regions[index - 1].compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(region).getByRole("table")).toBeInTheDocument();
      expect(within(region).getByRole("tablist")).toBeInTheDocument();
    }
    expect(screen.getAllByRole("tablist")).toHaveLength(4);
    expect(t("routing.sections.text.title")).not.toBe(t("routing.task.tts"));
  });

  it("does not mix the kinds: a speech endpoint is not offered for text, and the browser only for speech", async () => {
    await show();
    expect(optionNames(endpoint("director"))).toEqual([t("routing.cell.clearPrimary"), "LlmProxy", "Studio Azure", "GitHub Models"]);
    expect(optionNames(endpoint("tts"))).toEqual([t("routing.cell.clearPrimary"), t("routing.browser"), "LlmProxy", "Studio Azure"]);
    expect(optionNames(endpoint("image"))).toEqual([t("routing.cell.clearPrimary"), "LlmProxy", "Studio Azure"]);
    expect(optionNames(modelBox("director"))).toEqual(["muse-big", `legacy · ${t("routing.warn.noToolCalls")}`]);
    expect(optionNames(modelBox("stt"))).toEqual(["whisper-1"]);
  });

  it("has a real table in each section: a caption, column headers, row headers, and a labelled, focusable group around it that scrolls", async () => {
    await show();
    for (const id of ["text", "tts", "stt", "image"] as const) {
      const table = section(id).getByRole("table");
      expect(table.querySelector("caption")).not.toBeNull();
      expect(within(table).getAllByRole("columnheader").every((header) => header.getAttribute("scope") === "col")).toBe(true);
      expect(within(table).getAllByRole("rowheader").every((header) => header.getAttribute("scope") === "row")).toBe(true);
      const scroller = table.closest("[role=group]") as HTMLElement;
      expect(scroller).toHaveAccessibleName(t("routing.table.regionLabel", { section: sectionTitle(id), tab: tabName(0) }));
    }
    const text = section().getByRole("table");
    for (const key of ["task", "endpoint", "model", "thinking"]) expect(within(text).getByRole("columnheader", { name: t(`routing.table.${key}`) })).toBeInTheDocument();
    const speech = section("tts").getByRole("table");
    expect(within(speech).queryByRole("columnheader", { name: t("routing.table.thinking") })).not.toBeInTheDocument();
    expect(within(speech).getAllByRole("row")).toHaveLength(2);
  });
});

describe("R2 — the table of the text tasks", () => {
  it.each(LANGUAGES)("lists the default first and then the 13 other tasks, each with its name and why it is used (%s)", async (language) => {
    await show(language);
    const rows = within(section().getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(14);
    expect(within(rows[0]).getByRole("rowheader")).toHaveTextContent(t("routing.table.defaultRow"));
    expect(within(rows[0]).getByRole("rowheader")).toHaveTextContent(t("routing.taskHelp.default"));
    const order = rows.map((row) => within(row).getByRole("checkbox").getAttribute("aria-label"));
    expect(order).toEqual(TEXT_TASK_ORDER.map((task) => t("routing.cell.select", { task: label(task) })));
    for (const task of CHAT_CAPABILITIES) {
      expect(i18n.exists(`routing.taskHelp.${task}`, { lng: language }), `help of ${task} (${language})`).toBe(true);
      expect(within(rowOf(task)).getByRole("rowheader")).toHaveTextContent(t(`routing.taskHelp.${task}`));
    }
    expect(t("routing.taskHelp.director")).not.toBe(t("routing.taskHelp.autopilot"));
  });

  it.each(LANGUAGES)("shows the own route of a row as it is, and the value the router would use, dimmed, on a row without one (%s)", async (language) => {
    await show(language);
    expect(endpoint("director")).toHaveTextContent("LlmProxy");
    expect(modelBox("director")).toHaveTextContent("muse-big");
    expect(endpoint("audit")).toHaveTextContent(t("routing.cell.default", { value: "LlmProxy" }));
    expect(modelBox("audit")).toHaveTextContent(t("routing.cell.default", { value: "muse-big" }));
    expect(endpoint("simple-tasks")).toHaveTextContent(t("routing.cell.default", { value: "LlmProxy" }));
    expect(modelBox("simple-tasks")).toHaveTextContent(t("routing.cell.default", { value: "muse-small" }));
    expect(endpoint("editor-actions")).toHaveTextContent(t("routing.cell.default", { value: "LlmProxy" }));
    expect(endpoint("audit").querySelector(".text-muted-foreground")).not.toBeNull();
    expect(endpoint("director").querySelector(".text-muted-foreground")).toBeNull();
  });

  it.each(LANGUAGES)("marks the rows that have their own route on the tab, with words (%s)", async (language) => {
    await show(language);
    const badge = t("routing.badge.custom");
    const marked = TEXT_TASK_ORDER.filter((task) => within(rowOf(task)).queryByText(badge));
    expect(marked.sort()).toEqual(["autopilot", "copilot", "default", "director", "reader-evaluation", "review"]);
  });

  it.each(LANGUAGES)("offers the six levels of thinking, shows the one of the route, and keeps it with the route (%s)", async (language) => {
    await show(language);
    expect(thinkingBox("director")).toHaveTextContent(t("routing.thinking.high"));
    expect(thinkingBox("autopilot")).toHaveTextContent(t("routing.thinking.medium"));
    expect(thinkingBox("copilot")).toHaveTextContent(t("routing.thinking.automatic"));
    expect(optionNames(thinkingBox("director"))).toEqual(["inherit", "automatic", "low", "medium", "high", "xhigh"].map((level) => t(`routing.thinking.${level}`)));
    chooseOption(thinkingBox("director"), t("routing.thinking.low"));
    expect(routing().director?.primary).toEqual(to("llm", "muse-big", "low"));
    chooseOption(thinkingBox("director"), t("routing.thinking.inherit"));
    expect("thinking" in (routing().director?.primary ?? {})).toBe(false);
    expect(t("routing.thinking.low")).toMatch(/^Low/);
    expect(t("routing.thinking.xhigh")).toMatch(/^Extra high/);
  });

  it.each(LANGUAGES)("gives the Default row no select for the thinking: that row only chooses the endpoint of the tasks without a route, so the level is the endpoint's, and the cell says so and leads to where it is set (%s)", async (language) => {
    await show(language, { aiIntegrations: [{ ...LLM, thinking: "high" }, AZURE, GITHUB] });
    expect(screen.queryByRole("combobox", { name: t("routing.cell.thinking", { task: label("default"), tab: tabName(0) }) })).not.toBeInTheDocument();
    const cell = within(rowOf("default"));
    const link = cell.getByRole("link", { name: t("routing.thinking.fromEndpointWith", { level: t("routing.thinking.high") }) });
    expect(link).toHaveAttribute("href", "/app/settings/ai-integrations");
    expect(t("routing.thinking.fromEndpointWith", { level: "High" })).toBe(language === "en" ? "High, set on the endpoint" : "High, impostato sull'endpoint");
    // The other rows keep their select.
    expect(thinkingBox("director")).toBeInTheDocument();
  });

  it("says only «set on the endpoint» when the endpoint has no level", async () => {
    await show("en");
    expect(within(rowOf("default")).getByRole("link", { name: t("routing.thinking.fromEndpoint") })).toBeInTheDocument();
    expect(t("routing.thinking.fromEndpoint")).toBe("Set on the endpoint");
  });

  it.each(LANGUAGES)("explains it under the table when the Default row is the one in focus (%s)", async (language) => {
    await show(language);
    fireEvent.focus(within(rowOf("default")).getByRole("link", { name: t("routing.thinking.fromEndpoint") }));
    expect(screen.getByText(t("routing.thinking.hint.fromEndpoint"))).toBeInTheDocument();
    fireEvent.focus(thinkingBox("director"));
    expect(screen.queryByText(t("routing.thinking.hint.fromEndpoint"))).not.toBeInTheDocument();
  });

  it("keeps no level on the Default row when its endpoint or model changes: a level an earlier version stored there is not carried on", async () => {
    await show("en", { taskRouting: { ...ROUTING(), default: route(to("llm", "muse-big", "xhigh"), to("az", "gpt-4o")) } });
    chooseOption(endpoint("default"), "Studio Azure");
    expect(routing().default?.primary?.integrationId).toBe("az");
    expect("thinking" in (routing().default?.primary ?? {})).toBe(false);
  });

  it("explains the level of the row in focus under the table, and the chain of accounts the row can reach", async () => {
    await show();
    fireEvent.focus(thinkingBox("director"));
    expect(screen.getByText(t("routing.thinking.hint.high"))).toBeInTheDocument();
    fireEvent.focus(thinkingBox("copilot"));
    expect(screen.getByText(t("routing.thinking.hint.automatic"))).toBeInTheDocument();
    expect(thinkingBox("copilot")).toHaveAccessibleDescription(expect.stringContaining(t("routing.thinking.hint.automatic")));
    fireEvent.focus(endpoint("director"));
    expect(screen.getByText(t("routing.boundaryChain", { chain: "openai / LlmProxy (muse-big) → azure_openai / Studio Azure (gpt-4o)" }), { exact: false })).toBeInTheDocument();
  });

  it("changes the endpoint of a row keeping its model when the new endpoint has it, and its thinking always", async () => {
    await show();
    chooseOption(endpoint("director"), "Studio Azure");
    // muse-big does not exist on Azure: the first valid model is taken, and the author is told
    expect(routing().director?.primary).toEqual(to("az", "gpt-4o", "high"));
    expect(status()).toHaveTextContent(t("routing.result.modelChanged", { task: label("director"), model: "gpt-4o" }));
    chooseOption(modelBox("director"), "gpt-4.1");
    expect(routing().director?.primary).toEqual(to("az", "gpt-4.1", "high"));
    chooseOption(endpoint("autopilot"), "LlmProxy");
    expect(routing().autopilot?.primary).toEqual(to("llm", "muse-big", "medium"));
  });

  it("gives a row without a route a target when its endpoint is chosen, and takes it away again with the default option", async () => {
    await show();
    expect(modelBox("audit")).toBeDisabled();
    expect(thinkingBox("audit")).toBeDisabled();
    chooseOption(endpoint("audit"), "GitHub Models");
    expect(routing().audit).toEqual(route(to("gh", "mini")));
    expect(within(rowOf("audit")).getByText(t("routing.badge.custom"))).toBeInTheDocument();
    chooseOption(endpoint("audit"), t("routing.cell.clearPrimary"));
    expect(routing().audit).toBeUndefined();
    expect(modelBox("audit")).toBeDisabled();
  });
});

describe("R2 — filters", () => {
  it.each(LANGUAGES)("filters by group, by text and by customized rows, and counts what is shown (%s)", async (language) => {
    await show(language);
    const rowCount = () => within(section().getByRole("table")).queryAllByRole("rowheader").length;
    expect(section().getByText(t("routing.filters.count", { visible: 14, count: 14 }))).toBeInTheDocument();
    const chips = section().getByRole("group", { name: t("routing.groups.label") });
    expect(within(chips).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["all", "autopilot", "copilot", "review", "research"].map((id) => t(`routing.groups.${id}`)));
    expect(within(chips).getByRole("button", { name: t("routing.groups.all") })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(chips).getByRole("button", { name: t("routing.groups.review") }));
    expect(within(chips).getByRole("button", { name: t("routing.groups.review") })).toHaveAttribute("aria-pressed", "true");
    expect(within(chips).getByRole("button", { name: t("routing.groups.all") })).toHaveAttribute("aria-pressed", "false");
    expect(rowCount()).toBe(TEXT_GROUPS.review.length);
    expect(section().getByText(t("routing.filters.count", { visible: 5, count: 14 }))).toBeInTheDocument();

    fireEvent.click(section().getByRole("checkbox", { name: t("routing.filters.onlyCustom") }));
    expect(rowCount()).toBe(2);
    fireEvent.click(section().getByRole("checkbox", { name: t("routing.filters.onlyCustom") }));

    fireEvent.change(section().getByRole("textbox", { name: t("routing.filters.query") }), { target: { value: language === "it" ? "DIRETTORE" : "DIRECTOR" } });
    expect(rowCount()).toBe(0);
    expect(section().getByText(t("routing.table.empty"))).toBeInTheDocument();
    fireEvent.click(within(chips).getByRole("button", { name: t("routing.groups.autopilot") }));
    expect(rowCount()).toBe(1);
    expect(section().getByText(t("routing.filters.count", { visible: 1, count: 14 }))).toBeInTheDocument();
  });

  it("shows the customized rows of the tab on show, and the media sections have no filters at all", async () => {
    await show();
    fireEvent.click(section().getByRole("checkbox", { name: t("routing.filters.onlyCustom") }));
    expect(within(section().getByRole("table")).getAllByRole("row")).toHaveLength(7);
    for (const id of ["tts", "stt", "image"] as const) {
      expect(section(id).queryByRole("textbox")).not.toBeInTheDocument();
      expect(section(id).queryByRole("checkbox")).not.toBeInTheDocument();
      expect(section(id).queryByRole("group", { name: t("routing.groups.label") })).not.toBeInTheDocument();
    }
  });
});

describe("R3 — tabs: the primary and the fallbacks work the same way", () => {
  it.each(LANGUAGES)("has a tab for the primary and one for each fallback some row has, and a button for a new tab (%s)", async (language) => {
    await show(language);
    expect(section().getAllByRole("tab").map((entry) => entry.textContent)).toEqual([tabName(0), tabName(1), tabName(2)]);
    expect(section("tts").getAllByRole("tab").map((entry) => entry.textContent)).toEqual([tabName(0), tabName(1)]);
    expect(section("stt").getAllByRole("tab").map((entry) => entry.textContent)).toEqual([tabName(0)]);
    expect(tab(tabName(0))).toHaveAttribute("aria-selected", "true");
    expect(section().getByRole("button", { name: t("routing.tabs.addFor", { section: sectionTitle("text") }) })).toBeEnabled();
  });

  it("moves between the tabs with the arrow keys, Home and End", async () => {
    await show();
    tab(tabName(0)).focus();
    fireEvent.keyDown(tab(tabName(0)), { key: "ArrowRight" });
    await waitFor(() => expect(tab(tabName(1))).toHaveAttribute("aria-selected", "true"));
    expect(tab(tabName(1))).toHaveFocus();
    fireEvent.keyDown(tab(tabName(1)), { key: "End" });
    await waitFor(() => expect(tab(tabName(2))).toHaveAttribute("aria-selected", "true"));
    fireEvent.keyDown(tab(tabName(2)), { key: "Home" });
    await waitFor(() => expect(tab(tabName(0))).toHaveAttribute("aria-selected", "true"));
  });

  it("shows on a fallback tab the fallback of each row: the same table, the same filters, the same badge", async () => {
    await show();
    await goToTab(tabName(1));
    expect(endpoint("director", 1)).toHaveTextContent("Studio Azure");
    expect(modelBox("director", 1)).toHaveTextContent("gpt-4o");
    expect(thinkingBox("director", 1)).toHaveTextContent(t("routing.thinking.xhigh"));
    expect(endpoint("autopilot", 1)).toHaveTextContent("LlmProxy");
    expect(within(rowOf("director", 1)).getByText(t("routing.badge.custom"))).toBeInTheDocument();
    expect(within(rowOf("copilot", 1)).queryByText(t("routing.badge.custom"))).not.toBeInTheDocument();
    expect(section().getByRole("group", { name: t("routing.groups.label") })).toBeInTheDocument();
    expect(section().getByRole("textbox", { name: t("routing.filters.query") })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: t("routing.filters.selectAll") })).toBeInTheDocument();
    fireEvent.click(section().getByRole("checkbox", { name: t("routing.filters.onlyCustom") }));
    expect(within(section().getByRole("table")).getAllByRole("row")).toHaveLength(5);
  });

  it("says «no fallback» in an empty cell, and lets the author fill it by choosing an endpoint", async () => {
    await show();
    await goToTab(tabName(1));
    expect(endpoint("copilot", 1)).toHaveTextContent(t("routing.cell.noFallback"));
    expect(modelBox("copilot", 1)).toBeDisabled();
    chooseOption(endpoint("copilot", 1), "LlmProxy");
    expect(routing().copilot).toEqual(route(to("az", "gpt-4o", "automatic"), to("llm", "muse-big")));
    expect(modelBox("copilot", 1)).toBeEnabled();
    expect(modelBox("copilot", 1)).toHaveTextContent("muse-big");
    chooseOption(thinkingBox("copilot", 1), t("routing.thinking.low"));
    expect(routing().copilot?.fallbacks[0]).toEqual(to("llm", "muse-big", "low"));
    expect(routing().copilot?.primary?.thinking).toBe("automatic");
  });

  it("does not let a fallback be filled where there is no primary, or where the one before it is empty, and says what to do", async () => {
    await show();
    await goToTab(tabName(1));
    expect(endpoint("audit", 1)).toBeDisabled();
    // what the router would try second for a task with no route of its own is shown, dimmed, and cannot be edited before the primary is set
    expect(endpoint("audit", 1)).toHaveTextContent(t("routing.cell.default", { value: "Studio Azure" }));
    expect(within(rowOf("audit", 1)).getByText(t("routing.cell.needPrimary"))).toBeInTheDocument();
    await goToTab(tabName(2));
    expect(endpoint("copilot", 2)).toBeDisabled();
    expect(within(rowOf("copilot", 2)).getByText(t("routing.cell.needFallback", { n: 1 }))).toBeInTheDocument();
    expect(endpoint("autopilot", 2)).toBeEnabled();
    // nothing is there on the third fallback for a task without a route of its own: the cell says so
    fireEvent.click(section().getByRole("button", { name: t("routing.tabs.addFor", { section: sectionTitle("text") }) }));
    await waitFor(() => expect(tab(tabName(3))).toHaveAttribute("aria-selected", "true"));
    expect(endpoint("audit", 3)).toHaveTextContent(t("routing.cell.noFallback"));
    expect(endpoint("audit", 3)).toBeDisabled();
  });

  it("clears a fallback with the «no fallback» option, and the next one takes its place", async () => {
    await show();
    await goToTab(tabName(1));
    chooseOption(endpoint("autopilot", 1), t("routing.cell.noFallback"));
    expect(routing().autopilot).toEqual(route(to("az", "gpt-4.1", "medium"), to("gh", "mini")));
    expect(status()).toHaveTextContent(t("routing.result.cleared", { task: label("autopilot"), tab: tabName(1) }));
    expect(endpoint("autopilot", 1)).toHaveTextContent("GitHub Models");
  });

  it("promotes the first fallback when the primary of a row is cleared, so that no fallback is left without a primary", async () => {
    await show();
    chooseOption(endpoint("director"), t("routing.cell.clearPrimary"));
    expect(routing().director).toEqual(route(to("az", "gpt-4o", "xhigh")));
    expect(status()).toHaveTextContent(t("routing.result.promoted", { task: label("director"), tab: tabName(1) }));
    fireEvent.click(within(status().parentElement as HTMLElement).getByRole("button", { name: t("routing.undo") }));
    expect(routing().director).toEqual(ROUTING().director);
  });

  it("warns on a row that has fallbacks and no primary, in words, and does not pretend the fallback is not used", async () => {
    await show("en", { taskRouting: { ...ROUTING(), audit: { primary: undefined, fallbacks: [to("az", "gpt-4o")] } } });
    expect(within(rowOf("audit")).getByText(t("routing.warn.orphan"))).toBeInTheDocument();
    expect(within(rowOf("director")).queryByText(t("routing.warn.orphan"))).not.toBeInTheDocument();
  });

  it("adds a tab with «New tab»: it is empty, selected, and stays only as long as the page does", async () => {
    await show();
    fireEvent.click(section().getByRole("button", { name: t("routing.tabs.addFor", { section: sectionTitle("text") }) }));
    await waitFor(() => expect(tab(tabName(3))).toHaveAttribute("aria-selected", "true"));
    expect(section().getAllByRole("tab")).toHaveLength(4);
    expect(endpoint("autopilot", 3)).toBeEnabled();
    expect(endpoint("autopilot", 3)).toHaveTextContent(t("routing.cell.noFallback"));
    expect(endpoint("director", 3)).toBeDisabled();
    expect(Object.values(routing()).every((entry) => (entry.fallbacks?.length ?? 0) <= 2)).toBe(true);
    chooseOption(endpoint("autopilot", 3), "Studio Azure");
    expect(routing().autopilot?.fallbacks).toHaveLength(3);
    // the limit of candidates (4): primary + 3 fallbacks is as far as it goes
    expect(section().getByRole("button", { name: t("routing.tabs.addFor", { section: sectionTitle("text") }) })).toBeDisabled();
  });

  it("does not add tabs beyond the limit of candidates of the execution options", async () => {
    await show("en", { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxCandidates: 3 } });
    expect(section().getByRole("button", { name: t("routing.tabs.addFor", { section: sectionTitle("text") }) })).toBeDisabled();
    expect(section("stt").getByRole("button", { name: t("routing.tabs.addFor", { section: sectionTitle("stt") }) })).toBeEnabled();
  });

  it("never throws away a fallback beyond the limit when a row is edited: it only stops adding", async () => {
    await show("en", { routingExecution: { ...DEFAULT_SETTINGS.routingExecution, maxCandidates: 2 } });
    chooseOption(thinkingBox("autopilot"), t("routing.thinking.low"));
    expect(routing().autopilot?.fallbacks).toHaveLength(2);
  });

  it("asks before deleting a tab, saying how many rows lose it, then removes it and moves the later ones up", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await show();
    await goToTab(tabName(1));
    chooseMenuItem(section().getByRole("button", { name: t("routing.tabs.moreFor", { tab: tabName(1), section: sectionTitle("text") }) }), t("routing.tabs.delete"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toBe(t("routing.tabs.deleteConfirm", { count: 4, tab: tabName(1) }));
    expect(routing()).toEqual(ROUTING());

    confirm.mockReturnValue(true);
    chooseMenuItem(section().getByRole("button", { name: t("routing.tabs.moreFor", { tab: tabName(1), section: sectionTitle("text") }) }), t("routing.tabs.delete"));
    expect(routing().director).toEqual(route(to("llm", "muse-big", "high")));
    expect(routing().autopilot).toEqual(route(to("az", "gpt-4.1", "medium"), to("gh", "mini")));
    expect(routing().default).toEqual(route(to("llm", "muse-big")));
    await waitFor(() => expect(section().getAllByRole("tab")).toHaveLength(2));
    expect(status()).toHaveTextContent(t("routing.result.deleted", { tab: tabName(1), count: 4 }));
    fireEvent.click(within(status().parentElement as HTMLElement).getByRole("button", { name: t("routing.undo") }));
    expect(routing()).toEqual(ROUTING());
    await waitFor(() => expect(section().getAllByRole("tab")).toHaveLength(3));
  });

  it("deletes a tab only from the selected rows when some are selected, and has no delete for the primary", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await show();
    await goToTab(tabName(1));
    select("director");
    chooseMenuItem(section().getByRole("button", { name: t("routing.tabs.moreFor", { tab: tabName(1), section: sectionTitle("text") }) }), t("routing.tabs.delete"));
    expect(routing().director).toEqual(route(to("llm", "muse-big", "high")));
    expect(routing().autopilot).toEqual(ROUTING().autopilot);
    await goToTab(tabName(0));
    const menu = openMenu(section().getByRole("button", { name: t("routing.tabs.moreFor", { tab: tabName(0), section: sectionTitle("text") }) }));
    expect(within(menu).queryByRole("menuitem", { name: t("routing.tabs.delete") })).not.toBeInTheDocument();
    fireEvent.keyDown(menu, { key: "Escape" });
  });
});

describe("R3 — swapping tabs", () => {
  it.each(LANGUAGES)("swaps the targets of every row, thinking included, says how many in a status message, and can be undone (%s)", async (language) => {
    await show(language);
    const before = ROUTING();
    chooseMenuItem(section().getByRole("button", { name: t("routing.tabs.swapFor", { section: sectionTitle("text") }) }), t("routing.tabs.swapWith", { tab: tabName(1) }));
    expect(routing().director).toEqual(route(to("az", "gpt-4o", "xhigh"), to("llm", "muse-big", "high")));
    expect(routing().autopilot).toEqual(route(to("llm", "muse-big", "high"), to("az", "gpt-4.1", "medium"), to("gh", "mini")));
    expect(routing().default).toEqual(route(to("az", "gpt-4o"), to("llm", "muse-big")));
    // rows with nothing on Fallback 1 are left alone, and the author is told
    expect(routing().copilot).toEqual(before.copilot);
    expect(status()).toHaveTextContent(t("routing.result.swapped", { count: 4, a: tabName(0), b: tabName(1) }));
    expect(status()).toHaveTextContent(t("routing.result.swapSkipped", { count: 2 }));
    expect(t("routing.result.swapped", { count: 14, a: tabName(0), b: tabName(1) })).toMatch(language === "it" ? /^Scambiate 14 righe tra Primario e Fallback 1/ : /^Swapped 14 rows between Primary and Fallback 1/);

    fireEvent.click(within(status().parentElement as HTMLElement).getByRole("button", { name: t("routing.undo") }));
    expect(routing()).toEqual(before);
    expect(status()).toHaveTextContent(t("routing.result.undone"));
    expect(within(status().parentElement as HTMLElement).queryByRole("button", { name: t("routing.undo") })).not.toBeInTheDocument();
  });

  it("swaps only the selected rows when some are selected, and says which scope the menu will use", async () => {
    await show();
    const trigger = () => section().getByRole("button", { name: t("routing.tabs.swapFor", { section: sectionTitle("text") }) });
    let menu = openMenu(trigger());
    expect(within(menu).getByText(t("routing.tabs.scopeAll", { count: 14 }))).toBeInTheDocument();
    fireEvent.keyDown(menu, { key: "Escape" });
    select("director", "review");
    menu = openMenu(trigger());
    expect(within(menu).getByText(t("routing.tabs.scopeSelected", { count: 2 }))).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: t("routing.tabs.swapWith", { tab: tabName(2) }) }));
    // Fallback 2 exists only on autopilot: the two selected rows would be left with a hole, so they stay as they were
    expect(routing().director).toEqual(ROUTING().director);
    expect(status()).toHaveTextContent(t("routing.result.nothingSwapped", { a: tabName(0), b: tabName(2) }));
    chooseMenuItem(trigger(), t("routing.tabs.swapWith", { tab: tabName(1) }));
    expect(routing().director?.primary).toEqual(to("az", "gpt-4o", "xhigh"));
    expect(routing().review?.primary).toEqual(to("az", "gpt-4.1"));
    expect(routing().autopilot).toEqual(ROUTING().autopilot);
    expect(status()).toHaveTextContent(t("routing.result.swapped", { count: 2, a: tabName(0), b: tabName(1) }));
  });

  it("swaps two fallbacks with each other, and moves a tab left or right as a swap with its neighbour", async () => {
    await show();
    await goToTab(tabName(1));
    chooseMenuItem(section().getByRole("button", { name: t("routing.tabs.moreFor", { tab: tabName(1), section: sectionTitle("text") }) }), t("routing.tabs.moveRight"));
    expect(routing().autopilot).toEqual(route(to("az", "gpt-4.1", "medium"), to("gh", "mini"), to("llm", "muse-big", "high")));
    await waitFor(() => expect(tab(tabName(2))).toHaveAttribute("aria-selected", "true"));
    chooseMenuItem(section().getByRole("button", { name: t("routing.tabs.moreFor", { tab: tabName(2), section: sectionTitle("text") }) }), t("routing.tabs.moveLeft"));
    expect(routing().autopilot).toEqual(ROUTING().autopilot);
    await waitFor(() => expect(tab(tabName(1))).toHaveAttribute("aria-selected", "true"));
  });

  it("does not offer a move beyond the first or the last tab, and has the swap on a section with one tab too", async () => {
    await show();
    const more = (name: string, id: "text" | "stt" = "text") => section(id).getByRole("button", { name: t("routing.tabs.moreFor", { tab: name, section: sectionTitle(id) }) });
    let menu = openMenu(more(tabName(0)));
    expect(within(menu).getByRole("menuitem", { name: t("routing.tabs.moveLeft") })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(menu, { key: "Escape" });
    menu = openMenu(more(tabName(0), "stt"));
    expect(within(menu).getByRole("menuitem", { name: t("routing.tabs.moveRight") })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(menu, { key: "Escape" });
  });

  it("changes any other thing: the undo is no longer offered", async () => {
    await show();
    chooseMenuItem(section().getByRole("button", { name: t("routing.tabs.swapFor", { section: sectionTitle("text") }) }), t("routing.tabs.swapWith", { tab: tabName(1) }));
    expect(within(status().parentElement as HTMLElement).getByRole("button", { name: t("routing.undo") })).toBeInTheDocument();
    chooseOption(thinkingBox("director"), t("routing.thinking.low"));
    expect(within(status().parentElement as HTMLElement).queryByRole("button", { name: t("routing.undo") })).not.toBeInTheDocument();
  });
});

describe("R3 — the media sections: the same tabs and the same swap, on one row", () => {
  it.each(LANGUAGES)("swaps the primary and the fallback of the voice, the transcription and the images with the menu (%s)", async (language) => {
    await show(language);
    const speech = sectionTitle("tts");
    chooseMenuItem(section("tts").getByRole("button", { name: t("routing.tabs.swapFor", { section: speech }) }), t("routing.tabs.swapWith", { tab: tabName(1) }));
    expect(routing().tts).toEqual(route(to("az", "tts-1"), to("__browser__", "browser")));
    expect(status("tts")).toHaveTextContent(t("routing.result.swapped", { count: 1, a: tabName(0), b: tabName(1) }));
    // nothing to swap with on a section that has only a primary
    expect(section("stt").queryByRole("button", { name: t("routing.tabs.swapFor", { section: sectionTitle("stt") }) })).toBeDisabled();
  });

  it("fills the first fallback of the transcription, and keeps the browser for the two speech tasks only", async () => {
    await show();
    const stt = section("stt");
    fireEvent.click(stt.getByRole("button", { name: t("routing.tabs.addFor", { section: sectionTitle("stt") }) }));
    await waitFor(() => expect(stt.getByRole("tab", { name: tabName(1) })).toHaveAttribute("aria-selected", "true"));
    chooseOption(endpoint("stt", 1), t("routing.browser"));
    expect(routing().stt).toEqual(route(to("az", "whisper-1"), to("__browser__", "browser")));
    expect(screen.getAllByText(t("routing.browser")).length).toBeGreaterThan(0);
  });

  it("shows no thinking and no selection on a media row, and lists the one voice or image model of each endpoint", async () => {
    await show();
    expect(screen.queryByRole("combobox", { name: t("routing.cell.thinking", { task: label("tts"), tab: tabName(0) }) })).not.toBeInTheDocument();
    expect(optionNames(modelBox("image"))).toEqual(["gpt-image-1"]);
    chooseOption(endpoint("image"), "LlmProxy");
    expect(routing().image).toEqual(route(to("llm", "sd-turbo"), to("llm", "sd-turbo")));
  });
});

describe("R4 — editing the selected rows all together", () => {
  it("shows the panel only when rows are selected, counts them, and changes nothing until «Apply»", async () => {
    await show();
    expect(screen.queryByRole("group", { name: /selected|selezionate/i })).not.toBeInTheDocument();
    select("director", "autopilot", "review");
    expect(within(screen.getByRole("group", { name: t("routing.bulk.title", { count: 3 }) })).getByText(t("routing.bulk.title", { count: 3 }))).toBeInTheDocument();
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.endpointLabel") }), "Studio Azure");
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") }), "gpt-4o");
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.thinkingLabel") }), t("routing.thinking.low"));
    expect(routing()).toEqual(ROUTING());
    expect(screen.getByRole("button", { name: t("routing.bulk.apply", { count: 3 }) })).toBeEnabled();
    fireEvent.click(rowCheckbox("review"));
    expect(screen.getByRole("button", { name: t("routing.bulk.apply", { count: 2 }) })).toBeInTheDocument();
  });

  it("(a) changes endpoint and model for every selected row and leaves their thinking as it was", async () => {
    await show();
    select("director", "autopilot", "review");
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.endpointLabel") }), "Studio Azure");
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") }), "gpt-4o");
    fireEvent.click(screen.getByRole("button", { name: t("routing.bulk.apply", { count: 3 }) }));
    expect(routing().director?.primary).toEqual(to("az", "gpt-4o", "high"));
    expect(routing().autopilot?.primary).toEqual(to("az", "gpt-4o", "medium"));
    expect(routing().review?.primary).toEqual(to("az", "gpt-4o", "low"));
    expect(routing().director?.fallbacks).toEqual(ROUTING().director?.fallbacks);
    expect(status()).toHaveTextContent(t("routing.result.applied", { count: 3 }));
  });

  it("(b) changes only the model, the endpoint left alone, and leaves the thinking as it was", async () => {
    await show();
    select("director", "reader-evaluation");
    expect(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") })).toBeEnabled();
    expect(optionNames(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") }))).toEqual([t("routing.bulk.keep"), "muse-big", `legacy · ${t("routing.warn.noToolCalls")}`]);
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") }), /^legacy/);
    fireEvent.click(screen.getByRole("button", { name: t("routing.bulk.apply", { count: 2 }) }));
    expect(routing().director?.primary).toEqual(to("llm", "legacy", "high"));
    expect(routing()["reader-evaluation"]?.primary).toEqual(to("llm", "legacy"));
    expect(status()).toHaveTextContent(t("routing.result.applied", { count: 1 }));
    expect(status()).toHaveTextContent(t("routing.result.unchanged", { count: 1 }));
  });

  it("(c) changes everything, thinking included, on all the visible rows, giving a target to the rows that had none", async () => {
    await show();
    fireEvent.click(screen.getByRole("checkbox", { name: t("routing.filters.selectAll") }));
    expect(rowCheckbox("audit")).toBeChecked();
    expect(screen.getByText(t("routing.bulk.title", { count: 14 }))).toBeInTheDocument();
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.endpointLabel") }), "GitHub Models");
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") }), "mini");
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.thinkingLabel") }), t("routing.thinking.xhigh"));
    fireEvent.click(screen.getByRole("button", { name: t("routing.bulk.apply", { count: 14 }) }));
    // The Default row has no thinking of its own (it is the endpoint's): it takes the endpoint and the model, and not the level.
    for (const task of CHAT_CAPABILITIES.filter((entry) => entry !== "default")) expect(routing()[task]?.primary, task).toEqual(to("gh", "mini", "xhigh"));
    expect(routing().default?.primary).toEqual(to("gh", "mini"));
    expect(routing().director?.fallbacks).toEqual(ROUTING().director?.fallbacks);
    expect(status()).toHaveTextContent(t("routing.result.applied", { count: 14 }));
    expect(status()).toHaveTextContent(t("routing.result.created", { count: 8 }));
  });

  it.each(LANGUAGES)("leaves the thinking of the Default row alone and says why, when it is among the selected rows (%s)", async (language) => {
    await show(language);
    select("default", "director");
    expect(screen.queryByText(t("routing.bulk.defaultThinking"))).not.toBeInTheDocument();
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.thinkingLabel") }), t("routing.thinking.low"));
    expect(screen.getByText(t("routing.bulk.defaultThinking"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("routing.bulk.apply", { count: 2 }) }));
    expect(routing().director?.primary).toEqual(to("llm", "muse-big", "low"));
    expect(routing().default?.primary).toEqual(to("llm", "muse-big"));
  });

  it("does not mention the Default row when it is not selected", async () => {
    await show();
    select("director", "autopilot");
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.thinkingLabel") }), t("routing.thinking.low"));
    expect(screen.queryByText(t("routing.bulk.defaultThinking"))).not.toBeInTheDocument();
  });

  it("selects only what the filters show", async () => {
    await show();
    fireEvent.click(section().getByRole("button", { name: t("routing.groups.research") }));
    fireEvent.click(screen.getByRole("checkbox", { name: t("routing.filters.selectAll") }));
    expect(screen.getByText(t("routing.bulk.title", { count: 2 }))).toBeInTheDocument();
    fireEvent.click(section().getByRole("button", { name: t("routing.groups.all") }));
    expect(screen.getByText(t("routing.bulk.title", { count: 2 }))).toBeInTheDocument();
    expect(rowCheckbox("deep-research")).toBeChecked();
    expect(rowCheckbox("director")).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: t("routing.filters.selectAll") })).toHaveProperty("indeterminate", true);
  });

  it("changes only the thinking, and «inherit» takes it away", async () => {
    await show();
    select("director", "autopilot");
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.thinkingLabel") }), t("routing.thinking.inherit"));
    fireEvent.click(screen.getByRole("button", { name: t("routing.bulk.apply", { count: 2 }) }));
    expect(routing().director?.primary).toEqual(to("llm", "muse-big"));
    expect(routing().autopilot?.primary).toEqual(to("az", "gpt-4.1"));
  });

  it("asks for an endpoint first when the selected rows use different ones, and says so", async () => {
    await show();
    select("director", "autopilot");
    expect(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") })).toBeDisabled();
    expect(screen.getByText(t("routing.bulk.needEndpoint"))).toBeInTheDocument();
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.endpointLabel") }), "LlmProxy");
    expect(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") })).toBeEnabled();
    expect(screen.queryByText(t("routing.bulk.needEndpoint"))).not.toBeInTheDocument();
    expect(optionNames(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") }))).toEqual([t("routing.bulk.keepModel"), "muse-big", `legacy · ${t("routing.warn.noToolCalls")}`]);
  });

  it("offers only the models that suit every selected task on the chosen endpoint", async () => {
    await show();
    select("simple-tasks", "chat-resume");
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.endpointLabel") }), "LlmProxy");
    expect(optionNames(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") }))).toEqual([t("routing.bulk.keepModel"), "muse-big", "muse-small", `legacy · ${t("routing.warn.noToolCalls")}`]);
    fireEvent.click(rowCheckbox("simple-tasks"));
    fireEvent.click(rowCheckbox("director"));
    expect(optionNames(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") }))).toEqual([t("routing.bulk.keepModel"), "muse-big", `legacy · ${t("routing.warn.noToolCalls")}`]);
  });

  it.each(LANGUAGES)("tells how many rows changed, got a target, took the first model, or were skipped and why, and can be undone (%s)", async (language) => {
    await show(language);
    await goToTab(tabName(1));
    fireEvent.click(screen.getByRole("checkbox", { name: t("routing.filters.selectAll") }));
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.endpointLabel") }), "LlmProxy");
    fireEvent.click(screen.getByRole("button", { name: t("routing.bulk.apply", { count: 14 }) }));
    // rows with a primary get a fallback or have theirs replaced; rows without a primary are left as they were
    expect(routing().copilot).toEqual(route(to("az", "gpt-4o", "automatic"), to("llm", "muse-big")));
    expect(routing().director?.fallbacks[0]).toEqual(to("llm", "muse-big", "xhigh"));
    expect(routing().audit).toBeUndefined();
    expect(status()).toHaveTextContent(t("routing.result.skipped", { reasons: t("routing.result.reason.noPrimary", { count: 8 }) }));
    fireEvent.click(within(status().parentElement as HTMLElement).getByRole("button", { name: t("routing.undo") }));
    expect(routing()).toEqual(ROUTING());
  });

  it("drops a chosen model that no longer suits the selection, from what is shown and from what is applied", async () => {
    await show();
    select("simple-tasks");
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.endpointLabel") }), "LlmProxy");
    chooseOption(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") }), "muse-small");
    expect(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") })).toHaveTextContent("muse-small");
    // muse-small serves only the simple tasks and the chat resume: it does not suit the director
    select("director");
    expect(screen.getByRole("combobox", { name: t("routing.bulk.modelLabel") })).toHaveTextContent(t("routing.bulk.keepModel"));
    fireEvent.click(screen.getByRole("button", { name: t("routing.bulk.apply", { count: 2 }) }));
    expect(routing()["simple-tasks"]?.primary).toEqual(to("llm", "muse-big"));
    expect(routing().director?.primary).toEqual(to("llm", "muse-big", "high"));
  });

  it("keeps the selection when the tab changes, so the same rows can be edited on each tab", async () => {
    await show();
    select("director", "autopilot");
    await goToTab(tabName(1));
    expect(rowCheckbox("director")).toBeChecked();
    expect(screen.getByText(t("routing.bulk.title", { count: 2 }))).toBeInTheDocument();
  });
});

describe("R5 — models that cannot call tools", () => {
  it("labels such a model in the list and in the row, and warns that the autopilot's structured steps cannot use it", async () => {
    await show();
    expect(modelBox("reader-evaluation")).toHaveTextContent(`legacy · ${t("routing.warn.noToolCalls")}`);
    expect(within(rowOf("reader-evaluation")).getByText(t("routing.warn.structuredSteps"))).toBeInTheDocument();
    expect(within(rowOf("director")).queryByText(t("routing.warn.structuredSteps"))).not.toBeInTheDocument();
  });

  it("keeps the warning off when the author turned «Tools only» off", async () => {
    await show("en", { aiToolsOnly: false });
    expect(modelBox("reader-evaluation")).toHaveTextContent(`legacy · ${t("routing.warn.noToolCalls")}`);
    expect(within(rowOf("reader-evaluation")).queryByText(t("routing.warn.structuredSteps"))).not.toBeInTheDocument();
  });

  it.each(LANGUAGES)("says the same in both languages (%s)", async (language) => {
    await i18n.changeLanguage(language);
    expect(t("routing.warn.structuredSteps")).toMatch(language === "it" ? /Solo tool/ : /Tools only/);
    expect(t("routing.warn.noToolCalls")).toBe(language === "it" ? "senza tool call" : "no tool calls");
  });
});

describe("R6 — what was saved before still shows, and nothing is lost", () => {
  it("shows settings saved without any thinking, and keeps them without one", async () => {
    const plain = ROUTING();
    for (const entry of Object.values(plain)) { delete entry.primary?.thinking; entry.fallbacks.forEach((target) => delete target.thinking); }
    await show("en", { taskRouting: plain });
    expect(thinkingBox("director")).toHaveTextContent(t("routing.thinking.inherit"));
    chooseOption(endpoint("director"), "Studio Azure");
    expect("thinking" in (routing().director?.primary ?? {})).toBe(false);
  });

  it("shows a target whose integration or model has gone as unavailable, in words, instead of a blank cell", async () => {
    await show("en", { taskRouting: { ...ROUTING(), audit: route(to("gone", "x")), review: route(to("gh", "removed-model")) } });
    expect(endpoint("audit")).toHaveTextContent(t("routing.cell.gone", { name: "gone" }));
    expect(modelBox("audit")).toHaveTextContent(t("routing.cell.gone", { name: "x" }));
    expect(endpoint("review")).toHaveTextContent("GitHub Models");
    expect(modelBox("review")).toHaveTextContent(t("routing.cell.gone", { name: "removed-model" }));
    // the page still tells that the route is broken, and the cell can be put right by choosing again
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    chooseOption(endpoint("audit"), "LlmProxy");
    expect(routing().audit?.primary).toEqual(to("llm", "muse-big"));
  });

  it("keeps routes the page does not show (a task of another kind in the data) untouched when rows change", async () => {
    await show();
    chooseOption(endpoint("director"), "Studio Azure");
    expect(routing().tts).toEqual(ROUTING().tts);
    expect(routing().image).toEqual(ROUTING().image);
  });
});

describe("R7 — accessibility and texts", () => {
  it.each(LANGUAGES)("gives every control a name of its own that names the task, and nothing is read out as a live region but the status messages (%s)", async (language) => {
    const view = await show(language);
    for (const control of Array.from(view.container.querySelectorAll<HTMLElement>("[role=combobox], [role=switch], [role=tab], input:not([type=hidden]), button:not([role])"))) expect(control, control.outerHTML.slice(0, 120)).toHaveAccessibleName();
    const controls = within(section().getByRole("table")).getAllByRole("combobox");
    const accessible = controls.map((control) => control.getAttribute("aria-label"));
    expect(new Set(accessible).size).toBe(accessible.length);
    for (const task of TEXT_TASK_ORDER) expect(accessible.some((name) => name?.includes(label(task)))).toBe(true);
    expect(view.container.querySelectorAll("[aria-live]")).toHaveLength(0);
    // The four sections have one status each, and the «Tools only» switch has the one of its notes (there from the start, so that a change is said once).
    expect(view.container.querySelectorAll("[role=status]")).toHaveLength(5);
    expect(view.container.querySelectorAll("[role=alert]")).toHaveLength(0);
    // no two controls of the page share a name inside the same table
    for (const id of ["text", "tts", "stt", "image"] as const) {
      const all = within(section(id).getByRole("table")).getAllByRole("combobox").map((control) => control.getAttribute("aria-label"));
      expect(new Set(all).size, id).toBe(all.length);
    }
  });

  it("adds no tab stop of its own around the table: the controls are the tab stops, and the checkbox labels are big enough to hit", async () => {
    await show();
    expect(section().getByRole("tabpanel")).toHaveAttribute("tabindex", "-1");
    expect(section().getByRole("table").closest("[role=group]")).not.toHaveAttribute("tabindex");
    for (const name of [t("routing.filters.onlyCustom"), t("routing.filters.selectAll")]) expect(section().getByRole("checkbox", { name }).closest("label")).toHaveClass("min-h-6");
    expect(section().getByRole("checkbox", { name: t("routing.cell.select", { task: label("director") }) }).closest("label")).toHaveClass("h-8", "w-6");
  });

  it("keeps the labels of the old page that other tests and the engine rely on: every field has a label, every reference resolves", async () => {
    const view = await show();
    const ids = Array.from(view.container.querySelectorAll("[id]")).map((element) => element.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    const dangling: string[] = [];
    view.container.querySelectorAll("[aria-labelledby],[aria-describedby]").forEach((element) => {
      for (const attribute of ["aria-labelledby", "aria-describedby"]) for (const id of (element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean)) if (!document.getElementById(id)) dangling.push(`${attribute}=${id}`);
    });
    expect(dangling).toEqual([]);
    const orphans = Array.from(view.container.querySelectorAll("label")).filter((entry) => !(entry as HTMLLabelElement).control).map((entry) => entry.textContent);
    expect(orphans).toEqual([]);
  });

  it("has no text smaller than 12px and no literal wording in the new components", () => {
    const folder = resolve(process.cwd(), "src/components/settings/router");
    const files = readdirSync(folder).filter((name) => name.endsWith(".tsx")).map((name) => readFileSync(resolve(folder, name), "utf8"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const source of files) {
      expect(source.match(/text-\[\d+px\]/g) ?? []).toEqual([]);
      expect(Array.from(source.matchAll(/\b(?:label|aria-label|title|alt)="([^"]*)"/g)).map((match) => match[1])).toEqual([]);
      expect(Array.from(source.matchAll(/<\/?[A-Za-z][^<>]*>([^<>{}\[\]:=]*[A-Za-z]{3,}[^<>{}\[\]:=]*)</g)).map((match) => match[1].trim()).filter(Boolean)).toEqual([]);
    }
  });
});

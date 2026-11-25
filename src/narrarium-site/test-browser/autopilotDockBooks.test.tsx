import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutopilotState, summarizeAutopilotState, type AutopilotActivity, type AutopilotState, type DirectorQuestion } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { AutopilotLauncher } from "@/components/autopilot/AutopilotLauncher";
import { AutopilotHubPage } from "@/pages/AutopilotHubPage";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { CONNECTION, makeRuntime, t } from "./helpers/quickCommands";
import { SERVER_INFO } from "./helpers/fakeBookServer";

// Three books whose autopilots the author does not see from the page of a fourth: two run (one here, one on the personal server), one waits for
// an answer. The live panel, its launcher and the page of every book say all three at a glance, each with its name, its host and its state.

const NOW = new Date();
const at = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
const book = (id: string, name: string, host?: "server"): BookEntry => ({ id, owner: "local", repo: id, name, tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-20T00:00:00.000Z", ...(host ? { autopilotHost: host } : {}) });
const GLASS = book("glass", "The Glass Harbor");
const TIDE = book("tide", "Tide Lines", "server");
const SALT = book("salt", "Salt and Silence");
const PAGE = book("page", "The Book of the Page");
const QUESTION: DirectorQuestion = { id: "q-1", kind: "director", question: "Keep the ending open?", context: "", options: [], askedAt: at(60) };

function stateOf(status: AutopilotState["status"], patch: Partial<AutopilotState> = {}): AutopilotState {
  const runner = status === "running" ? { host: "browser" as const, label: "This browser", runId: "run-1", startedAt: at(120), heartbeatAt: at(5) } : null;
  return { ...createAutopilotState(new Date(at(600))), status, phase: "write", runner, updatedAt: at(5), ...patch };
}

const stepOf = (id: string, title: string): AutopilotActivity => ({ id, runId: "run-1", task: "write", phase: "write", title, reason: "", next: "", status: "running", startedAt: at(42), chapterNumber: 3, sceneNumber: 2 });

function seed(path: string) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [GLASS, TIDE, SALT, PAGE], aiIntegrations: [{ id: "ai-1" } as never], personalServer: CONNECTION } });
  const glass = stateOf("running");
  const tide = { ...stateOf("running"), runner: { host: "server" as const, label: "Home server", runId: "run-2", startedAt: at(300), heartbeatAt: at(3) } };
  const salt = stateOf("waiting-author", { question: QUESTION });
  const view = (id: string, state: AutopilotState, running = false) => ({ ...emptyView(id), snapshot: { bookId: id, state, summary: summarizeAutopilotState(state), activities: [], live: null, running, host: null } });
  useAutopilotStore.setState({
    dockOpen: true,
    dockTab: "live",
    views: { glass: view("glass", glass, true), tide: view("tide", tide), salt: view("salt", salt) },
    summaries: { glass: summarizeAutopilotState(glass), tide: summarizeAutopilotState(tide), salt: { ...summarizeAutopilotState(salt), question: QUESTION } },
    live: { glass: { activity: stepOf("s-glass", "Writing scene 2 of chapter 3"), characters: 0, preview: "" }, tide: { activity: stepOf("s-tide", "Planning the scenes of chapter 5"), characters: 0, preview: "" } },
    feed: [],
    server: { status: "online", info: SERVER_INFO, message: null, books: [{ bookId: "tide", title: TIDE.name, storage: { kind: "local" }, hasGithubToken: false, ready: true, revision: "r1", autopilot: summarizeAutopilotState(tide), running: true, lastSync: null }], updates: null, connection: CONNECTION },
  });
  return render(<MemoryRouter initialEntries={[path]}><AutopilotLauncher /><AutopilotDock /></MemoryRouter>);
}

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", dockFocusBook: null, whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the launcher of the live panel, from the page of another book", () => {
  it("says how many autopilots run, and its name says which books and how many wait for the author", () => {
    seed("/app/books/page");
    const launcher = screen.getByRole("button", { name: new RegExp(`^${t("autopilot.openDock")}:`) });
    expect(launcher).toHaveAccessibleName(`${t("autopilot.openDock")}: ${t("autopilot.launcherRunning", { count: 2 })} (The Glass Harbor, Tide Lines) · ${t("autopilot.launcherAttention", { count: 1 })}`);
    expect(launcher.querySelector("[data-launcher-label]")).toHaveTextContent(t("autopilot.launcherRunning", { count: 2 }));
  });

  it("says it in Italian", async () => {
    await i18n.changeLanguage("it");
    seed("/app/books/page");
    expect(screen.getByRole("button", { name: /^Mostra cosa sta facendo l'autopilot:/ })).toHaveAccessibleName("Mostra cosa sta facendo l'autopilot: 2 autopilot in esecuzione (The Glass Harbor, Tide Lines) · 1 ti aspetta");
  });

  it("leaves out a run nobody has heard of for hours, by the engine's rule, which the shell loads only once a book says that it runs", async () => {
    seed("/app/books/page");
    // Another tab said that «Salt and Silence» ran, three hours ago, and was heard no more.
    const silent: AutopilotState = { ...stateOf("running"), runner: { host: "browser", label: "Another tab", runId: "run-3", startedAt: at(4 * 3600), heartbeatAt: at(3 * 3600) }, updatedAt: at(3 * 3600) };
    act(() => useAutopilotStore.setState((state) => ({ summaries: { ...state.summaries, salt: summarizeAutopilotState(silent) }, views: { glass: state.views.glass, tide: state.views.tide } })));
    const launcher = screen.getByRole("button", { name: new RegExp(`^${t("autopilot.openDock")}:`) });
    await waitFor(() => expect(launcher).toHaveAccessibleName(`${t("autopilot.openDock")}: ${t("autopilot.launcherRunning", { count: 2 })} (The Glass Harbor, Tide Lines)`));
    // The live panel, which has the rule with the engine, agrees with it.
    expect([...document.querySelectorAll("[data-dock-book]")].map((card) => card.getAttribute("data-dock-book"))).toEqual(["glass", "tide"]);
  });
});

describe("the “Live” tab", () => {
  it("has a card for every book whose autopilot is active, told apart by its name, its host and its state, each the way to its page", () => {
    seed("/app/books/page");
    const section = screen.getByRole("region", { name: t("autopilot.dockTitle") }).querySelector("[data-dock-active]") as HTMLElement;
    expect(within(section).getByRole("heading", { name: t("autopilot.dock.activeTitle", { count: 3 }) })).toBeInTheDocument();
    const cards = within(section).getAllByRole("listitem").filter((item) => item.hasAttribute("data-dock-book"));
    expect(cards.map((card) => card.getAttribute("data-dock-book"))).toEqual(["salt", "glass", "tide"]);
    for (const [card, name] of [[cards[0], "Salt and Silence"], [cards[1], "The Glass Harbor"], [cards[2], "Tide Lines"]] as const) {
      const link = within(card).getByRole("link", { name: t("autopilot.dock.openBook", { book: name }) });
      expect(link).toHaveAttribute("href", `/app/books/${card.getAttribute("data-dock-book")}/autopilot`);
      expect(within(card).getByRole("heading", { level: 4 })).toHaveTextContent(name);
    }
    expect(cards[2].querySelector("[data-band-host]")).toHaveTextContent(t("autopilot.host.server"));
    expect(cards[1].querySelector("[data-band-host]")).toHaveTextContent(t("autopilot.host.browser"));
    expect(cards[1]).toHaveTextContent("Writing scene 2 of chapter 3");
    expect(cards[2]).toHaveTextContent("Planning the scenes of chapter 5");
    expect(cards[0].querySelector("[data-band-status]")).toHaveTextContent(t("autopilot.status.waiting-author"));
  });

  it("speaks with one polite voice for all the books: the step of a card is never read out as it changes", () => {
    seed("/app/books/page");
    const panel = screen.getByRole("region", { name: t("autopilot.dockTitle") });
    expect(panel.querySelectorAll("[data-live-announcer]")).toHaveLength(1);
    // What a card says aloud is only the outcome of a command given on it (its chips, its operation), never the steps of its run.
    const steps = [...panel.querySelectorAll("[data-dock-book] [data-band-now]")];
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (const step of steps) expect(step.querySelector('[role="status"], [aria-live]')).toBeNull();
  });

  it("names the commands of every card after its book, so that two cards never repeat a name", () => {
    seed("/app/books/page");
    const groups = screen.getAllByRole("group").filter((group) => group.hasAttribute("data-quick-commands"));
    const names = groups.map((group) => group.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((name) => name?.includes("The Glass Harbor"))).toBe(true);
    expect(names.some((name) => name?.includes("Tide Lines"))).toBe(true);
  });

  it("goes back to the mini-player of the book in focus when no autopilot is active", () => {
    seed("/app/autopilot");
    act(() => useAutopilotStore.setState({ summaries: {}, views: {}, live: {}, server: { ...useAutopilotStore.getState().server, books: [] } }));
    expect(document.querySelector("[data-dock-active]")).toBeNull();
  });
});

describe("the page of every book", () => {
  it("says the active autopilots in one row above the cards, each with its state, its name, its host and its step", () => {
    seed("/app/autopilot");
    cleanup();
    render(<MemoryRouter initialEntries={["/app/autopilot"]}><AutopilotHubPage /></MemoryRouter>);
    const row = document.querySelector("[data-hub-active]") as HTMLElement;
    expect(within(row).getByRole("heading", { name: t("autopilot.hub.activeTitle", { count: 3 }) })).toBeInTheDocument();
    const links = within(row).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/app/books/salt/autopilot", "/app/books/glass/autopilot", "/app/books/tide/autopilot"]);
    expect(links[1]).toHaveTextContent("The Glass Harbor");
    expect(links[1]).toHaveTextContent("Writing scene 2 of chapter 3");
    expect(links[2]).toHaveTextContent(t("autopilot.host.server"));
  });
});

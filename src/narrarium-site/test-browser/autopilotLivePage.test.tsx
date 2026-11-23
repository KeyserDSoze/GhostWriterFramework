import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  toast: vi.fn(),
  save: vi.fn(async () => true),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { longPlan } from "./helpers/autopilotFixtures";
import { runningStep, seedRun, stubWidth } from "./helpers/autopilotBand";
import { LOCAL_BOOK, makeRuntime, quickName, seedBar, t } from "./helpers/quickCommands";

const SETTINGS = "/app/books/book-1/autopilot/settings";
const LIVE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });

function Where() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.hash}`}</p>;
}

function Page({ path = "/app/books/book-1/autopilot" }: { path?: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} />
        <Route path="/app/books/:bookId/autopilot/settings" element={<p>The configuration</p>} />
      </Routes>
      <Where />
    </MemoryRouter>
  );
}

const bandOf = () => document.querySelector<HTMLElement>("[data-autopilot-band]") as HTMLElement;
const section = (title: string) => screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = { ...makeRuntime(), intervene: vi.fn(async () => undefined), reset: vi.fn(async () => undefined), configure: vi.fn(async () => undefined) };
  mocks.book = LOCAL_BOOK;
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the live page of the autopilot (what is happening)", () => {
  it("has no brief, no settings and no danger zone: they are in the configuration", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    expect(screen.queryByLabelText(t("autopilot.setup.idea"))).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t("autopilot.setup.chapters"))).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("autopilot.setup.save") })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: t("autopilot.danger.title") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("autopilot.actions.reset") })).not.toBeInTheDocument();
  });

  it("keeps what is used while it runs: the band, the history, the plan, Intervene, the rules and where it runs", () => {
    seedRun({ status: "running", running: true, live: { activity: LIVE } });
    render(<Page />);
    expect(bandOf()).not.toBeNull();
    for (const title of [t("autopilot.activity.title"), t("autopilot.plan.title"), t("autopilot.rules.title"), t("autopilot.where.title")]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: t("autopilot.actions.intervene") })).toBeInTheDocument();
  });

  it("shows the permanent rules to read, with the way to change them in the configuration", () => {
    seedRun({ status: "paused", statePatch: { constraints: ["Keep the tone ironic."], directorNotes: ["More doubt."] } });
    render(<Page />);
    const rules = section(t("autopilot.rules.title"));
    expect(within(rules).getByText("Keep the tone ironic.")).toBeInTheDocument();
    expect(within(rules).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(rules).queryByRole("button", { name: /Edit|Remove/ })).not.toBeInTheDocument();
    expect(within(rules).getByRole("link", { name: t("autopilot.live.editRules") })).toHaveAttribute("href", `${SETTINGS}#autopilot-rules`);
  });

  it("has a way to the configuration in its header, next to the director", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    const header = screen.getByRole("heading", { level: 1 }).closest("div")!.parentElement!;
    expect(within(header).getByRole("link", { name: t("nav.autopilotSettings") })).toHaveAttribute("href", SETTINGS);
    expect(within(header).getByRole("link", { name: t("autopilot.actions.director") })).toBeInTheDocument();
  });

  it("invites a book that never started to configure the autopilot, instead of showing the form to start it", () => {
    seedBar({ noState: true });
    render(<Page />);
    const invite = screen.getByRole("link", { name: t("autopilot.live.configure") });
    expect(invite).toHaveAttribute("href", SETTINGS);
    expect(screen.getByRole("heading", { name: t("autopilot.live.inviteTitle") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("autopilot.actions.start") })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t("autopilot.setup.idea"))).not.toBeInTheDocument();
    // Where it runs can be chosen before the first start, as before.
    expect(screen.getByRole("heading", { name: t("autopilot.where.title") })).toBeInTheDocument();
  });

  it("does not invite to configure a book whose autopilot could not be read: it says why instead", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [LOCAL_BOOK], aiIntegrations: [{ id: "ai-1" } as never] } });
    useAutopilotStore.setState({ views: { "book-1": { ...emptyView("book-1"), error: "Your personal server is not reachable right now." } } });
    render(<Page />);
    expect(screen.getByText("Your personal server is not reachable right now.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: t("autopilot.live.configure") })).not.toBeInTheDocument();
  });

  it("sends an old link to the settings of this page to the configuration's overview", async () => {
    seedRun({ status: "completed", phase: "completed", chapters: longPlan(12, 12), statePatch: { finalDone: true } });
    render(<Page path="/app/books/book-1/autopilot#autopilot-setup" />);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`${SETTINGS}#autopilot-overview`));
  });

  it("leads Add chapters, in the band and in the result, to the Scaletta, where the chapters are added", () => {
    seedRun({ status: "completed", phase: "completed", chapters: longPlan(12, 12), message: "The book is complete.", statePatch: { finalDone: true } });
    render(<Page />);
    const inBand = within(bandOf()).getByRole("link", { name: quickName(t("autopilot.actions.addChapters")) });
    expect(inBand).toHaveAttribute("href", "/app/books/book-1/outline");
    const result = document.querySelector<HTMLElement>("[data-autopilot-result]") as HTMLElement;
    expect(within(result).getByRole("link", { name: t("autopilot.result.actions.add") })).toHaveAttribute("href", "/app/books/book-1/outline");
  });

  it("keeps the answer to the question of the director on this page", () => {
    seedRun({ status: "waiting-author", question: { id: "q-1", kind: "director", question: "Keep the ending open?", context: "", options: [], askedAt: "2026-11-21T10:00:00.000Z" } });
    render(<Page />);
    expect(within(bandOf()).getByRole("link", { name: quickName(t("autopilot.quick.run.answer")) })).toHaveAttribute("href", "/app/books/book-1/autopilot#autopilot-question");
  });

  describe("on a screen that is not wide", () => {
    const openTab = async (key: string) => {
      const tab = screen.getByRole("tab", { name: t(key) });
      fireEvent.mouseDown(tab);
      fireEvent.click(tab);
      await waitFor(() => expect(tab).toHaveAttribute("aria-selected", "true"));
      return screen.getByRole("tabpanel");
    };

    it("has the same four tabs, and the Rules tab has the rules and where it runs, without what moved to the configuration", async () => {
      stubWidth(700);
      seedRun({ status: "paused" });
      render(<Page />);
      expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Overview", "Timeline", "Plan", "Rules"]);
      const panel = await openTab("autopilot.tabs.rules");
      expect(within(panel).getByRole("heading", { name: t("autopilot.rules.title") })).toBeInTheDocument();
      expect(within(panel).getByRole("heading", { name: t("autopilot.where.title") })).toBeInTheDocument();
      expect(within(panel).queryByLabelText(t("autopilot.setup.chapters"))).not.toBeInTheDocument();
      expect(within(panel).queryByRole("region", { name: t("autopilot.danger.title") })).not.toBeInTheDocument();
    });
  });
});

describe("the live panel of a book that never started", () => {
  it("leads to the configuration, where the autopilot is started now", () => {
    seedBar({ noState: true, dockOpen: true });
    useAutopilotStore.setState({ dockTab: "book" });
    render(<MemoryRouter initialEntries={["/app/books/book-1"]}><AutopilotDock /></MemoryRouter>);
    expect(screen.getByRole("link", { name: t("autopilot.actions.start") })).toHaveAttribute("href", SETTINGS);
  });

  it("keeps out of the way on the configuration too, and says what happens when it is brought back there, since that page does not", () => {
    seedRun({ status: "running", running: true, live: { activity: LIVE }, dockOpen: true });
    const view = render(<MemoryRouter initialEntries={[SETTINGS]}><AutopilotDock /></MemoryRouter>);
    expect(screen.queryByRole("region", { name: t("autopilot.dockTitle") })).not.toBeInTheDocument();
    view.unmount();
    useAutopilotStore.setState({ pageDockOpen: true, dockTab: "book" });
    render(<MemoryRouter initialEntries={[SETTINGS]}><AutopilotDock /></MemoryRouter>);
    const panel = screen.getByRole("region", { name: t("autopilot.dockTitle") });
    expect(within(panel).getByText(LIVE.title).closest('[role="status"]')).not.toBeNull();
  });
});

void LOCAL_BOOK;

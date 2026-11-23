import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, RouterProvider, createMemoryRouter, useLocation } from "react-router-dom";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn(), save: vi.fn(async () => true), book: null as unknown }));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AssistantLauncher } from "@/components/assistant/AssistantLauncher";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { AutopilotLauncher } from "@/components/autopilot/AutopilotLauncher";
import { FloatingInBar } from "@/components/layout/FloatingInBar";
import { FloatingLayers } from "@/components/layout/FloatingLayers";
import { useBackGestureClose } from "@/components/layout/historyStep";
import { useAssistantStore } from "@/assistant/store";
import { useAutopilotStore } from "@/autopilot/store";
import { useDirtyNavigationGuard } from "@/hooks/useDirtyNavigationGuard";
import { useSaveStore } from "@/store/saveStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { longPlan, planOf } from "./helpers/autopilotFixtures";
import { runningStep, seedRun, stubWidth } from "./helpers/autopilotBand";
import { LOCAL_BOOK, makeRuntime, t } from "./helpers/quickCommands";

// Phase 2 of the mobile work. On the Live page of a phone the floating buttons stood over the tabs and the text, right above the bar of actions: they
// go into that bar. The mini-player covered most of a short phone: there it is a bottom sheet, with the focus kept in it, closed by Escape and by
// the back gesture. A sheet over the whole screen closes with the back gesture too, instead of leaving the page.

/** The screen: a phone (narrow, short, touch) or a computer. The layout asks with `matchMedia`. */
function screenOf(kind: "phone" | "computer") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: kind === "phone" && /max-width|max-height|pointer:\s*coarse/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  useUiStore.setState({ floatingHidden: false });
  useSaveStore.setState({ current: null });
  useAssistantStore.setState({ open: false });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.restoreAllMocks();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", dockFocusBook: null, whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useSaveStore.setState({ current: null });
  await i18n.changeLanguage("en");
});

describe("the floating buttons on a page that has its own bar of actions at the bottom", () => {
  function Page({ withBar }: { withBar: boolean }) {
    return (
      <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
        <main><p>The page</p>{withBar && <div data-autopilot-bottom-bar><button type="button">Pause after this step</button><FloatingInBar /></div>}</main>
        <FloatingLayers><AssistantLauncher /></FloatingLayers>
      </MemoryRouter>
    );
  }

  it("go into the bar: they do not float over the page any more, and the bar has the Copilot and the voice", () => {
    screenOf("phone");
    render(<Page withBar />);
    const copilot = screen.getAllByRole("button", { name: t("assistant.floatingButton") });
    expect(copilot, "one Copilot button, in the bar").toHaveLength(1);
    expect(copilot[0].closest("[data-autopilot-bottom-bar]")).not.toBeNull();
    expect(screen.getByRole("button", { name: t("assistant.liveVoice") }).closest("[data-autopilot-bottom-bar]")).not.toBeNull();
    fireEvent.click(copilot[0]);
    expect(useAssistantStore.getState().open).toBe(true);
  });

  it("are targets a thumb can hit in the bar", () => {
    screenOf("phone");
    render(<Page withBar />);
    expect(screen.getByRole("button", { name: t("assistant.floatingButton") })).toHaveClass("h-11", "w-11");
  });

  it("float again where the page has no bar", () => {
    screenOf("phone");
    const { rerender } = render(<Page withBar />);
    rerender(<Page withBar={false} />);
    const copilot = screen.getByRole("button", { name: t("assistant.floatingButton") });
    expect(copilot.closest("[data-autopilot-bottom-bar]")).toBeNull();
    expect(copilot).toBeVisible();
  });

  it("are not in the bar when the author hid the floating buttons", () => {
    screenOf("phone");
    useUiStore.setState({ floatingHidden: true });
    render(<Page withBar />);
    expect(screen.queryByRole("button", { name: t("assistant.floatingButton") })).toBeNull();
  });
});

describe("the mini-player on a phone", () => {
  const LIVE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });
  const RUNNING = { status: "running", running: true, dockOpen: true, live: { activity: LIVE, characters: 10, preview: "The keeper climbed." } } as const;
  function app() {
    function Probe() {
      const location = useLocation();
      useDirtyNavigationGuard(t("common.unsavedNavigationConfirm"));
      return <p data-testid="where">{location.pathname}</p>;
    }
    const router = createMemoryRouter([{ path: "*", element: <><Probe /><AutopilotLauncher /><AutopilotDock /></> }], { initialEntries: ["/app/books", "/app/books/book-1"], initialIndex: 1 });
    render(<RouterProvider router={router} />);
    return router;
  }
  const sheet = () => screen.queryByRole("dialog", { name: t("autopilot.dockTitle") });

  it("is a bottom sheet: a dialog named as the panel, with the focus in it and a close button a thumb can hit", async () => {
    screenOf("phone");
    seedRun(RUNNING);
    app();
    await flush();
    expect(sheet()).not.toBeNull();
    expect(sheet()?.contains(document.activeElement)).toBe(true);
    expect(sheet()).toHaveClass("bottom-0", "inset-x-0");
    expect(within(sheet() as HTMLElement).getByRole("button", { name: t("autopilot.close") })).toHaveClass("h-11", "w-11");
    expect(screen.queryByRole("region", { name: t("autopilot.dockTitle") })).toBeNull();
  });

  it("closes with Escape, and the focus goes back to the button that opened it", async () => {
    screenOf("phone");
    seedRun({ ...RUNNING, dockOpen: false });
    app();
    const launcher = screen.getByRole("button", { name: t("autopilot.openDock") });
    launcher.focus();
    fireEvent.click(launcher);
    await flush();
    expect(sheet()).not.toBeNull();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await flush();
    expect(sheet()).toBeNull();
    expect(useAutopilotStore.getState().dockOpen).toBe(false);
    expect(document.activeElement).toBe(launcher);
  });

  it("closes with the back gesture, and the page stays where it was", async () => {
    screenOf("phone");
    seedRun({ ...RUNNING, dockOpen: false });
    const router = app();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.openDock") }));
    await flush();
    expect(sheet()).not.toBeNull();
    await act(async () => { await router.navigate(-1); });
    await flush();
    expect(sheet()).toBeNull();
    expect(useAutopilotStore.getState().dockOpen).toBe(false);
    expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1");
    await act(async () => { await router.navigate(-1); });
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/app\/books$/);
  });

  it("stays a floating panel beside the page on a computer", async () => {
    screenOf("computer");
    seedRun(RUNNING);
    app();
    await flush();
    expect(sheet()).toBeNull();
    expect(screen.getByRole("region", { name: t("autopilot.dockTitle") })).toBeInTheDocument();
  });
});

describe("a sheet that covers the screen, and the back gesture", () => {
  function Sheet() {
    const [open, setOpen] = useState(false);
    const location = useLocation();
    useDirtyNavigationGuard(t("common.unsavedNavigationConfirm"));
    useBackGestureClose(open, () => setOpen(false), "test-sheet");
    return (
      <>
        <p data-testid="where">{`${location.pathname}${location.hash}`}</p>
        <button type="button" onClick={() => setOpen(true)}>Open the sheet</button>
        {open && <div role="dialog" aria-label="The sheet"><button type="button" onClick={() => setOpen(false)}>Close</button></div>}
      </>
    );
  }
  function app() {
    const router = createMemoryRouter([{ path: "*", element: <Sheet /> }], { initialEntries: ["/app/books", { pathname: "/app/books/book-1/autopilot", hash: "#autopilot-map" }], initialIndex: 1 });
    render(<RouterProvider router={router} />);
    return router;
  }
  const dialog = () => screen.queryByRole("dialog", { name: "The sheet" });

  it("closes the sheet instead of leaving the page", async () => {
    const router = app();
    fireEvent.click(screen.getByRole("button", { name: "Open the sheet" }));
    await flush();
    await act(async () => { await router.navigate(-1); });
    await flush();
    expect(dialog()).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1/autopilot#autopilot-map");
  });

  it("gives its step back when the sheet is closed by its own button: the next back leaves the page", async () => {
    const router = app();
    fireEvent.click(screen.getByRole("button", { name: "Open the sheet" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await flush();
    await flush();
    expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1/autopilot#autopilot-map");
    await act(async () => { await router.navigate(-1); });
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/app\/books$/);
  });

  it("asks nothing about unsaved changes to open or to close", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    useSaveStore.setState({ current: { dirty: true, save: () => true } });
    const router = app();
    fireEvent.click(screen.getByRole("button", { name: "Open the sheet" }));
    await flush();
    await act(async () => { await router.navigate(-1); });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Open the sheet" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await flush();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("the tab chosen on the Live page of a phone", () => {
  it("belongs to its book: the next book, whose plan waits for the author, opens on the approval of its plan", async () => {
    stubWidth(390);
    const other = { ...LOCAL_BOOK, id: "book-2", name: "The Salt Road" };
    mocks.book = LOCAL_BOOK;
    seedRun({ status: "paused" });
    const router = createMemoryRouter([{ path: "/app/books/:bookId/autopilot", element: <AutopilotPage /> }], { initialEntries: ["/app/books/book-1/autopilot"] });
    render(<RouterProvider router={router} />);
    await flush();
    fireEvent.mouseDown(screen.getByRole("tab", { name: t("autopilot.tabs.rules") }));
    fireEvent.click(screen.getByRole("tab", { name: t("autopilot.tabs.rules") }));
    await flush();
    expect(screen.getByRole("tab", { name: t("autopilot.tabs.rules") })).toHaveAttribute("aria-selected", "true");
    mocks.book = other;
    seedRun({ book: other, status: "paused", statePatch: { plan: { ...planOf(longPlan(6, 0)), awaitingAuthor: true } } });
    await act(async () => { await router.navigate("/app/books/book-2/autopilot"); });
    await flush();
    expect(screen.getByRole("tab", { name: t("autopilot.tabs.plan") })).toHaveAttribute("aria-selected", "true");
  });
});

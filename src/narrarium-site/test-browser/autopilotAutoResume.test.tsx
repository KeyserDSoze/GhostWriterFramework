import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_FEATURE_AUTOPILOT_AUTO_RESUME, type ServerInfo } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: undefined as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  local: null as unknown,
  toast: vi.fn(),
  save: vi.fn(async () => true),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return { ...original, browserOutlineSource: () => original.storeOutlineSource(mocks.local as never) };
});

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotSettingsPage } from "@/pages/AutopilotSettingsPage";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { runningStep, seedRun } from "./helpers/autopilotBand";
import { renderWithScaletta, scalettaFiles } from "./helpers/scaletta";
import { RETRY_SERVER_INFO } from "./helpers/fakeBookServer";
import { LOCAL_BOOK, makeRuntime, t } from "./helpers/quickCommands";

// «Resume after a restart» in the «Retries» card of the configuration: a switch, off unless the author turns it on, shown only for a book that a personal
// server runs when that server announces it, with what it does in one line; saved with the other settings, and alone through the live options while a run
// goes on, as «Retry later» is.

/** A part of the configuration sits in its tab: the tab is shown before anything is looked for in it. */
const choose = (tab: string) => fireEvent.click(screen.getByRole("tab", { name: t(`autopilot.config.tabs.${tab}`) }));
/** The panel of a tab: it is shown by `choose` before it is looked into. */
const panelOf = (tab: string) => {
  choose(tab);
  return document.getElementById(`autopilot-panel-${tab}`) as HTMLElement;
};

const SETTINGS = "/app/books/book-1/autopilot/settings";
const SERVER_BOOK: BookEntry = { ...LOCAL_BOOK, autopilotHost: "server" };
const AUTO_RESUME_INFO = { ...RETRY_SERVER_INFO, serverVersion: "0.1.11", engineVersion: "0.1.11", features: [...(RETRY_SERVER_INFO.features ?? []), SERVER_FEATURE_AUTOPILOT_AUTO_RESUME] } as ServerInfo;
const LIVE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });

function Page() {
  return (
    <MemoryRouter initialEntries={[SETTINGS]}>
      <Routes>
        <Route path="/app/books/:bookId/autopilot/settings" element={<AutopilotSettingsPage />} />
        <Route path="/app/books/:bookId/autopilot" element={<p>The live page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const card = () => within(panelOf("retries"));
const label = () => t("autopilot.config.autoResume.label");
const toggle = () => card().getByRole("switch", { name: label() });
const saveButton = () => screen.getByRole("button", { name: t("autopilot.setup.save") });

/** A book that the personal server runs, the server announcing «Resume after a restart» (or, with `info`, what it announces). */
function onServer(seed: Parameters<typeof seedRun>[0] = {}, info: ServerInfo = AUTO_RESUME_INFO) {
  mocks.book = SERVER_BOOK;
  seedRun({ book: SERVER_BOOK, status: "paused", server: "online", serverInfo: info, ...seed });
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = { ...makeRuntime(), configure: vi.fn(async () => undefined), reset: vi.fn(async () => undefined) };
  mocks.book = LOCAL_BOOK;
  mocks.structure = { title: "The Glass Harbor", language: "en", owner: "local", repo: "book-1", defaultBranch: "main", loadedBranch: "main", rootFiles: [{ path: "book.md" }], firstClassFiles: [], chapters: [{ slug: "001-one", title: "One", paragraphs: [{}] }], ghostwriters: [], readerPersonas: [] };
  mocks.local = new MemoryBookStore({ ...scalettaFiles(), "director.md": "---\nname: Ada\n---\nThe vision.\n" });
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("«Resume after a restart» in the configuration", () => {
  it("is a real switch in the «Retries» card, off by default, named by its label and described by its line, that the keyboard reaches", async () => {
    onServer();
    await renderWithScaletta(<Page />);
    const control = toggle();
    expect(control.tagName).toBe("BUTTON");
    expect(control).toHaveAttribute("type", "button");
    expect(control).not.toBeChecked();
    expect(control).toBeEnabled();
    expect(control).toHaveAccessibleDescription(t("autopilot.config.autoResume.hint"));
    control.focus();
    expect(document.activeElement).toBe(control);
    fireEvent.click(control);
    expect(control).toBeChecked();
    fireEvent.click(control);
    expect(control).not.toBeChecked();
    expect(mocks.runtime.configure).not.toHaveBeenCalled();
    expect(mocks.runtime.updateOptions).not.toHaveBeenCalled();
  });

  it("is not there for a book of this browser, nor for a server that does not announce it", async () => {
    seedRun({ status: "paused" });
    const view = await renderWithScaletta(<Page />);
    expect(card().queryByRole("switch", { name: label() })).toBeNull();
    view.unmount();
    onServer({}, RETRY_SERVER_INFO);
    await renderWithScaletta(<Page />);
    expect(card().getByRole("switch", { name: t("autopilot.config.retryLater.label") })).toBeEnabled();
    expect(card().queryByRole("switch", { name: label() })).toBeNull();
  });

  it("is saved with the other settings while the autopilot is stopped, true when it is turned on and false when it is turned off", async () => {
    onServer();
    const view = await renderWithScaletta(<Page />);
    fireEvent.click(toggle());
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ resumeAfterRestart: true }) }));
    view.unmount();
    mocks.runtime.configure.mockClear();
    onServer({ options: { resumeAfterRestart: true } });
    await renderWithScaletta(<Page />);
    expect(toggle()).toBeChecked();
    fireEvent.click(toggle());
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ resumeAfterRestart: false }) }));
  });

  it("changes while a run goes on through the live options, alone, as «Retry later» does", async () => {
    onServer({ status: "running", running: true, live: { activity: LIVE } });
    await renderWithScaletta(<Page />);
    expect(toggle()).toBeEnabled();
    fireEvent.click(toggle());
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.runtime.updateOptions).toHaveBeenCalledWith("book-1", { resumeAfterRestart: true }));
    expect(mocks.runtime.configure).not.toHaveBeenCalled();
  });

  it("is in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    onServer();
    await renderWithScaletta(<Page />);
    fireEvent.click(screen.getByRole("tab", { name: "Nuovi tentativi" }));
    const control = screen.getByRole("switch", { name: "Riprendi da solo dopo un riavvio del server" });
    expect(control).toHaveAccessibleDescription(t("autopilot.config.autoResume.hint"));
    expect(t("autopilot.config.autoResume.hint")).toMatch(/tre volte al giorno/);
  });
});

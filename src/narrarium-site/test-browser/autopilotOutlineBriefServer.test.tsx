import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_FEATURE_AUTOPILOT_OUTLINE_BRIEF, type ServerInfo } from "narrarium-engine";
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
import { OLD_SERVER_INFO, RETRY_SERVER_INFO } from "./helpers/fakeBookServer";
import { OUTLINE_BRIEF_NOTICE_ID } from "@/autopilot/outlineBrief";
import { LOCAL_BOOK, makeRuntime, t } from "./helpers/quickCommands";

// «Resume after a restart» in the «Retries» card of the configuration: a switch, off unless the author turns it on, shown only for a book that a personal
// server runs when that server announces it, with what it does in one line; saved with the other settings, and alone through the live options while a run
// goes on, as «Retry later» is.

// A personal server that predates the length of the book from its Scaletta (`autopilot-outline-brief`) plans twelve chapters and ignores the outline:
// the configuration says so in an alert, and Start, Resume and Save are disabled with that reason. A server that announces it, and a book that this
// browser keeps, are unaffected.

const SETTINGS = "/app/books/book-1/autopilot/settings";
const SERVER_BOOK: BookEntry = { ...LOCAL_BOOK, autopilotHost: "server" };
const CURRENT_INFO = { ...RETRY_SERVER_INFO, features: [...(RETRY_SERVER_INFO.features ?? []), SERVER_FEATURE_AUTOPILOT_OUTLINE_BRIEF] } as ServerInfo;
const alertText = () => t("autopilot.errors.outlineBriefUnsupported", { version: "0.1.13" });

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

const resumeButton = () => screen.getByRole("button", { name: t("autopilot.actions.resume") });
const saveButton = () => screen.getByRole("button", { name: t("autopilot.setup.save") });

/** A book that the personal server runs, paused, with what the server announces. */
function onServer(info: ServerInfo) {
  mocks.book = SERVER_BOOK;
  seedRun({ book: SERVER_BOOK, status: "paused", server: "online", serverInfo: info });
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
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: undefined } as never });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("a personal server older than the length of the book from its Scaletta", () => {
  it("shows the alert in English, and disables Resume and Save with that reason, described by the alert", async () => {
    onServer(OLD_SERVER_INFO);
    await renderWithScaletta(<Page />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(alertText());
    expect(alert.id).toBe(OUTLINE_BRIEF_NOTICE_ID);
    expect(resumeButton()).toBeDisabled();
    expect(resumeButton()).toHaveAttribute("aria-describedby", OUTLINE_BRIEF_NOTICE_ID);
    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAttribute("aria-describedby", OUTLINE_BRIEF_NOTICE_ID);
    expect(mocks.runtime.start).not.toHaveBeenCalled();
    expect(mocks.runtime.configure).not.toHaveBeenCalled();
  });

  it("says the same thing in Italian", async () => {
    await i18n.changeLanguage("it");
    onServer(OLD_SERVER_INFO);
    await renderWithScaletta(<Page />);
    expect(screen.getByRole("alert")).toHaveTextContent(t("autopilot.errors.outlineBriefUnsupported", { version: "0.1.13" }));
    expect(alertText()).toMatch(/Sinossi/);
    expect(alertText()).toMatch(/Impostazioni → Server personale/);
    expect(resumeButton()).toBeDisabled();
  });

  it("is unaffected for a server that announces it: no alert, and Resume and Save are as they were", async () => {
    onServer(CURRENT_INFO);
    await renderWithScaletta(<Page />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(resumeButton()).toBeEnabled();
    expect(resumeButton()).not.toHaveAttribute("aria-describedby", OUTLINE_BRIEF_NOTICE_ID);
  });

  it("disables Start for a book that has not started yet, with the same reason", async () => {
    mocks.book = SERVER_BOOK;
    seedRun({ book: SERVER_BOOK, noState: true, server: "online", serverInfo: OLD_SERVER_INFO });
    await renderWithScaletta(<Page />);
    const start = screen.getByRole("button", { name: t("autopilot.actions.start") });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute("aria-describedby", OUTLINE_BRIEF_NOTICE_ID);
    expect(mocks.runtime.start).not.toHaveBeenCalled();
  });

  it("is unaffected for a book that this browser keeps", async () => {
    seedRun({ status: "paused" });
    await renderWithScaletta(<Page />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(resumeButton()).toBeEnabled();
  });
});

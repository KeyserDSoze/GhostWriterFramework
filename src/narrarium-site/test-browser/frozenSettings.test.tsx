import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_FEATURE_AUTOPILOT_FROZEN, type ServerInfo } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  local: null as unknown,
  toast: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: { title: "The Glass Harbor", language: "en", rootFiles: [], firstClassFiles: [], chapters: [], ghostwriters: [], readerPersonas: [] }, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => true) }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/autopilot/browserStore")>()), createBrowserBookStore: () => mocks.local }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotSettingsPage } from "@/pages/AutopilotSettingsPage";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { runningStep, seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, makeRuntime } from "./helpers/quickCommands";

type Language = "en" | "it";
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const ROOT = `/app/books/${LOCAL_BOOK.id}`;
const MODES = ["ask", "auto", "notify"] as const;

function Page() {
  return (
    <MemoryRouter initialEntries={[`${ROOT}/autopilot/settings`]}>
      <Routes><Route path="/app/books/:bookId/autopilot/settings" element={<AutopilotSettingsPage />} /></Routes>
    </MemoryRouter>
  );
}

const group = () => screen.getByRole("group", { name: t("autopilot.config.frozenEdits.title") });
const choice = (mode: string) => within(group()).getByRole("radio", { name: t(`autopilot.config.frozenEdits.${mode}`) });

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.book = LOCAL_BOOK;
  mocks.local = new MemoryBookStore({});
  mocks.runtime = { ...makeRuntime(), configure: vi.fn(async () => undefined), reset: vi.fn(async () => undefined) };
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe.each<Language>(["en", "it"])("what the autopilot does when the author changes a frozen chapter (%s)", (language) => {
  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage(language); });
  });

  it("is a choice of three in Review, asking every time unless the author chose otherwise, each saying what it does", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    const review = screen.getByRole("region", { name: t("autopilot.config.sections.review") });
    expect(within(review).getByRole("group", { name: t("autopilot.config.frozenEdits.title") })).toBeInTheDocument();
    expect(within(group()).getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual([...MODES]);
    expect(choice("ask")).toBeChecked();
    for (const mode of MODES) expect(choice(mode)).toHaveAccessibleDescription(t(`autopilot.config.frozenEdits.${mode}Help`));
    expect(group()).toHaveAccessibleDescription(t("autopilot.config.frozenEdits.hint"));
    expect(t("autopilot.config.frozenEdits.ask")).toBe(language === "en" ? "Ask me every time" : "Chiedimi ogni volta");
    expect(t("autopilot.config.frozenEdits.auto")).toBe(language === "en" ? "Review automatically" : "Rivedi in automatico");
    expect(t("autopilot.config.frozenEdits.notify")).toBe(language === "en" ? "Only report it" : "Solo segnala");
  });
});

describe("the choice about frozen chapters", () => {
  it("shows the choice the book has", () => {
    seedRun({ status: "paused", options: { frozenEdits: "notify" } });
    render(<Page />);
    expect(choice("notify")).toBeChecked();
  });

  it("is saved with the other settings while the autopilot is stopped", async () => {
    seedRun({ status: "paused" });
    render(<Page />);
    fireEvent.click(choice("notify"));
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.configure).toHaveBeenCalledWith(LOCAL_BOOK.id, { brief: expect.anything(), options: expect.objectContaining({ frozenEdits: "notify" }) });
  });

  it("changes while the autopilot runs, with updateOptions, and nothing else is sent", async () => {
    seedRun({ status: "running", running: true, live: { activity: runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 }) } });
    render(<Page />);
    expect(choice("auto")).toBeEnabled();
    fireEvent.click(choice("auto"));
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(mocks.runtime.updateOptions).toHaveBeenCalledWith(LOCAL_BOOK.id, { frozenEdits: "auto" }));
    expect(mocks.runtime.configure).not.toHaveBeenCalled();
  });

  it("cannot be changed for a book on a personal server that predates the frozen chapters, and says to update it", () => {
    const book = { ...LOCAL_BOOK, autopilotHost: "server" as const };
    mocks.book = book;
    seedRun({ book, status: "paused", server: "online" });
    render(<Page />);
    for (const mode of MODES) expect(choice(mode)).toBeDisabled();
    expect(group()).toHaveAccessibleDescription(t("autopilot.config.frozenEdits.oldServer", { version: "0.1.9" }));
  });

  it("can be changed on a personal server that has them", () => {
    const book = { ...LOCAL_BOOK, autopilotHost: "server" as const };
    mocks.book = book;
    seedRun({ book, status: "paused", server: "online" });
    useAutopilotStore.setState((store) => ({ server: { ...store.server, info: { ...store.server.info!, features: [...(store.server.info!.features ?? []), SERVER_FEATURE_AUTOPILOT_FROZEN] } as ServerInfo } }));
    render(<Page />);
    for (const mode of MODES) expect(choice(mode)).toBeEnabled();
  });
});

describe("the note of a question on the Configuration", () => {
  it("names a question about a change for what it is", () => {
    seedRun({ status: "waiting-author", question: { id: "frozen-1-a", kind: "frozen-change", question: "You changed chapter 1.", context: "", options: [], askedAt: "2026-11-22T10:00:00.000Z" } });
    render(<Page />);
    expect(screen.getByText(t("autopilot.question.kinds.frozen-change"))).toBeInTheDocument();
  });
});

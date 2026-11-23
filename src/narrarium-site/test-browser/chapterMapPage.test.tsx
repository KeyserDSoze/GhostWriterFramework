import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({ book: null as unknown, runtime: null as unknown, store: null as unknown }));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: { chapters: [{ slug: "002-chapter-2", title: "Title 2", paragraphs: [{}] }], characters: [], ghostwriters: [] }, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => true) }) }));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.store,
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { judgedPlan, longPlan, planOf } from "./helpers/autopilotFixtures";
import { seedRun, stubWidth } from "./helpers/autopilotBand";
import { LOCAL_BOOK, makeRuntime, t } from "./helpers/quickCommands";

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

const mapCard = () => document.getElementById("autopilot-map");

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  mocks.book = LOCAL_BOOK;
  mocks.runtime = { ...makeRuntime(), frozenStatus: vi.fn(async () => ({ mode: "ask", changes: [], pending: [], warnings: [] })) };
  mocks.store = new MemoryBookStore({});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("the map on the live page", () => {
  it("is in the column beside the history, before the plan, on a wide page", () => {
    seedRun({ status: "paused" });
    render(<Page />);
    const side = document.querySelector("[data-autopilot-side]") as HTMLElement;
    expect(side.contains(mapCard())).toBe(true);
    const plan = within(side).getByRole("heading", { name: t("autopilot.plan.title") });
    expect(mapCard()!.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(mapCard()!).getByRole("grid")).toBeInTheDocument();
  });

  it("is in the Plan tab on a phone, and opens the panel of a chapter there", async () => {
    stubWidth(390);
    seedRun({ status: "paused" });
    render(<Page />);
    const tab = screen.getByRole("tab", { name: t("autopilot.tabs.plan") });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(tab).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("tabpanel").contains(mapCard())).toBe(true);
    fireEvent.click(within(mapCard()!).getAllByRole("rowheader")[1]);
    const panel = screen.getByRole("dialog", { name: t("autopilot.chapterPanel.title", { number: 2, title: "Title 2" }) });
    expect(within(panel).getByRole("link", { name: t("autopilot.chapterPanel.open") })).toHaveAttribute("href", "/app/books/book-1/chapters/002-chapter-2");
  });

  it("is on the page of a finished book, under its result, with the votes of every chapter", () => {
    seedRun({ status: "completed", phase: "completed", chapters: judgedPlan(12), statePatch: { finalDone: true } });
    render(<Page />);
    const result = document.querySelector("[data-autopilot-result]") as HTMLElement;
    expect(result.compareDocumentPosition(mapCard()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(mapCard()!).getAllByRole("row")).toHaveLength(12);
    expect(within(mapCard()!).getAllByRole("rowheader")[3]).toHaveTextContent(t("autopilot.map.score", { score: "6" }));
  });

  it("gives way to the approval while the plan waits for the author, and is not there before the plan", () => {
    const planned = longPlan(12, 0, () => "planned");
    seedRun({ status: "paused", phase: "plan", chapters: planned, statePatch: { plan: { ...planOf(planned), awaitingAuthor: true } } });
    const view = render(<Page />);
    expect(mapCard()).toBeNull();
    view.unmount();
    seedRun({ status: "paused", phase: "concept", chapters: [], statePatch: { plan: null } });
    render(<Page />);
    expect(mapCard()).toBeNull();
  });
});

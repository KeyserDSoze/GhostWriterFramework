import { act, cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
import { AutopilotFeed } from "@/components/autopilot/AutopilotFeed";
import { AutopilotTimeline } from "@/components/autopilot/AutopilotTimeline";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { stubWidth, seedRun } from "./helpers/autopilotBand";
import { chapterFlow, resetIds, resetSeq } from "./helpers/autopilotTimeline";
import { LOCAL_BOOK, makeRuntime, seedBar, t } from "./helpers/quickCommands";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const GONE = /No activity yet|Nothing has happened yet|Nessuna attività|Non è ancora successo nulla/i;

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  resetIds();
  resetSeq();
  sessionStorage.clear();
  await i18n.changeLanguage("en");
  mocks.runtime = { ...makeRuntime(), reset: vi.fn(async () => undefined), configure: vi.fn(async () => undefined) };
  mocks.book = LOCAL_BOOK;
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

function LivePage() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes>
        <Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} />
        <Route path="/app/books/:bookId/autopilot/settings" element={<p>The configuration</p>} />
      </Routes>
    </MemoryRouter>
  );
}

describe.each(LANGUAGES)("a book that has never run has no empty cards (%s)", (language) => {
  beforeEach(async () => {
    await i18n.changeLanguage(language);
  });

  it("has, in place of the card of the history, one line that says what happens once it starts", () => {
    const { container } = render(<MemoryRouter><AutopilotTimeline bookId="book-1" activities={[]} /></MemoryRouter>);
    expect(container.querySelector("[data-autopilot-timeline]")).toBeNull();
    expect(screen.queryByRole("heading", { name: t("autopilot.activity.title") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("autopilot.timeline.hide") })).not.toBeInTheDocument();
    expect(screen.queryByText(GONE)).not.toBeInTheDocument();
    const line = screen.getByText(t("autopilot.activity.idle"));
    expect(line.tagName).toBe("P");
    expect(line.className).not.toMatch(/border|rounded|shadow|bg-card/);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("has the card as it always had it once there is something to list", () => {
    const flow = chapterFlow(1, { from: 0, rounds: 1 });
    const { container } = render(<MemoryRouter><AutopilotTimeline bookId="book-1" activities={flow.activities} /></MemoryRouter>);
    expect(container.querySelector("[data-autopilot-timeline]")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: t("autopilot.activity.title") })).toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.activity.idle"))).not.toBeInTheDocument();
  });

  it("has the card, and says that it is loading, while the log is read", () => {
    render(<MemoryRouter><AutopilotTimeline bookId="book-1" loading activities={[]} /></MemoryRouter>);
    expect(screen.getByRole("heading", { level: 2, name: t("autopilot.activity.title") })).toBeInTheDocument();
    expect(screen.getByText(t("common.loading"))).toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.activity.idle"))).not.toBeInTheDocument();
  });

  it("has the feed of the events as one line of text, with no frame, when nothing has happened in any book", () => {
    act(() => useAutopilotStore.setState({ feed: [], live: {} }));
    const { container } = render(<AutopilotFeed showBook />);
    const line = screen.getByText(t("autopilot.feedEmpty"));
    expect(line.tagName).toBe("P");
    expect(line.className).not.toMatch(/border|rounded|shadow|bg-card/);
    expect(container.querySelector(".border-dashed")).toBeNull();
    expect(screen.queryByText(GONE)).not.toBeInTheDocument();
    // It says what will happen, not what has not: nothing is wrong, nothing is missing.
    expect(t("autopilot.feedEmpty")).toMatch(language === "en" ? /\bstarts?\b/i : /\bpart(e|ono|ire)\b|\bavvi/i);
  });

  it("has the live panel of a book that never started with that line, and no frame around it", () => {
    seedBar({ noState: true, dockOpen: true });
    useAutopilotStore.setState({ dockTab: "live" });
    const { container } = render(<MemoryRouter initialEntries={["/app/books"]}><AutopilotDock /></MemoryRouter>);
    const panel = screen.getByRole("region", { name: t("autopilot.dockTitle") });
    expect(within(panel).getByText(t("autopilot.feedEmpty"))).toBeInTheDocument();
    expect(container.querySelector(".border-dashed")).toBeNull();
    expect(within(panel).queryByText(GONE)).not.toBeInTheDocument();
  });

  it("has the live page of a book that was saved and never started with the band, the plan and where it runs, and not the card of the history", () => {
    stubWidth(1280);
    seedBar({ status: "idle" });
    const { container } = render(<LivePage />);
    expect(container.querySelector("[data-autopilot-band]")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: t("autopilot.activity.title") })).not.toBeInTheDocument();
    expect(screen.getByText(t("autopilot.activity.idle"))).toBeInTheDocument();
    expect(screen.queryByText(GONE)).not.toBeInTheDocument();
  });

  it("has the card back as soon as the book has run a step", () => {
    stubWidth(1280);
    const flow = chapterFlow(1, { from: 0, rounds: 1 });
    seedRun({ status: "paused", activities: flow.activities });
    render(<LivePage />);
    expect(screen.getByRole("heading", { name: t("autopilot.activity.title") })).toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.activity.idle"))).not.toBeInTheDocument();
  });
});

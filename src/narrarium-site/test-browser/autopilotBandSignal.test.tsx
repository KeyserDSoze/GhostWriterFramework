import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ book: null as unknown, runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { freezeClock, seedRun, stubWidth } from "./helpers/autopilotBand";
import { LOCAL_BOOK, T0, makeRuntime, quickName, t } from "./helpers/quickCommands";

/**
 * Kept apart from the rest of the band: the age of a signal is read from the clock and from the last event the store heard for the book,
 * which the store keeps between tests. Nothing here sends an event, so nothing here is older than it says.
 */
const SERVER_BOOK: BookEntry = { ...LOCAL_BOOK, autopilotHost: "server" };

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

const bandOf = () => document.querySelector<HTMLElement>("[data-autopilot-band]") as HTMLElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  mocks.book = LOCAL_BOOK;
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("who runs the book, and when they were last heard of", () => {
  it("tells how long ago a book that runs on the server was last heard of", () => {
    freezeClock();
    mocks.book = SERVER_BOOK;
    seedRun({ book: SERVER_BOOK, status: "running", running: true, server: "online", runner: { host: "server", label: "Home server", hostId: "server-1", runId: "run-1", startedAt: T0, heartbeatAt: "2026-11-21T10:01:14.000Z" } });
    render(<Page />);
    expect(within(bandOf()).getByText(t("autopilot.control.lastSignal", { age: "12 seconds ago" }))).toBeInTheDocument();
  });

  it("says them at the top of the overview on a phone, where the compact band has no room, and not in the band", () => {
    stubWidth(390);
    freezeClock();
    mocks.book = SERVER_BOOK;
    seedRun({ book: SERVER_BOOK, status: "running", running: true, server: "online", runner: { host: "server", label: "Home server", hostId: "server-1", runId: "run-1", startedAt: T0, heartbeatAt: "2026-11-21T10:01:14.000Z" } });
    render(<Page />);
    const overview = screen.getByRole("tabpanel");
    expect(within(overview).getByText(t("autopilot.host.server"))).toBeInTheDocument();
    expect(within(overview).getByText(t("autopilot.control.lastSignal", { age: "12 seconds ago" }))).toBeInTheDocument();
    expect(within(bandOf()).queryByText(/Last signal/)).not.toBeInTheDocument();
  });

  it("does not say it for a book that runs in this browser: there is no signal to wait for", () => {
    freezeClock();
    seedRun({ status: "running", running: true, runner: { host: "browser", label: "This browser", hostId: "here", runId: "run-1", startedAt: T0, heartbeatAt: "2026-11-21T10:01:14.000Z" } });
    render(<Page />);
    expect(within(bandOf()).queryByText(/Last signal/)).not.toBeInTheDocument();
  });

  it("does not claim it is in charge when another device runs the book: it says who runs it, and when it was last heard of, once", () => {
    freezeClock();
    seedRun({ status: "running", running: false, runner: { host: "browser", label: "Browser · Android", hostId: "other", runId: "run-1", startedAt: T0, heartbeatAt: "2026-11-21T10:00:26.000Z" } });
    render(<Page />);
    const band = bandOf();
    expect(within(band).getAllByText("Browser · Android", { exact: false }).length).toBeGreaterThan(0);
    expect(within(band).queryByText(t("autopilot.host.browser"))).not.toBeInTheDocument();
    expect(within(band).getAllByText(t("autopilot.control.lastSignal", { age: "1 minute ago" }), { exact: false })).toHaveLength(1);
    expect(within(band).getByRole("button", { name: quickName(t("autopilot.actions.pause")) })).toBeDisabled();
  });
});

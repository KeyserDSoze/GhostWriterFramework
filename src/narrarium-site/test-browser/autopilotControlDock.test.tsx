import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutopilotState, type AutopilotSnapshot, type AutopilotState } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  toast: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn() }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { quickName } from "./helpers/quickCommands";

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const SERVER_BOOK: BookEntry = { ...BOOK, autopilotHost: "server" };
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

function runnerOf(host: "browser" | "server", label: string, heartbeatAt = minutesAgo(4)) {
  return { host, label, hostId: `${host}-other`, runId: "run-1", startedAt: minutesAgo(30), heartbeatAt };
}

function seed(options: { book?: BookEntry; status?: AutopilotState["status"]; runner?: AutopilotState["runner"]; running?: boolean; busyInAnotherTab?: boolean; operation?: { kind: string; since: string } | null }) {
  const book = options.book ?? BOOK;
  mocks.book = book;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], aiIntegrations: [{ id: "ai-1" } as never] } });
  const state: AutopilotState = { ...createAutopilotState(new Date()), status: options.status ?? "running", phase: "write", runner: options.runner ?? null, updatedAt: new Date().toISOString() };
  const snapshot: AutopilotSnapshot = { bookId: book.id, state, activities: [], live: null, running: options.running ?? false, host: null };
  useAutopilotStore.setState({
    dockOpen: true,
    dockTab: "book",
    views: { [book.id]: { ...emptyView(book.id), snapshot, busyInAnotherTab: options.busyInAnotherTab ?? false, operation: (options.operation ?? null) as never } },
    summaries: {},
    live: {},
    feed: [],
  });
}

// The live panel hides itself on the pages of the autopilot (they show everything it would): its commands are checked on the page of the book.
function Dock() {
  return <MemoryRouter initialEntries={["/app/books/book-1"]}><AutopilotDock /></MemoryRouter>;
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

// The commands of the bar say which book they command and from which bar: the panel and the page do not repeat a name.
const named = (key: string, variant: "page" | "dock") => quickName(t(key), variant);
const pause = (variant: "page" | "dock" = "dock") => screen.getByRole("button", { name: named("autopilot.actions.pause", variant) }) as HTMLButtonElement;
const stop = (variant: "page" | "dock" = "dock") => screen.getByRole("button", { name: named("autopilot.actions.stop", variant) }) as HTMLButtonElement;
const takeControl = (variant: "page" | "dock" = "dock") => screen.queryByRole("button", { name: named("autopilot.control.takeOver", variant) });
const operationNotice = (text: string) => screen.getByText(text).closest('[role="status"]');

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.runtime = {
    refresh: vi.fn(async () => null),
    pause: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    describeError: vi.fn((error: unknown) => String(error)),
  };
  mocks.toast.mockReset();
});

afterEach(() => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("the dock while the autopilot runs", () => {
  it("pauses and stops a run of this tab", async () => {
    seed({ running: true, runner: runnerOf("browser", "This browser") });
    render(<Dock />);
    expect(pause()).toBeEnabled();
    expect(stop()).toBeEnabled();
    expect(screen.queryByText(t("autopilot.control.takeOver"))).not.toBeInTheDocument();

    fireEvent.click(pause());
    await waitFor(() => expect(mocks.runtime.pause).toHaveBeenCalledWith("book-1", "after-step"));
    fireEvent.click(stop());
    await waitFor(() => expect(mocks.runtime.pause).toHaveBeenCalledWith("book-1", "now"));
  });

  it("pauses a run that belongs to another tab of this browser: the command is relayed to it", async () => {
    seed({ busyInAnotherTab: true, runner: runnerOf("browser", "This browser") });
    render(<Dock />);
    expect(pause()).toBeEnabled();
    expect(stop()).toBeEnabled();
    expect(takeControl()).not.toBeInTheDocument();
    fireEvent.click(pause());
    await waitFor(() => expect(mocks.runtime.pause).toHaveBeenCalledWith("book-1", "after-step"));
  });

  it("pauses a run on the server of a book that the server hosts", async () => {
    seed({ book: SERVER_BOOK, running: true, runner: runnerOf("server", "Home server") });
    render(<Dock />);
    expect(pause()).toBeEnabled();
    expect(stop()).toBeEnabled();
    expect(takeControl()).not.toBeInTheDocument();
  });

  it("cannot pause a run of another device: both buttons are disabled and the reason is on the screen, tied to them", () => {
    seed({ runner: runnerOf("browser", "Browser · Android") });
    render(<Dock />);

    expect(pause()).toBeDisabled();
    expect(stop()).toBeDisabled();
    const why = screen.getByText(t("autopilot.remoteRunner", { label: "Browser · Android" }), { exact: false });
    expect(why).toBeVisible();
    for (const button of [pause(), stop()]) {
      const describedBy = button.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)).toContainElement(why);
    }
    // It says when the other run was last heard of.
    expect(screen.getByText(t("autopilot.control.lastSignal", { age: "4 minutes ago" }), { exact: false })).toBeInTheDocument();
  });

  it("cannot pause a run of the server either when this book is hosted in the browser", () => {
    seed({ runner: runnerOf("server", "Home server") });
    render(<Dock />);
    expect(pause()).toBeDisabled();
    expect(stop()).toBeDisabled();
    expect(screen.getByText(t("autopilot.remoteRunner", { label: "Home server" }), { exact: false })).toBeVisible();
    expect(screen.getByText(t("autopilot.control.pauseElsewhere"), { exact: false })).toBeVisible();
  });

  it("explains itself even when the stored state does not say who runs", () => {
    seed({ runner: null });
    render(<Dock />);
    expect(pause()).toBeDisabled();
    expect(screen.getByText(t("autopilot.control.runningElsewhere"), { exact: false })).toBeVisible();
    expect(takeControl()).toBeInTheDocument();
  });

  it("offers to take control of a run registered elsewhere, and asks before doing it", async () => {
    seed({ runner: runnerOf("browser", "Browser · Android") });
    render(<Dock />);
    fireEvent.click(takeControl()!);

    const dialog = await screen.findByRole("dialog", { name: t("autopilot.control.takeOverTitle") });
    expect(within(dialog).getByText(t("autopilot.control.takeOverEffect"), { exact: false })).toBeInTheDocument();
    expect(within(dialog).getByText(t("autopilot.control.lastSignal", { age: "4 minutes ago" }), { exact: false })).toBeInTheDocument();
    expect(mocks.runtime.start).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: t("common.cancel") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.runtime.start).not.toHaveBeenCalled();

    fireEvent.click(takeControl()!);
    fireEvent.click(await screen.findByRole("button", { name: t("autopilot.control.takeOverConfirm") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { force: true }));
  });

  it("keeps Resume out of the way, and Pause available, while another operation holds the book", () => {
    seed({ running: true, runner: runnerOf("browser", "This browser"), operation: { kind: "sync", since: new Date().toISOString() } });
    render(<Dock />);
    expect(pause()).toBeEnabled();
    expect(operationNotice(t("autopilot.operation.sync"))).toHaveTextContent(t("autopilot.operation.sync"));
  });

  it("disables Resume and says what is going on while the book is being moved", () => {
    seed({ status: "paused", runner: null, operation: { kind: "moveToServer", since: new Date().toISOString() } });
    render(<Dock />);
    expect(screen.getByRole("button", { name: named("autopilot.actions.resume", "dock") })).toBeDisabled();
    expect(operationNotice(t("autopilot.operation.moveToServer"))).toHaveTextContent(t("autopilot.operation.moveToServer"));
  });
});

describe("the autopilot page while another device runs the book", () => {
  it("disables Pause and Stop with the reason, and offers to take control", () => {
    seed({ runner: runnerOf("browser", "Browser · Android") });
    render(<Page />);
    expect(pause("page")).toBeDisabled();
    expect(stop("page")).toBeDisabled();
    expect(screen.getAllByText(t("autopilot.remoteRunner", { label: "Browser · Android" }), { exact: false }).length).toBeGreaterThan(0);
    expect(takeControl("page")).toBeInTheDocument();
    expect(pause("page").getAttribute("aria-describedby")).toBeTruthy();
  });

  it("starts the run here, forcing it, once the author confirms", async () => {
    seed({ runner: runnerOf("server", "Home server") });
    render(<Page />);
    fireEvent.click(takeControl("page")!);
    const dialog = await screen.findByRole("dialog", { name: t("autopilot.control.takeOverTitle") });
    expect(within(dialog).getByText(t("autopilot.control.takeOverBody", { label: "Home server" }), { exact: false })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: t("autopilot.control.takeOverConfirm") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { force: true }));
  });

  it("has no take-over button for a run of its own, or when nothing runs", () => {
    seed({ running: true, runner: runnerOf("browser", "This browser") });
    const view = render(<Page />);
    expect(takeControl("page")).not.toBeInTheDocument();
    view.unmount();

    seed({ status: "paused", runner: null });
    render(<Page />);
    expect(takeControl("page")).not.toBeInTheDocument();
  });

  it("is told about the age of the signal in the user's language", async () => {
    await i18n.changeLanguage("it");
    try {
      seed({ runner: runnerOf("browser", "Browser · Android") });
      render(<Page />);
      expect(screen.getAllByText(i18n.t("autopilot.control.lastSignal", { age: "4 minuti fa" }), { exact: false }).length).toBeGreaterThan(0);
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});


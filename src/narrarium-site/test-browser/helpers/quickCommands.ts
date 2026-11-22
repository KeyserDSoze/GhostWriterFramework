import { fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";
import { createAutopilotState, summarizeAutopilotState, type AutopilotLimitsSummary, type AutopilotPausePending, type AutopilotPublishMode, type AutopilotState, type AutopilotStateSummary, type AutopilotStatus, type DirectorQuestion, type ServerInfo } from "narrarium-engine";
import i18n from "@/i18n";
import type { HandoverPlan } from "@/autopilot/handover";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { OLD_SERVER_INFO, PIN, SERVER_INFO } from "./fakeBookServer";

export const T0 = "2026-11-21T10:00:00.000Z";
export const LOCAL_BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
export const GITHUB_BOOK: BookEntry = { ...LOCAL_BOOK, storageMode: "github", owner: "acme", repo: "glass-harbor" };
export const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };

export const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

/** The accessible name of a control of the bar: what it says, and which bar and which book it commands. */
export function quickName(label: string, variant: "page" | "dock" = "page", book: BookEntry = LOCAL_BOOK): string {
  const context = variant === "dock" ? t("autopilot.quick.contextDock", { book: book.name, panel: t("autopilot.dockTitle") }) : book.name;
  return t("autopilot.quick.named", { label, context });
}

export const quickGroupName = (variant: "page" | "dock" = "page", book: BookEntry = LOCAL_BOOK) =>
  t("autopilot.quick.groupLabel", { context: variant === "dock" ? t("autopilot.quick.contextDock", { book: book.name, panel: t("autopilot.dockTitle") }) : book.name });

export interface BarSeed {
  book?: BookEntry;
  /** There is no autopilot state yet (a book that never started). */
  noState?: boolean;
  status?: AutopilotStatus;
  /** This client runs it (its own session, or the server it commands). */
  running?: boolean;
  /** It runs in another tab of this browser. */
  busyInAnotherTab?: boolean;
  /** The runner recorded in the state: a run of another device has one, and this client has no session for it. */
  runner?: AutopilotState["runner"];
  statePatch?: Partial<AutopilotState>;
  /** What only a live session says: the pause that waits, the limits of the run, where the book is published. */
  pausePending?: AutopilotPausePending | null;
  limits?: AutopilotLimitsSummary | null;
  publish?: AutopilotPublishMode;
  question?: DirectorQuestion | null;
  /** The personal server: none connected, verified (`online`), or unreachable; `old` is a server that predates the quick controls; `connecting` has not said what it can do yet. */
  server?: "none" | "online" | "old" | "offline" | "connecting";
  /** The author has a GitHub token for the book. */
  token?: boolean;
  operation?: { kind: string; since: string } | null;
  handover?: HandoverPlan | null;
  /** What the server says it holds of the book. */
  serverHoldsToken?: boolean;
  dockOpen?: boolean;
}

export function seedBar(seed: BarSeed = {}): { book: BookEntry; state: AutopilotState | null; summary: AutopilotStateSummary | null } {
  const book = seed.book ?? LOCAL_BOOK;
  const serverInfo: ServerInfo | null = seed.server === "old" ? OLD_SERVER_INFO : seed.server === "none" || seed.server === undefined ? null : SERVER_INFO;
  const connected = seed.server !== "none";
  useSettingsStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      books: [book],
      aiIntegrations: [{ id: "ai-1" } as never],
      defaultGitHubToken: seed.token === false ? "" : "ghp_token",
      personalServer: connected ? CONNECTION : undefined,
    },
  });
  const status = seed.status ?? "paused";
  const state: AutopilotState | null = seed.noState ? null : { ...createAutopilotState(new Date(T0)), status, phase: "write", runner: seed.runner ?? null, updatedAt: T0, ...seed.statePatch };
  const summary: AutopilotStateSummary | null = state
    ? {
        ...summarizeAutopilotState(state),
        ...(seed.question !== undefined ? { question: seed.question } : {}),
        ...(seed.pausePending !== undefined ? { pausePending: seed.pausePending } : {}),
        ...(seed.limits !== undefined ? { limits: seed.limits } : {}),
        ...(seed.publish !== undefined ? { publish: seed.publish } : {}),
      }
    : null;
  const serverBook = { bookId: book.id, title: book.name, storage: { kind: "local" as const }, hasGithubToken: seed.serverHoldsToken ?? false, ready: true, revision: "r1", autopilot: null, running: false, lastSync: null };
  useAutopilotStore.setState({
    dockOpen: seed.dockOpen ?? false,
    dockTab: "book",
    views: {
      [book.id]: {
        ...emptyView(book.id),
        snapshot: state ? { bookId: book.id, state, summary, activities: [], live: null, running: seed.running ?? false, host: null } : { bookId: book.id, state: null, activities: [], live: null, running: false, host: null },
        busyInAnotherTab: seed.busyInAnotherTab ?? false,
        operation: (seed.operation ?? null) as never,
        handover: seed.handover ?? null,
        server: seed.serverHoldsToken === undefined ? null : serverBook,
      },
    },
    summaries: summary ? { [book.id]: summary } : {},
    live: {},
    feed: [],
    server: { status: seed.server === "offline" ? "offline" : seed.server === "connecting" ? "connecting" : connected ? "online" : "disabled", info: seed.server === "connecting" ? null : serverInfo, message: null, books: seed.serverHoldsToken === undefined ? [] : [serverBook], updates: null, connection: connected ? CONNECTION : null },
  });
  return { book, state, summary };
}

/** The runtime the bar reaches through the loader: every command it can ask for, each a spy that succeeds. */
export function makeRuntime() {
  return {
    refresh: vi.fn(async () => null),
    pause: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    runOne: vi.fn(async () => undefined),
    updateOptions: vi.fn(async () => undefined),
    publishNow: vi.fn(async () => ({ ok: true, kind: "published", message: "Published to GitHub." })),
    armHandover: vi.fn(async () => undefined),
    cancelHandover: vi.fn(async () => true),
    dismissHandover: vi.fn(() => undefined),
    ensureServerStream: vi.fn(),
    describeError: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
  };
}

/** Open a menu the way a pointer does: Radix opens it on pointer down. */
export function openMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

/** Every control a person can reach in a part of the page: the ones that have a name to be told apart by. */
export function namedControls(root: ParentNode = document.body): Array<{ role: string; name: string }> {
  const found: Array<{ role: string; name: string }> = [];
  for (const role of ["button", "link", "menuitem", "menuitemradio", "combobox", "checkbox", "radio", "switch"] as const) {
    for (const element of screen.queryAllByRole(role, { hidden: true })) {
      if (!root.contains(element)) continue;
      const label = element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
      found.push({ role, name: label });
    }
  }
  return found;
}

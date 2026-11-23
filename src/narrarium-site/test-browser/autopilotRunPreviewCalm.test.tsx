import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: undefined as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  local: null as unknown,
  toast: vi.fn(),
  save: vi.fn(async () => true),
  estimates: { count: 0, lastMs: 0 },
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
// The engine, with its estimate counted and timed: what is asked is how often the page calculates, and how long it takes.
vi.mock("narrarium-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("narrarium-engine")>();
  return {
    ...actual,
    estimateAutopilotRun: (...args: Parameters<typeof actual.estimateAutopilotRun>) => {
      const started = performance.now();
      const result = actual.estimateAutopilotRun(...args);
      mocks.estimates.count += 1;
      mocks.estimates.lastMs = performance.now() - started;
      return result;
    },
  };
});

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { ANNOUNCE_PAUSE_MS, PREVIEW_PAUSE_MS } from "@/components/autopilot/config/RunPreview";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { LOCAL_BOOK, makeRuntime, seedBar, t } from "./helpers/quickCommands";
import { renderWithScaletta, scalettaFiles } from "./helpers/scaletta";
import { CLOUD, HOME, Page, field, region, statValue, structureOf, type, withAi } from "./helpers/setupEstimate";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];

const preview = () => region("autopilot.estimate.title");
const status = () => preview().querySelector("[data-estimate='announcement']") as HTMLElement;
const headline = () => preview().querySelector("[data-estimate='book']") as HTMLElement;

async function showFresh(language: Language = "en", integrations = [CLOUD]) {
  await i18n.changeLanguage(language);
  seedBar({ noState: true });
  withAi(integrations);
  await renderWithScaletta(<Page />);
  await screen.findByRole("region", { name: t("autopilot.estimate.title") });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
}

/** Time goes by a little at a time, and the page draws between the steps, as it does in a browser: one big jump would let a timer fire before the page redrew and cleared it. */
async function advance(milliseconds: number): Promise<void> {
  for (let left = milliseconds; left > 0; left -= 25) await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(25, left)); });
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = { ...makeRuntime(), configure: vi.fn(async () => undefined), reset: vi.fn(async () => undefined) };
  mocks.book = LOCAL_BOOK;
  mocks.structure = structureOf();
  mocks.local = new MemoryBookStore({ ...scalettaFiles() });
  mocks.estimates.count = 0;
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the preview while the author types", () => {
  it("lets every key land in the field at once, and calculates once, after the pause: the work does not follow the typing", async () => {
    await showFresh();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const before = mocks.estimates.count;
    const readers = field("autopilot.setup.maxReaders");
    readers.focus();
    for (const typed of ["1", "2", "3", "4"]) {
      type(readers, typed, false);
      expect(readers.value).toBe(typed);
      await advance(Math.floor(PREVIEW_PAUSE_MS / 4));
    }
    expect(readers).toHaveFocus();
    expect(mocks.estimates.count).toBe(before);
    await advance(PREVIEW_PAUSE_MS);
    expect(mocks.estimates.count).toBe(before + 1);
    expect(readers).toHaveFocus();
  });

  it("calculates in less than a frame's worth of the pause: in memory, with no file read and no wait", async () => {
    await showFresh();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    type(field("autopilot.setup.maxReaders"), "20", false);
    await advance(PREVIEW_PAUSE_MS + 10);
    expect(mocks.estimates.lastMs).toBeLessThan(50);
    expect(Number(statValue("calls").dataset.max)).toBeGreaterThan(0);
  });

  it("keeps the figures it had until the pause, and does not show a half-typed number", async () => {
    await showFresh();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const calls = statValue("calls").textContent;
    type(field("autopilot.setup.maxReaders"), "2", false);
    await advance(PREVIEW_PAUSE_MS / 2);
    expect(statValue("calls").textContent).toBe(calls);
    await advance(PREVIEW_PAUSE_MS);
    expect(statValue("calls").textContent).not.toBe(calls);
  });
});

describe.each(LANGUAGES)("what a screen reader is told (%s)", (language) => {
  it("is nothing when the page opens: the figures are there to be read, they are not news", async () => {
    await showFresh(language);
    expect(status()).toBeInTheDocument();
    expect(status().textContent).toBe("");
  });

  it("is the outcome, once, in a polite status, after a longer pause than the one that redraws the figures: never one line for each key", async () => {
    await showFresh(language);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const changes: string[] = [];
    const observer = new MutationObserver(() => changes.push(status().textContent ?? ""));
    observer.observe(status(), { childList: true, characterData: true, subtree: true });
    const readers = field("autopilot.setup.maxReaders");
    for (const typed of ["1", "2"]) {
      type(readers, typed, false);
      await advance(100);
    }
    await advance(PREVIEW_PAUSE_MS + 50);
    // The figures have been redrawn, and nothing has been said.
    expect(status().textContent).toBe("");
    await advance(ANNOUNCE_PAUSE_MS + 50);
    await act(async () => { await Promise.resolve(); });
    observer.disconnect();
    expect(status().textContent).toContain(new Intl.NumberFormat(language).format(Number(statValue("calls").dataset.shownMax)));
    expect(changes.filter((text) => text !== "")).toHaveLength(1);
  });

  it("says its words in the language of the page, and not the numbers of the engine in the language of the book", async () => {
    await showFresh(language);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    type(field("autopilot.setup.maxReaders"), "4", false);
    await advance(PREVIEW_PAUSE_MS + ANNOUNCE_PAUSE_MS + 100);
    expect(status().textContent).toContain(t("autopilot.estimate.announceTitle"));
  });

  it("is in a region of its own, polite and read whole, and the figures are in none: they do not change under the reader's hand", async () => {
    await showFresh(language);
    expect(status()).toHaveAttribute("role", "status");
    expect(status().className).toMatch(/sr-only/);
    const live = "[aria-live], [role='status'], [role='alert'], [role='log']";
    for (const element of [headline(), statValue("calls"), statValue("input-tokens"), statValue("output-tokens"), statValue("cost"), statValue("minutes")]) {
      expect(element.closest(live), element.textContent ?? "").toBeNull();
    }
    for (const item of preview().querySelectorAll("[data-warning]")) expect(item.closest(live)).toBeNull();
  });

  it("is not said again when the figures are the same: a change that moves no figure is no news", async () => {
    await showFresh(language);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    type(field("autopilot.setup.maxReaders"), "3", false);
    await advance(PREVIEW_PAUSE_MS + ANNOUNCE_PAUSE_MS + 100);
    const first = status().textContent;
    expect(first).not.toBe("");
    const changes: string[] = [];
    const observer = new MutationObserver(() => changes.push(status().textContent ?? ""));
    observer.observe(status(), { childList: true, characterData: true, subtree: true });
    type(field("autopilot.setup.maxReaders"), "3", false);
    await advance(PREVIEW_PAUSE_MS + ANNOUNCE_PAUSE_MS + 100);
    observer.disconnect();
    expect(changes).toEqual([]);
    expect(status().textContent).toBe(first);
  });
});

describe("the preview with the keyboard", () => {
  it("has a name for every control, no tab stop that is not where the content is, and an assumptions section that opens like any native one", async () => {
    await showFresh("en", [HOME]);
    const section = preview();
    for (const control of section.querySelectorAll("a, button, summary")) {
      expect((control as HTMLElement).tabIndex, control.outerHTML).toBeLessThanOrEqual(0);
      expect(control).toHaveAccessibleName();
    }
    const details = section.querySelector("details[data-estimate='assumptions']") as HTMLDetailsElement;
    const summary = details.querySelector("summary") as HTMLElement;
    expect(details.open).toBe(false);
    summary.focus();
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(within(details).getAllByRole("listitem").length).toBeGreaterThan(2);
  });

  it("has actions that are links to where the problem is solved, as big as a thumb where there is room, and never smaller than the least the guidelines ask", async () => {
    await showFresh("en", []);
    const links = within(preview()).getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.className, link.textContent ?? "").toMatch(/\bmin-h-(6|7|8|9|10|11)\b|\bh-(6|7|8|9|10|11)\b/);
    for (const link of within(preview().querySelector("[data-warning='noModel']") as HTMLElement).getAllByRole("link")) expect(link.className).toMatch(/\bmin-h-11\b|\bh-11\b/);
  });

  it("has a table of the calls by role that a screen reader can read as a table: a caption, headers for the columns, and a header for each row", async () => {
    await showFresh();
    const table = within(preview()).getByRole("table", { name: t("autopilot.estimate.byRole") });
    expect(within(table).getAllByRole("columnheader").length).toBe(3);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.length).toBe(5);
    for (const row of rows) expect(within(row).getAllByRole("rowheader")).toHaveLength(1);
  });
});

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotLongRetry } from "narrarium-engine";
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
import { LOCAL_BOOK, T0, makeRuntime, seedBar, t } from "./helpers/quickCommands";
import { renderWithScaletta, scalettaFiles } from "./helpers/scaletta";

// «Retry later» in the configuration: a switch that is off unless the author turns it on, the words of the consent next to it, the minutes and the
// restarts checked before anything is saved (nothing is cut to fit, and an empty field is never «no limit»), also while a run goes on.

const ROOT = "/app/books/book-1";
const SETTINGS = `${ROOT}/autopilot/settings`;
const SERVER_BOOK: BookEntry = { ...LOCAL_BOOK, autopilotHost: "server" };
const LIVE = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });
const POLICY: AutopilotLongRetry = { everyMinutes: 10, cycles: 6 };
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

function Where() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.hash}`}</p>;
}

function Page({ path = SETTINGS }: { path?: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/books/:bookId/autopilot/settings" element={<AutopilotSettingsPage />} />
        <Route path="/app/books/:bookId/autopilot" element={<p>The live page</p>} />
      </Routes>
      <Where />
    </MemoryRouter>
  );
}

const key = (name: string) => `autopilot.config.retryLater.${name}`;
/** «Retry later» is in its own tab: the tab is shown before anything is looked for in it. */
const choose = (tab: string) => fireEvent.click(screen.getByRole("tab", { name: t(`autopilot.config.tabs.${tab}`) }));
const card = () => {
  choose("retries");
  return within(document.getElementById("autopilot-panel-retries") as HTMLElement);
};
const toggle = () => card().getByRole("switch", { name: t(key("label")) });
const minutes = () => card().getByLabelText(t(key("every"))) as HTMLInputElement;
const restarts = () => card().getByLabelText(t(key("cycles.count"))) as HTMLInputElement;
const limited = () => card().getByRole("radio", { name: t(key("cycles.limit")) });
const unlimited = () => card().getByRole("radio", { name: t(key("cycles.unlimited")) });
const saveButton = () => screen.getByRole("button", { name: t("autopilot.setup.save") });
/** The words a screen reader reads after the name of a control: the elements its `aria-describedby` names. */
const described = (element: HTMLElement) => (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
/** What a person does: the field gets the text, then loses the focus. */
function type(input: HTMLInputElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = { ...makeRuntime(), configure: vi.fn(async () => undefined), reset: vi.fn(async () => undefined) };
  mocks.book = LOCAL_BOOK;
  mocks.structure = { title: "The Glass Harbor", language: "en", owner: "local", repo: "book-1", defaultBranch: "main", loadedBranch: "main", rootFiles: [{ path: "book.md" }], firstClassFiles: [], chapters: [{ slug: "001-one", title: "One", paragraphs: [{}] }], ghostwriters: [], readerPersonas: [] };
  mocks.local = new MemoryBookStore({ "director.md": "---\nname: Ada\n---\nThe vision.\n", ...scalettaFiles() });
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("«Retry later» in the configuration", () => {
  it("is a tab of its own, after the review and before publishing, that a link can bring into view", async () => {
    seedRun({ status: "paused" });
    await renderWithScaletta(<Page path={`${SETTINGS}#autopilot-retries`} />);
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab").map((element) => element.textContent);
    expect(tabs.slice(0, 4)).toEqual([t("autopilot.config.tabs.overview"), t("autopilot.config.tabs.review"), t("autopilot.config.tabs.retries"), t("autopilot.config.tabs.publishing")]);
    await waitFor(() => expect(screen.getByRole("tab", { name: t("autopilot.config.tabs.retries") })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(within(document.getElementById("autopilot-panel-retries") as HTMLElement).getByRole("switch", { name: t(key("label")) })).toBeInTheDocument());
  });

  it("is off for a book that never turned it on, and shows nothing to fill in until it is on", async () => {
    seedRun({ status: "paused" });
    await renderWithScaletta(<Page />);
    expect(toggle()).not.toBeChecked();
    expect(card().queryByLabelText(t(key("every")))).toBeNull();
  });

  it("says what it does and what it costs next to the switch, always, and the switch is described by it", async () => {
    seedRun({ status: "paused" });
    await renderWithScaletta(<Page />);
    const consent = card().getByText(t(key("consent")));
    expect(consent).toBeVisible();
    expect(described(toggle())).toContain(t(key("consent")));
    fireEvent.click(toggle());
    expect(card().getByText(t(key("consent")))).toBeVisible();
  });

  it("starts from the recommended values once turned on, and sends nothing until it is saved", async () => {
    seedRun({ status: "paused" });
    await renderWithScaletta(<Page />);
    fireEvent.click(toggle());
    expect(toggle()).toBeChecked();
    expect(minutes()).toHaveValue(10);
    expect(limited()).toBeChecked();
    expect(restarts()).toHaveValue(6);
    expect(unlimited()).not.toBeChecked();
    expect(mocks.runtime.configure).not.toHaveBeenCalled();
    expect(mocks.runtime.updateOptions).not.toHaveBeenCalled();
  });

  it("is saved with the other settings while the autopilot is stopped", async () => {
    seedRun({ status: "paused" });
    await renderWithScaletta(<Page />);
    fireEvent.click(toggle());
    type(minutes(), "30");
    type(restarts(), "4");
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ longRetry: { everyMinutes: 30, cycles: 4 } }) });
  });

  it("goes on until it works only when the author chooses it in words, and then the number is not read", async () => {
    seedRun({ status: "paused" });
    await renderWithScaletta(<Page />);
    fireEvent.click(toggle());
    fireEvent.click(unlimited());
    expect(restarts()).toBeDisabled();
    type(minutes(), "60");
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ longRetry: { everyMinutes: 60, cycles: "unlimited" } }) });
  });

  it("shows a book that has it on as it is, and turning it off sends that it is off", async () => {
    seedRun({ status: "paused", options: { longRetry: { everyMinutes: 45, cycles: "unlimited" } } });
    await renderWithScaletta(<Page />);
    expect(toggle()).toBeChecked();
    expect(minutes()).toHaveValue(45);
    expect(unlimited()).toBeChecked();
    fireEvent.click(toggle());
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledTimes(1));
    expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ longRetry: null }) });
  });

  it("puts back the recommended values: every 10 minutes, 6 times", async () => {
    seedRun({ status: "paused" });
    await renderWithScaletta(<Page />);
    fireEvent.click(toggle());
    type(minutes(), "300");
    fireEvent.click(unlimited());
    const button = card().getByRole("button", { name: t(key("recommended")) });
    expect(described(button)).toContain(t(key("recommendedHint")));
    fireEvent.click(button);
    expect(minutes()).toHaveValue(10);
    expect(limited()).toBeChecked();
    expect(restarts()).toHaveValue(6);
  });

  describe("checks what is typed before anything is saved", () => {
    it.each([
      ["0", "min"],
      ["-5", "whole"],
      ["1.5", "whole"],
      ["10081", "max"],
      ["", "empty"],
    ])("refuses %j minutes with a reason, and saves nothing: the focus goes to the field", async (text, problem) => {
      seedRun({ status: "paused" });
      await renderWithScaletta(<Page />);
      fireEvent.click(toggle());
      type(minutes(), text);
      expect(minutes()).toHaveAttribute("aria-invalid", "true");
      expect(described(minutes())).toContain(t(key(`errors.every.${problem}`)));
      fireEvent.click(saveButton());
      await waitFor(() => expect(document.activeElement).toBe(minutes()));
      expect(mocks.runtime.configure).not.toHaveBeenCalled();
      expect(minutes()).toHaveValue(text === "" ? null : Number(text));
    });

    it.each([
      ["0", "min"],
      ["", "empty"],
      ["1001", "max"],
      ["2.5", "whole"],
    ])("refuses %j restarts: an empty field is never «no limit»", async (text, problem) => {
      seedRun({ status: "paused" });
      await renderWithScaletta(<Page />);
      fireEvent.click(toggle());
      type(restarts(), text);
      expect(restarts()).toHaveAttribute("aria-invalid", "true");
      expect(described(restarts())).toContain(t(key(`errors.cycles.${problem}`)));
      fireEvent.click(saveButton());
      await waitFor(() => expect(document.activeElement).toBe(restarts()));
      expect(mocks.runtime.configure).not.toHaveBeenCalled();
    });

    it("does not start a book with a value it would refuse either", async () => {
      seedRun({ status: "paused" });
      await renderWithScaletta(<Page />);
      fireEvent.click(toggle());
      type(minutes(), "0");
      fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.resume") }));
      await waitFor(() => expect(document.activeElement).toBe(minutes()));
      expect(mocks.runtime.start).not.toHaveBeenCalled();
      expect(mocks.runtime.configure).not.toHaveBeenCalled();
    });

    it("takes the edges of the ranges, and a field that was wrong once is right again when corrected", async () => {
      seedRun({ status: "paused" });
      await renderWithScaletta(<Page />);
      fireEvent.click(toggle());
      type(minutes(), "0");
      expect(minutes()).toHaveAttribute("aria-invalid", "true");
      type(minutes(), "10080");
      type(restarts(), "1000");
      expect(minutes()).not.toHaveAttribute("aria-invalid", "true");
      fireEvent.click(saveButton());
      await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ longRetry: { everyMinutes: 10_080, cycles: 1000 } }) }));
    });
  });

  it("goes with the options when a book that never started is started, and is not sent at all when it is off", async () => {
    seedBar({ noState: true });
    const view = await renderWithScaletta(<Page />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ longRetry: POLICY }) }));
    view.unmount();
    mocks.runtime.start.mockClear();
    seedBar({ noState: true });
    await renderWithScaletta(<Page />);
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(1));
    const [, sent] = mocks.runtime.start.mock.calls[0] as [string, { options: Record<string, unknown> }];
    expect("longRetry" in sent.options).toBe(false);
  });

  describe("while the autopilot runs", () => {
    it("can change, with updateOptions and nothing else, and the page says so", async () => {
      seedRun({ status: "running", running: true, live: { activity: LIVE } });
      await renderWithScaletta(<Page />);
      expect(toggle()).toBeEnabled();
      expect(card().getByText(t(key("running")))).toBeInTheDocument();
      fireEvent.click(toggle());
      fireEvent.click(saveButton());
      await waitFor(() => expect(mocks.runtime.updateOptions).toHaveBeenCalledWith("book-1", { longRetry: POLICY }));
      expect(mocks.runtime.configure).not.toHaveBeenCalled();
    });

    it("says before it is turned off that a run waiting to retry would stop, and turning it off sends that it is off", async () => {
      seedRun({ status: "running", running: true, retry: { at: at(600), attempt: 3, retries: 3, longTerm: { cycle: 1, cycles: 6 } }, options: { longRetry: POLICY } });
      await renderWithScaletta(<Page />);
      expect(card().getByText(t(key("waitingNow")))).toBeInTheDocument();
      fireEvent.click(toggle());
      expect(card().getByText(t(key("waitingNow")))).toBeInTheDocument();
      fireEvent.click(saveButton());
      await waitFor(() => expect(mocks.runtime.updateOptions).toHaveBeenCalledWith("book-1", { longRetry: null }));
    });
  });

  describe("on a personal server", () => {
    it("that does not have it is off and cannot change, and the page says to update it", async () => {
      mocks.book = SERVER_BOOK;
      seedRun({ book: SERVER_BOOK, status: "paused", server: "online" });
      await renderWithScaletta(<Page />);
      expect(toggle()).toBeDisabled();
      expect(described(toggle())).toContain(t(key("oldServer"), { version: "0.1.10" }));
      expect(card().getByText(t(key("oldServer"), { version: "0.1.10" }))).toBeInTheDocument();
    });

    it("that has it can change it", async () => {
      mocks.book = SERVER_BOOK;
      seedRun({ book: SERVER_BOOK, status: "paused", server: "retry" });
      await renderWithScaletta(<Page />);
      expect(toggle()).toBeEnabled();
      expect(card().queryByText(t(key("oldServer"), { version: "0.1.10" }))).toBeNull();
      fireEvent.click(toggle());
      fireEvent.click(saveButton());
      await waitFor(() => expect(mocks.runtime.configure).toHaveBeenCalledWith("book-1", { brief: expect.anything(), options: expect.objectContaining({ longRetry: POLICY }) }));
    });
  });

  it("is in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    seedRun({ status: "paused" });
    await renderWithScaletta(<Page />);
    expect(screen.getByRole("tab", { name: "Nuovi tentativi" })).toBeInTheDocument();
    choose("retries");
    fireEvent.click(screen.getByRole("switch", { name: "Riprova più tardi" }));
    expect(screen.getByRole("radio", { name: "Continua finché riesce o finché non lo fermo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Usa i valori consigliati" })).toBeInTheDocument();
    type(screen.getByLabelText("Minuti tra una ripartenza e l'altra") as HTMLInputElement, "0");
    expect(screen.getByText(t(key("errors.every.min")))).toBeInTheDocument();
  });
});

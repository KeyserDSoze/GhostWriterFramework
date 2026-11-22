import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPTIONS, type AutopilotPlan } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { QuickCommands } from "@/components/autopilot/QuickCommands";
import { HandoverConsentError } from "@/autopilot/handover";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { GITHUB_BOOK, LOCAL_BOOK, T0, makeRuntime, openMenu, quickGroupName, quickName, seedBar, t } from "./helpers/quickCommands";

const QUESTION = { id: "q-1", kind: "plan-approval" as const, question: "Approve this plan?", context: "", options: ["Yes", "No"], askedAt: T0 };
const awaitingPlan = { chapters: [], approved: false, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: true } as unknown as AutopilotPlan;

function Where() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.hash}</output>;
}

function renderBar(variant: "page" | "dock" = "page") {
  return render(
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="*" element={<><QuickCommands bookId="book-1" variant={variant} /><Where /></>} /></Routes>
    </MemoryRouter>,
  );
}

const name = (key: string, variant: "page" | "dock" = "page") => quickName(t(key), variant);
const button = (key: string, variant: "page" | "dock" = "page") => screen.getByRole("button", { name: name(key, variant) }) as HTMLButtonElement;
const maybeButton = (key: string) => screen.queryByRole("button", { name: name(key) });
const group = () => screen.getByRole("group", { name: quickGroupName() });
const status = () => within(group()).getByRole("status");
const item = (key: string, role: "menuitem" | "menuitemradio" = "menuitem") => screen.getByRole(role, { name: new RegExp(`^${t(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
const textOf = (key: string, options?: Record<string, unknown>) => t(key, options);

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await loadAutopilotTranslations();
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  mocks.toast.mockReset();
  mocks.save.mockClear();
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe.each(["en", "it"] as const)("the quick commands of an autopilot that is stopped (%s)", (language) => {
  beforeEach(async () => {
    await i18n.changeLanguage(language);
    seedBar({ status: "paused" });
  });

  it("offers Resume and Run, with a name that says which book they command, and no pause or stop", () => {
    renderBar();
    expect(group()).toBeInTheDocument();
    expect(button("autopilot.actions.resume")).toBeEnabled();
    expect(button("autopilot.quick.run.menu")).toHaveAttribute("aria-haspopup", "menu");
    expect(maybeButton("autopilot.actions.pause")).not.toBeInTheDocument();
    expect(maybeButton("autopilot.actions.stop")).not.toBeInTheDocument();
    // Each control says what it does in words, next to its icon.
    expect(within(button("autopilot.actions.resume")).getByText(t("autopilot.actions.resume"))).toBeVisible();
    expect(within(button("autopilot.quick.run.menu")).getByText(t("autopilot.quick.run.menu"))).toBeVisible();
  });

  it("resumes with no limit", async () => {
    renderBar();
    fireEvent.click(button("autopilot.actions.resume"));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
  });

  it("runs one step, one chapter, or until the author stops it, from the Run menu", async () => {
    renderBar();
    openMenu(button("autopilot.quick.run.menu"));
    fireEvent.click(item("autopilot.quick.run.step"));
    await waitFor(() => expect(mocks.runtime.runOne).toHaveBeenCalledWith("book-1", "step"));

    openMenu(button("autopilot.quick.run.menu"));
    fireEvent.click(item("autopilot.quick.run.chapter"));
    await waitFor(() => expect(mocks.runtime.runOne).toHaveBeenCalledWith("book-1", "chapter"));

    openMenu(button("autopilot.quick.run.menu"));
    fireEvent.click(item("autopilot.quick.run.untilStopped"));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
    expect(mocks.runtime.runOne).toHaveBeenCalledTimes(2);
  });
});

describe.each(["en", "it"] as const)("the quick commands of an autopilot that runs here (%s)", (language) => {
  beforeEach(async () => {
    await i18n.changeLanguage(language);
    seedBar({ status: "running", running: true });
  });

  it("pauses after the step with the main button, and stops now with the other, which warns about the cost", async () => {
    renderBar();
    expect(maybeButton("autopilot.actions.resume")).not.toBeInTheDocument();
    expect(button("autopilot.actions.stop")).toHaveAccessibleDescription(t("autopilot.stopHint"));
    fireEvent.click(button("autopilot.actions.pause"));
    await waitFor(() => expect(mocks.runtime.pause).toHaveBeenCalledWith("book-1", "after-step"));
    fireEvent.click(button("autopilot.actions.stop"));
    await waitFor(() => expect(mocks.runtime.pause).toHaveBeenCalledWith("book-1", "now"));
  });

  it("pauses at the end of the chapter from the menu of the pause button, which has no way to cancel while nothing waits", async () => {
    renderBar();
    openMenu(button("autopilot.quick.run.pauseMore"));
    expect(item("autopilot.quick.run.pauseStep")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: t("autopilot.quick.run.pauseCancel") })).not.toBeInTheDocument();
    fireEvent.click(item("autopilot.quick.run.pauseChapter"));
    await waitFor(() => expect(mocks.runtime.pause).toHaveBeenCalledWith("book-1", "after-chapter"));
  });

  it("has nothing in the status line while nothing waits", () => {
    renderBar();
    expect(status()).toBeEmptyDOMElement();
  });
});

describe("a pause that waits", () => {
  it.each([
    ["after-step", "autopilot.quick.status.pauseStep"],
    ["after-chapter", "autopilot.quick.status.pauseChapter"],
  ] as const)("is said in the status line, with a way to take it back (%s)", async (pausePending, key) => {
    seedBar({ status: "running", running: true, pausePending });
    renderBar();
    expect(within(status()).getByText(textOf(key))).toBeVisible();
    // The cross is a button with a name of its own, and the tooltip says the same.
    const cancel = within(status()).getByRole("button", { name: name("autopilot.quick.run.pauseCancel") });
    expect(cancel).toHaveAttribute("title", name("autopilot.quick.run.pauseCancel"));
    fireEvent.click(cancel);
    await waitFor(() => expect(mocks.runtime.pause).toHaveBeenCalledWith("book-1", "cancel"));
  });

  it("is said in Italian, as the site says it", async () => {
    await i18n.changeLanguage("it");
    seedBar({ status: "running", running: true, pausePending: "after-chapter" });
    renderBar();
    expect(within(status()).getByText("In pausa a fine capitolo")).toBeVisible();
    expect(within(status()).getByRole("button", { name: quickName("Annulla la pausa") })).toBeInTheDocument();
  });

  it("can be taken back from the menu too, and cannot be asked for again", async () => {
    seedBar({ status: "running", running: true, pausePending: "after-step" });
    renderBar();
    // The pause after the step is already asked for: the main button says so and waits.
    expect(button("autopilot.actions.pause")).toBeDisabled();
    openMenu(button("autopilot.quick.run.pauseMore"));
    expect(item("autopilot.quick.run.pauseStep")).toHaveAttribute("aria-disabled", "true");
    expect(item("autopilot.quick.run.pauseChapter")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: t("autopilot.quick.run.pauseCancel") }));
    await waitFor(() => expect(mocks.runtime.pause).toHaveBeenCalledWith("book-1", "cancel"));
  });

  it("at the end of the chapter can still be made stricter: the step pauses sooner", async () => {
    seedBar({ status: "running", running: true, pausePending: "after-chapter" });
    renderBar();
    expect(button("autopilot.actions.pause")).toBeEnabled();
    fireEvent.click(button("autopilot.actions.pause"));
    await waitFor(() => expect(mocks.runtime.pause).toHaveBeenCalledWith("book-1", "after-step"));
  });
});

describe("the limits of a run", () => {
  it("are said in the status line, with the number the run was limited to", () => {
    seedBar({ status: "running", running: true, limits: { steps: 3, chapters: 2, stepsDone: 1, chaptersDone: 0 } });
    renderBar();
    expect(within(status()).getByText(textOf("autopilot.quick.status.stepLimit", { count: 3 }))).toBeVisible();
    expect(within(status()).getByText(textOf("autopilot.quick.status.chapterLimit", { count: 2 }))).toBeVisible();
    expect(textOf("autopilot.quick.status.stepLimit", { count: 1 })).not.toBe(textOf("autopilot.quick.status.stepLimit", { count: 3 }));
  });

  it("do not make the status line change with every step: the counter of steps done is not in it", () => {
    seedBar({ status: "running", running: true, limits: { steps: 3, stepsDone: 0, chaptersDone: 0 } });
    renderBar();
    const before = status().textContent;
    seedBar({ status: "running", running: true, limits: { steps: 3, stepsDone: 2, chaptersDone: 0 } });
    expect(status().textContent).toBe(before);
  });
});

describe("what the autopilot waits for", () => {
  it("says to approve the plan when the plan waits for the author, and runs from there", async () => {
    seedBar({ status: "waiting-author", statePatch: { plan: awaitingPlan } });
    renderBar();
    expect(button("autopilot.actions.approvePlan")).toBeEnabled();
    expect(maybeButton("autopilot.actions.resume")).not.toBeInTheDocument();
    fireEvent.click(button("autopilot.actions.approvePlan"));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
  });

  it("has a link to the question instead of Resume and Run when the director asks one", () => {
    seedBar({ status: "waiting-author", question: QUESTION });
    renderBar();
    const link = screen.getByRole("link", { name: name("autopilot.quick.run.answer") });
    expect(link).toHaveAttribute("href", "/app/books/book-1/autopilot#autopilot-question");
    expect(maybeButton("autopilot.actions.resume")).not.toBeInTheDocument();
    expect(maybeButton("autopilot.quick.run.menu")).not.toBeInTheDocument();
  });

  it("shows nothing at all for a book whose autopilot never started: there is nothing to command", () => {
    seedBar({ noState: true });
    renderBar();
    expect(screen.queryByRole("group", { name: quickGroupName() })).not.toBeInTheDocument();
    expect(document.body.querySelectorAll("button").length).toBe(0);
  });

  it("describes Resume by the hint of the notice of the profile files, when that notice is there", () => {
    seedBar({ status: "waiting-author" });
    render(<MemoryRouter><p id="hint-1">Correct the files, then resume.</p><QuickCommands bookId="book-1" variant="page" profileHintId="hint-1" /></MemoryRouter>);
    expect(button("autopilot.actions.resume")).toHaveAccessibleDescription("Correct the files, then resume.");
  });
});

describe("a run that this client cannot reach", () => {
  it("disables every command that would go to it, says why once, and offers to take control", () => {
    seedBar({ status: "running", running: false, runner: { host: "browser", label: "Browser · Android", hostId: "other", runId: "run-1", startedAt: T0, heartbeatAt: new Date().toISOString() }, token: true });
    renderBar();
    const why = screen.getByText(t("autopilot.remoteRunner", { label: "Browser · Android" }), { exact: false });
    expect(button("autopilot.actions.pause")).toBeDisabled();
    expect(button("autopilot.actions.stop")).toBeDisabled();
    for (const control of [button("autopilot.actions.pause"), button("autopilot.actions.stop")]) {
      expect(document.getElementById(control.getAttribute("aria-describedby")!)).toContainElement(why);
    }
    expect(screen.getByRole("button", { name: name("autopilot.control.takeOver") })).toBeEnabled();
    expect(screen.getAllByText(t("autopilot.remoteRunner", { label: "Browser · Android" }), { exact: false })).toHaveLength(1);
  });
});

describe("where the book is published", () => {
  beforeEach(() => seedBar({ book: GITHUB_BOOK, status: "running", running: true, publish: "chapter" }));

  it("shows the way it is published now, as the engine says it, on the button of the menu", () => {
    renderBar();
    const trigger = screen.getByRole("button", { name: quickName(t("autopilot.quick.publish.label", { mode: t("autopilot.quick.publish.mode.chapter") }), "page", GITHUB_BOOK) });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(within(trigger).getByText(t("autopilot.quick.publish.label", { mode: t("autopilot.quick.publish.mode.chapter") }))).toBeVisible();
  });

  it("says in Italian what the site says: GitHub: a fine capitolo", async () => {
    await i18n.changeLanguage("it");
    renderBar();
    expect(screen.getByRole("button", { name: quickName("GitHub: a fine capitolo", "page", GITHUB_BOOK) })).toBeInTheDocument();
  });

  it("has three ways to publish, the one in force marked, and changes it for the next step, also while the autopilot runs", async () => {
    renderBar();
    openMenu(screen.getByRole("button", { name: /GitHub:/ }));
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((radio) => radio.textContent)).toEqual([t("autopilot.quick.publish.choice.off"), t("autopilot.quick.publish.choice.chapter"), t("autopilot.quick.publish.choice.step")]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(screen.getByText(t("autopilot.quick.publish.applies"))).toBeVisible();
    fireEvent.click(radios[2]);
    await waitFor(() => expect(mocks.runtime.updateOptions).toHaveBeenCalledWith("book-1", { publishEvery: "step" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.quick.publish.saved", { mode: t("autopilot.quick.publish.mode.step") }) }));
  });

  it("publishes now, and says how it went", async () => {
    renderBar();
    openMenu(screen.getByRole("button", { name: /GitHub:/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: t("autopilot.quick.publish.now") }));
    await waitFor(() => expect(mocks.runtime.publishNow).toHaveBeenCalledWith("book-1"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.where.published") }));
  });

  it.each([
    [true, "chapter"],
    [false, "off"],
  ] as const)("works out the way from the options when the host says nothing: the older option %s decides (%s)", (syncAfterChapter, mode) => {
    seedBar({ book: GITHUB_BOOK, status: "paused", statePatch: { options: { ...DEFAULT_OPTIONS, syncAfterChapter } } });
    renderBar();
    expect(screen.getByRole("button", { name: /GitHub:/ })).toHaveTextContent(t(`autopilot.quick.publish.mode.${mode}`));
  });

  it("follows the choice of the author over the older option", () => {
    seedBar({ book: GITHUB_BOOK, status: "paused", statePatch: { options: { ...DEFAULT_OPTIONS, syncAfterChapter: false, publishEvery: "step" } } });
    renderBar();
    expect(screen.getByRole("button", { name: /GitHub:/ })).toHaveTextContent(t("autopilot.quick.publish.mode.step"));
  });

  it("is not there for a book that is not on GitHub", () => {
    seedBar({ status: "running", running: true });
    renderBar();
    expect(screen.queryByRole("button", { name: /GitHub:/ })).not.toBeInTheDocument();
  });

  it("is disabled, with the reason next to it and tied to it, when there is no GitHub token to use", () => {
    seedBar({ book: GITHUB_BOOK, status: "paused", token: false });
    renderBar();
    const trigger = screen.getByRole("button", { name: /GitHub:/ });
    expect(trigger).toBeDisabled();
    const reason = screen.getByText(t("autopilot.quick.publish.needsToken"));
    expect(reason).toBeVisible();
    expect(trigger.getAttribute("aria-describedby")).toContain(reason.id);
    expect(screen.getByRole("link", { name: t("autopilot.quick.publish.tokenLink") })).toHaveAttribute("href", "/app/settings/github");
  });
});


describe("a server that predates the quick controls", () => {
  beforeEach(() => seedBar({ book: { ...GITHUB_BOOK, autopilotHost: "server" }, status: "running", running: true, server: "old", publish: "step" }));

  it("disables the pause at the end of the chapter, and says to update the server, in the menu where it is", () => {
    renderBar();
    openMenu(button("autopilot.quick.run.pauseMore"));
    const entry = item("autopilot.quick.run.pauseChapter");
    expect(entry).toHaveAttribute("aria-disabled", "true");
    expect(within(entry).getByText(t("autopilot.quick.serverTooOld", { version: "0.1.5" }))).toBeVisible();
    // The pause the old server knows is there.
    expect(item("autopilot.quick.run.pauseStep")).not.toHaveAttribute("aria-disabled", "true");
  });

  it("does not offer a run of one step or one chapter: it would not stop", () => {
    seedBar({ book: { ...GITHUB_BOOK, autopilotHost: "server" }, status: "paused", server: "old" });
    renderBar();
    openMenu(button("autopilot.quick.run.menu"));
    expect(item("autopilot.quick.run.step")).toHaveAttribute("aria-disabled", "true");
    expect(item("autopilot.quick.run.chapter")).toHaveAttribute("aria-disabled", "true");
    expect(item("autopilot.quick.run.untilStopped")).not.toHaveAttribute("aria-disabled", "true");
    expect(within(item("autopilot.quick.run.step")).getByText(t("autopilot.quick.serverTooOld", { version: "0.1.5" }))).toBeVisible();
  });

  it("does not offer to change how the book is published, but still publishes now", () => {
    renderBar();
    openMenu(screen.getByRole("button", { name: /GitHub:/ }));
    for (const radio of screen.getAllByRole("menuitemradio")) expect(radio).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: t("autopilot.quick.publish.now") })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("does not take for old a server that has not said yet what it can do: the connection is only being made", () => {
    seedBar({ book: { ...GITHUB_BOOK, autopilotHost: "server" }, status: "running", running: true, server: "connecting", publish: "step" });
    renderBar();
    openMenu(button("autopilot.quick.run.pauseMore"));
    expect(item("autopilot.quick.run.pauseChapter")).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(t("autopilot.quick.serverTooOld", { version: "0.1.5" }))).not.toBeInTheDocument();
  });

  it("still lets the book come back to this browser", () => {
    renderBar();
    expect(screen.getByRole("button", { name: quickName(t("autopilot.quick.where.label", { host: t("autopilot.quick.where.hostServer") }), "page", { ...GITHUB_BOOK }) })).toBeEnabled();
  });
});

describe("where the autopilot runs", () => {
  const trigger = (host: "browser" | "server", book = LOCAL_BOOK) => screen.getByRole("button", { name: quickName(t("autopilot.quick.where.label", { host: t(host === "server" ? "autopilot.quick.where.hostServer" : "autopilot.quick.where.hostBrowser") }), "page", book) }) as HTMLButtonElement;

  it("says where it runs, and offers the three ways to pass to the server of a run that goes on", async () => {
    seedBar({ status: "running", running: true, server: "online" });
    renderBar();
    openMenu(trigger("browser"));
    expect(screen.getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual([
      textOf("autopilot.quick.where.toServerAfterStep"),
      `${textOf("autopilot.quick.where.toServerNow")}${textOf("autopilot.quick.where.toServerNowHint")}`,
      textOf("autopilot.quick.where.stepOnServer"),
    ]);
    fireEvent.click(item("autopilot.quick.where.toServerAfterStep"));
    await waitFor(() => expect(mocks.runtime.armHandover).toHaveBeenCalledWith("book-1", { to: "server" }, { saveSettings: mocks.save }));

    openMenu(trigger("browser"));
    fireEvent.click(item("autopilot.quick.where.toServerNow"));
    await waitFor(() => expect(mocks.runtime.armHandover).toHaveBeenCalledWith("book-1", { to: "server", when: "now" }, { saveSettings: mocks.save }));

    openMenu(trigger("browser"));
    fireEvent.click(item("autopilot.quick.where.stepOnServer"));
    await waitFor(() => expect(mocks.runtime.armHandover).toHaveBeenCalledWith("book-1", { to: "server", returnAfterSteps: 1 }, { saveSettings: mocks.save }));
  });

  it("offers only to pass, and to run one step there, when the autopilot is stopped: there is no step to wait for", async () => {
    seedBar({ status: "paused", server: "online" });
    renderBar();
    openMenu(trigger("browser"));
    expect(screen.getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual([textOf("autopilot.quick.where.toServer"), textOf("autopilot.quick.where.stepOnServer")]);
    fireEvent.click(item("autopilot.quick.where.toServer"));
    await waitFor(() => expect(mocks.runtime.armHandover).toHaveBeenCalledWith("book-1", { to: "server" }, { saveSettings: mocks.save }));
  });

  it("does not offer one step on a server that would not stop at it, though it still takes the book", () => {
    seedBar({ status: "running", running: true, server: "old" });
    renderBar();
    openMenu(trigger("browser"));
    const step = item("autopilot.quick.where.stepOnServer");
    expect(step).toHaveAttribute("aria-disabled", "true");
    expect(within(step).getByText(t("autopilot.quick.serverTooOld", { version: "0.1.5" }))).toBeVisible();
    expect(item("autopilot.quick.where.toServerAfterStep")).not.toHaveAttribute("aria-disabled", "true");
  });

  it("passes the other way for a book the server runs", async () => {
    seedBar({ book: { ...LOCAL_BOOK, autopilotHost: "server" }, status: "running", running: true, server: "online" });
    renderBar();
    openMenu(trigger("server", { ...LOCAL_BOOK }));
    fireEvent.click(item("autopilot.quick.where.toBrowserAfterStep"));
    await waitFor(() => expect(mocks.runtime.armHandover).toHaveBeenCalledWith("book-1", { to: "browser" }, { saveSettings: mocks.save }));
    openMenu(trigger("server", { ...LOCAL_BOOK }));
    fireEvent.click(item("autopilot.quick.where.stepInBrowser"));
    await waitFor(() => expect(mocks.runtime.armHandover).toHaveBeenCalledWith("book-1", { to: "browser", returnAfterSteps: 1 }, { saveSettings: mocks.save }));
  });

  it("is disabled, with the reason next to it and tied to it, when no server is connected", () => {
    seedBar({ status: "paused", server: "none" });
    renderBar();
    expect(trigger("browser")).toBeDisabled();
    const reason = screen.getByText(t("autopilot.where.noServer"), { exact: false });
    expect(reason).toBeVisible();
    expect(trigger("browser").getAttribute("aria-describedby")).toContain(reason.id);
  });

  it("is disabled, with the reason, when the server is not verified: it is not where a book goes", () => {
    seedBar({ status: "paused", server: "offline" });
    renderBar();
    expect(trigger("browser")).toBeDisabled();
    const reason = screen.getByText(t("autopilot.where.serverUnverified"), { exact: false });
    expect(trigger("browser").getAttribute("aria-describedby")).toContain(reason.id);
    expect(screen.getByRole("link", { name: t("personalServer.title") })).toHaveAttribute("href", "/app/settings/server");
  });

  it("is disabled, with the reason as text, while another operation holds the book", () => {
    seedBar({ status: "paused", server: "online", operation: { kind: "sync", since: new Date().toISOString() } });
    renderBar();
    expect(trigger("browser")).toBeDisabled();
    const reason = screen.getByText(t("autopilot.quick.where.busy"));
    expect(trigger("browser").getAttribute("aria-describedby")).toContain(reason.id);
    // Resume waits for the same operation: it says so in the same words.
    expect(button("autopilot.actions.resume")).toBeDisabled();
  });

  it("cannot be used from here while another device runs the book", () => {
    seedBar({ status: "running", running: false, server: "online", runner: { host: "browser", label: "Browser · Android", hostId: "other", runId: "run-1", startedAt: T0, heartbeatAt: new Date().toISOString() } });
    renderBar();
    expect(trigger("browser")).toBeDisabled();
  });

  it("opens the flow of “Where it runs” when a consent is missing, instead of asking for the keys itself", async () => {
    seedBar({ status: "paused", server: "online" });
    mocks.runtime.armHandover.mockRejectedValueOnce(new HandoverConsentError("ai"));
    renderBar();
    openMenu(trigger("browser"));
    fireEvent.click(item("autopilot.quick.where.toServer"));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/books/book-1/autopilot#autopilot-where"));
    expect(useAutopilotStore.getState().whereIntent).toMatchObject({ bookId: "book-1", side: "server" });
    expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.quick.handover.consentTitle"), description: t("autopilot.quick.handover.consent.ai") });
  });

  it("says in a toast what went wrong for any other refusal", async () => {
    seedBar({ status: "paused", server: "online" });
    mocks.runtime.armHandover.mockRejectedValueOnce(new Error("The book is being synced with the server: wait until it is done."));
    renderBar();
    openMenu(trigger("browser"));
    fireEvent.click(item("autopilot.quick.where.toServer"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "The book is being synced with the server: wait until it is done.", variant: "destructive" })));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/books/book-1/autopilot");
    expect(screen.getByTestId("location")).not.toHaveTextContent("#");
  });
});

describe("a switch of the autopilot that is planned", () => {
  it("waits for the step in the status line, with a way to cancel it, and keeps the Where button out of the way", async () => {
    seedBar({ status: "running", running: true, server: "online", handover: { to: "server", when: "after-step", phase: "armed" } });
    renderBar();
    expect(within(status()).getByText(t("autopilot.quick.handover.armed.server"))).toBeVisible();
    const cancel = within(status()).getByRole("button", { name: name("autopilot.quick.handover.cancel.server") });
    expect(screen.getByRole("button", { name: /Runs on|Gira su/ })).toBeDisabled();
    expect(screen.getByText(t("autopilot.quick.where.planned"))).toBeVisible();
    fireEvent.click(cancel);
    await waitFor(() => expect(mocks.runtime.cancelHandover).toHaveBeenCalledWith("book-1"));
  });

  it("does not say the pause a second time: the switch that waits for the step is the reason of the pause after the step", () => {
    seedBar({ status: "running", running: true, server: "online", pausePending: "after-step", handover: { to: "server", when: "after-step", phase: "armed" } });
    renderBar();
    expect(within(status()).queryByText(t("autopilot.quick.status.pauseStep"))).not.toBeInTheDocument();
    expect(within(status()).getByText(t("autopilot.quick.handover.armed.server"))).toBeVisible();
  });

  it("still says the pause at the end of the chapter that the author asked for, next to the switch", () => {
    seedBar({ status: "running", running: true, server: "online", pausePending: "after-chapter", handover: { to: "server", when: "after-step", phase: "armed" } });
    renderBar();
    expect(within(status()).getByText(t("autopilot.quick.status.pauseChapter"))).toBeVisible();
  });

  it("says that one step goes there and the book comes back", () => {
    seedBar({ status: "running", running: true, server: "online", handover: { to: "server", when: "after-step", returnAfterSteps: 1, phase: "armed" } });
    renderBar();
    expect(within(status()).getByText(t("autopilot.quick.handover.armedReturn.server"))).toBeVisible();
  });

  it.each([
    ["pausing", "autopilot.quick.handover.pausing.server"],
    ["moving", "autopilot.quick.handover.moving.server"],
    ["starting", "autopilot.quick.handover.starting.server"],
    ["returning", "autopilot.quick.handover.returning.server"],
  ] as const)("says what it is doing while it is %s, and cannot be cancelled any more", (phase, key) => {
    seedBar({ status: "paused", server: "online", handover: { to: "server", when: "after-step", phase } });
    renderBar();
    expect(within(status()).getByText(t(key))).toBeVisible();
    expect(within(status()).queryByRole("button")).not.toBeInTheDocument();
  });

  it("says how many steps it runs on the other side", () => {
    seedBar({ status: "running", running: false, server: "online", handover: { to: "server", when: "after-step", returnAfterSteps: 2, phase: "running-there" } });
    renderBar();
    expect(within(status()).getByText(t("autopilot.quick.handover.runningThere.server", { count: 2 }))).toBeVisible();
  });

  it("says that it is done, and can be closed", async () => {
    seedBar({ status: "running", running: true, server: "online", handover: { to: "browser", when: "after-step", phase: "done" } });
    renderBar();
    expect(within(status()).getByText(t("autopilot.quick.handover.done.browser"))).toBeVisible();
    fireEvent.click(within(status()).getByRole("button", { name: name("autopilot.quick.handover.dismiss") }));
    await waitFor(() => expect(mocks.runtime.dismissHandover).toHaveBeenCalledWith("book-1"));
  });

  it("that failed is a chip and an alert with the reason, the book stopped where it was, and a way to the flow of “Where it runs”", async () => {
    seedBar({ status: "paused", server: "online", handover: { to: "server", when: "after-step", phase: "failed", error: "The server already has a different version of 1 file of this book." } });
    renderBar();
    // The chip says that it failed; the alert says why, and what to do: neither repeats the other.
    expect(within(status()).getByText(t("autopilot.quick.handover.failed.server"))).toBeVisible();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The server already has a different version of 1 file of this book.");
    expect(alert).toHaveTextContent(t("autopilot.quick.handover.failedHint"));
    expect(alert).not.toHaveTextContent(t("autopilot.quick.handover.failed.server"));
    fireEvent.click(within(alert).getByRole("button", { name: name("autopilot.quick.handover.openWhere") }));
    expect(screen.getByTestId("location")).toHaveTextContent("#autopilot-where");
    expect(useAutopilotStore.getState().whereIntent).toMatchObject({ bookId: "book-1", side: "server" });
    fireEvent.click(within(alert).getByRole("button", { name: name("autopilot.quick.handover.dismiss") }));
    await waitFor(() => expect(mocks.runtime.dismissHandover).toHaveBeenCalledWith("book-1"));
  });

  // A switch that fails once the book has moved (the autopilot could not start there, the way back failed) does not move it back: it says where the book is.
  it.each([
    { to: "server", host: "browser", stays: true },
    { to: "server", host: "server", stays: false },
    { to: "browser", host: "server", stays: true },
    { to: "browser", host: "browser", stays: false },
  ] as const)("that failed says where the book is: to the $to, with the book on the $host (stays where it was: $stays)", ({ to, host, stays }) => {
    seedBar({ book: { ...LOCAL_BOOK, ...(host === "server" ? { autopilotHost: "server" as const } : {}) }, status: "paused", server: "online", handover: { to, when: "after-step", phase: "failed", error: "The daily cap of this server is reached." } });
    renderBar();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The daily cap of this server is reached.");
    if (stays) {
      expect(alert).toHaveTextContent(t("autopilot.quick.handover.failedHint"));
      expect(alert).not.toHaveTextContent(t(`autopilot.quick.handover.failedHintMoved.${to}`));
    } else {
      expect(alert).toHaveTextContent(t(`autopilot.quick.handover.failedHintMoved.${to}`));
      expect(alert).not.toHaveTextContent(t("autopilot.quick.handover.failedHint"));
    }
  });
});

describe("what a person with a keyboard or a screen reader meets", () => {
  it("announces the status line politely, in one place, and nothing else in the bar is live", () => {
    seedBar({ status: "running", running: true, pausePending: "after-step", limits: { steps: 2, stepsDone: 0, chaptersDone: 0 } });
    renderBar();
    const live = [...group().querySelectorAll("[aria-live]")];
    expect(live).toEqual([status()]);
    expect(status()).toHaveAttribute("aria-live", "polite");
    expect(status()).toHaveAttribute("aria-atomic", "false");
  });

  it("does not touch the status line when the summaries that follow say the same: it is announced once for a change, not for every event", async () => {
    seedBar({ status: "running", running: true, pausePending: "after-step" });
    renderBar();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(status(), { subtree: true, childList: true, characterData: true, attributes: true });
    // A summary of the next step: more words written, the same pause waiting.
    act(() => {
      const summary = useAutopilotStore.getState().summaries["book-1"];
      useAutopilotStore.getState().ingest({ bookId: "book-1", at: T0, seq: 9, type: "state", state: { ...summary, progress: { ...summary.progress, words: 900 } } }, "The Glass Harbor");
    });
    await act(async () => { await Promise.resolve(); });
    observer.disconnect();
    expect(records).toEqual([]);
  });

  it("names every control it has with the book it commands, and no name is used twice", () => {
    seedBar({ book: GITHUB_BOOK, status: "running", running: true, server: "online", pausePending: "after-step", publish: "chapter", handover: { to: "server", when: "after-step", phase: "armed" } });
    renderBar();
    const controls = [...group().querySelectorAll("button, a[href]")].map((element) => element.getAttribute("aria-label") ?? "");
    expect(controls.length).toBeGreaterThanOrEqual(6);
    for (const label of controls) expect(label.endsWith(GITHUB_BOOK.name)).toBe(true);
    expect(new Set(controls).size).toBe(controls.length);
  });

  it("puts every control in the tab order, and a disabled one is not a trap: its reason is text on the screen", () => {
    seedBar({ book: GITHUB_BOOK, status: "paused", token: false, server: "none" });
    renderBar();
    for (const element of group().querySelectorAll("button:not(:disabled), a[href]")) expect((element as HTMLElement).tabIndex).toBeGreaterThanOrEqual(0);
    for (const element of group().querySelectorAll("button:disabled")) {
      const described = element.getAttribute("aria-describedby");
      expect(described, `${element.getAttribute("aria-label")} is disabled without a reason`).toBeTruthy();
      for (const id of described!.split(" ")) expect(document.getElementById(id)?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("opens a menu from the keyboard, moves through it with the arrows, and gives the focus back when it closes", async () => {
    seedBar({ status: "paused" });
    renderBar();
    const trigger = button("autopilot.quick.run.menu");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const first = await screen.findByRole("menuitem", { name: t("autopilot.quick.run.step") });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: t("autopilot.quick.run.chapter") })));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps the touch targets at least 32 px high and wraps instead of scrolling", () => {
    seedBar({ book: GITHUB_BOOK, status: "running", running: true, server: "online", publish: "step" });
    renderBar();
    for (const element of group().querySelectorAll("button")) expect(element.className, element.getAttribute("aria-label") ?? "").toMatch(/\bh-(8|9|10)\b|\bmin-h-/);
    expect(group().innerHTML).toMatch(/flex-wrap/);
    expect(group().innerHTML).not.toMatch(/overflow-x-(auto|scroll)/);
  });
});

describe("the commands that start the autopilot", () => {
  it("wait for an AI model when this browser would run without one, and say so next to them", () => {
    seedBar({ status: "paused" });
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, aiIntegrations: [] } });
    renderBar();
    const reason = screen.getByText(t("autopilot.quick.needsAi"));
    expect(button("autopilot.actions.resume")).toBeDisabled();
    expect(button("autopilot.actions.resume").getAttribute("aria-describedby")).toContain(reason.id);
    expect(button("autopilot.quick.run.menu")).toBeDisabled();
    expect(screen.getByRole("link", { name: t("settingsSection.aiIntegrationsTitle") })).toHaveAttribute("href", "/app/settings/ai-integrations");
  });

  it("do not wait for it when the server runs the book: it has its own", () => {
    seedBar({ book: { ...LOCAL_BOOK, autopilotHost: "server" }, status: "paused", server: "online" });
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, aiIntegrations: [] } });
    renderBar();
    expect(button("autopilot.actions.resume")).toBeEnabled();
    expect(screen.queryByText(t("autopilot.quick.needsAi"))).not.toBeInTheDocument();
  });

  it("are for a book that is completed too, on the page, where the author adds chapters instead of resuming; the live panel leaves it alone", () => {
    seedBar({ status: "completed" });
    const view = renderBar();
    // A book that is complete is not resumed: the main action is to add chapters, in the configuration (the plan is extended when the run starts again).
    expect(maybeButton("autopilot.actions.resume")).not.toBeInTheDocument();
    // Changed on purpose (the menu in groups): the configuration is a page of its own, with the number of chapters in front.
    expect(screen.getByRole("link", { name: name("autopilot.actions.addChapters") })).toHaveAttribute("href", "/app/books/book-1/autopilot/settings#autopilot-chapters");
    expect(maybeButton("autopilot.quick.run.menu")).not.toBeInTheDocument();
    view.unmount();
    renderBar("dock");
    expect(screen.queryByRole("button", { name: name("autopilot.actions.resume", "dock") })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: name("autopilot.actions.addChapters", "dock") })).not.toBeInTheDocument();
  });
});

describe("the bar in the live panel", () => {
  it("writes the name of the book it commands, and names its controls with the panel as well", () => {
    seedBar({ status: "paused" });
    renderBar("dock");
    expect(within(screen.getByRole("group", { name: quickGroupName("dock") })).getByText(LOCAL_BOOK.name)).toBeVisible();
    expect(button("autopilot.actions.resume", "dock")).toBeEnabled();
  });

  it("does not write the name twice when whoever shows it asks it not to", () => {
    seedBar({ status: "paused" });
    render(<MemoryRouter><QuickCommands bookId="book-1" variant="dock" heading={null} /></MemoryRouter>);
    expect(within(screen.getByRole("group", { name: quickGroupName("dock") })).queryByText(LOCAL_BOOK.name)).not.toBeInTheDocument();
  });

  it("shows what it is given in place of the name", () => {
    seedBar({ status: "paused" });
    render(<MemoryRouter><QuickCommands bookId="book-1" variant="dock" heading={<span>Chosen heading</span>} /></MemoryRouter>);
    expect(screen.getByText("Chosen heading")).toBeVisible();
    expect(screen.queryByText(LOCAL_BOOK.name)).not.toBeInTheDocument();
  });
});

describe("the bar for a place that is short of room (condensed)", () => {
  function renderCondensed(variant: "page" | "dock" = "page") {
    return render(
      <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
        <Routes><Route path="*" element={<QuickCommands bookId="book-1" variant={variant} condensed />} /></Routes>
      </MemoryRouter>,
    );
  }
  const where = () => screen.queryByRole("button", { name: name("autopilot.quick.where.label") }) ?? screen.queryByRole("button", { name: new RegExp(`^${t("autopilot.quick.where.label", { host: "" }).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").trim()}`) });

  it("keeps the main action, and puts where the book is published and where it runs behind “More”", () => {
    seedBar({ book: GITHUB_BOOK, status: "paused", server: "online", publish: "step" });
    renderCondensed();
    expect(button("autopilot.actions.resume")).toBeEnabled();
    const more = button("autopilot.quick.more");
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(within(group()).queryByRole("button", { name: new RegExp(`^${quickName(t("autopilot.quick.publish.label", { mode: "" }).trim(), "page", GITHUB_BOOK).split(" — ")[0]}`) })).not.toBeInTheDocument();
    expect(where()).not.toBeInTheDocument();

    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(more.getAttribute("aria-controls")).toBeTruthy();
    expect(document.getElementById(more.getAttribute("aria-controls")!)).toContainElement(where());
    expect(within(group()).getAllByRole("button", { name: /GitHub:/ })).toHaveLength(1);

    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(where()).not.toBeInTheDocument();
  });

  it("keeps the pending things in sight: a pause that waits, a switch that is planned", () => {
    seedBar({ status: "running", running: true, pausePending: "after-chapter", handover: { to: "server", when: "after-step", phase: "armed" }, server: "online" });
    renderCondensed();
    expect(within(status()).getByText(t("autopilot.quick.status.pauseChapter"))).toBeInTheDocument();
    expect(within(status()).getByText(t("autopilot.quick.handover.armed.server"))).toBeInTheDocument();
  });

  it("is the full bar when nothing asks for less: no “More”", () => {
    seedBar({ status: "paused", server: "online" });
    renderBar();
    expect(maybeButton("autopilot.quick.more")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(`^${t("autopilot.quick.where.label", { host: "" }).trim()}`) })).toBeInTheDocument();
  });

  it("names the button after the bar it belongs to, like every other control", () => {
    seedBar({ status: "paused" });
    renderCondensed("dock");
    expect(screen.getByRole("button", { name: quickName(t("autopilot.quick.more"), "dock") })).toBeInTheDocument();
  });
});

describe("the main action of a run that stopped with an error", () => {
  it("is Retry, which resumes: the autopilot repeats the step that stopped", async () => {
    seedBar({ status: "error", statePatch: { lastError: { message: "The provider failed.", at: T0, task: "write" } } });
    renderBar();
    expect(maybeButton("autopilot.actions.resume")).not.toBeInTheDocument();
    fireEvent.click(button("autopilot.actions.retry"));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
  });

  it("says it in Italian", async () => {
    await i18n.changeLanguage("it");
    seedBar({ status: "error", statePatch: { lastError: { message: "Il provider non ha risposto.", at: T0, task: "write" } } });
    renderBar();
    expect(screen.getByRole("button", { name: "Riprova — The Glass Harbor" })).toBeInTheDocument();
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_VERSION, summarizeAutopilotState, type AutopilotActivity, type AutopilotErrorDetail, type AutopilotErrorKind, type AutopilotEvent, type AutopilotStateSummary } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { ErrorPanel } from "@/components/autopilot/ErrorPanel";
import { APP_VERSION } from "@/config/version";
import { useAutopilotStore, type FeedEntry } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { activityOf, seedRun } from "./helpers/autopilotBand";
import { LOCAL_BOOK, T0, makeRuntime, quickName, t } from "./helpers/quickCommands";

const MS = Date.parse(T0);
const at = (seconds: number) => new Date(MS + seconds * 1000).toISOString();
const DETAIL: AutopilotErrorDetail = { endpoint: "https://api.openai.com", model: "gpt-4.1", provider: "openai", integration: "mock", status: 429, attempt: 3, retries: 3 };

/** The attempts of one step that failed in a row, the way the engine leaves them in the log. */
function attempts(count: number, patch: Partial<AutopilotActivity> = {}): AutopilotActivity[] {
  return Array.from({ length: count }, (_, index) => activityOf("write", { id: `try-${index}`, title: "Writing scene 2 of chapter 5 «Scene 2»", chapterNumber: 5, sceneNumber: 2, status: "failed", error: "Connection error.", startedAt: at(index * 40), endedAt: at(index * 40 + 10), ...patch }));
}

interface Failure {
  kind?: AutopilotErrorKind;
  message?: string;
  detail?: AutopilotErrorDetail;
  count?: number;
  /** The summary the state events carry has the retry that waits. */
  retry?: { at: string; attempt: number; retries: number };
  statePatch?: Record<string, unknown>;
}

/** A run that stopped on an error (or, with `retry`, one that waits to try a failed step again): what the page and the panel read, in one call. */
function failing({ kind, message = "Connection error.", detail = DETAIL, count = 1, retry, statePatch }: Failure = {}) {
  const log = attempts(count, { error: message, ...(kind ? { errorKind: kind, errorDetail: detail } : {}) });
  const last = log[log.length - 1];
  return seedRun({
    status: retry ? "running" : "error",
    running: Boolean(retry),
    activities: log,
    retry,
    statePatch: retry ? statePatch : { lastError: { message, at: last.endedAt as string, task: "write", ...(kind ? { errorKind: kind, errorDetail: detail } : {}) }, ...statePatch },
  });
}

const panel = () => document.querySelector<HTMLElement>("[data-autopilot-error]");
const alerts = () => screen.queryAllByRole("alert");
const title = (kind: AutopilotErrorKind) => t(`autopilot.failure.kind.${kind}.title`);
const fact = (label: string) => within(panel() as HTMLElement).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
const KINDS: AutopilotErrorKind[] = ["network", "auth", "rate_limit", "timeout", "truncated", "refused", "conflict", "budget", "limit", "profile", "provider", "unknown"];

function show() {
  return render(<MemoryRouter><ErrorPanel bookId="book-1" /></MemoryRouter>);
}

const stateEvent = (state: AutopilotStateSummary, seq: number) => ({ bookId: "book-1", at: state.updatedAt, seq, type: "state", state }) as AutopilotEvent;
const currentSummary = () => useAutopilotStore.getState().summaries["book-1"];

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("when there is nothing wrong", () => {
  it.each(["running", "paused", "completed", "waiting-author", "idle"] as const)("is not there while the book is %s", (status) => {
    seedRun({ status });
    const view = show();
    expect(panel()).toBeNull();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("is not there for a book that has no autopilot yet", () => {
    seedRun({ noState: true });
    show();
    expect(panel()).toBeNull();
  });

  it("does not look at the feed of events of a book that has nothing wrong: it is read only when there is a failure to tell", () => {
    seedRun({ status: "running", running: true });
    const trap = { bookTitle: "The Glass Harbor", get event(): never { throw new Error("the feed was read"); } } as unknown as FeedEntry;
    useAutopilotStore.setState({ feed: [trap] });
    expect(() => show()).not.toThrow();
    expect(panel()).toBeNull();
  });
});

describe("a run that stopped on an error", () => {
  it("is one panel with one alert: the title of what went wrong and what it means, the words of the provider kept for who wants them", () => {
    failing({ kind: "network", count: 4, detail: { ...DETAIL, status: undefined } });
    show();
    expect(panel()).not.toBeNull();
    expect(alerts()).toHaveLength(1);
    const alert = alerts()[0];
    expect(within(alert).getByRole("heading", { level: 2, name: title("network") })).toBeInTheDocument();
    expect(alert).toHaveTextContent(t("autopilot.failure.kind.network.explain"));
    expect(panel()?.getAttribute("aria-labelledby")).toBe(within(alert).getByRole("heading", { level: 2 }).id);
    const details = within(panel() as HTMLElement).getByText(t("autopilot.failure.actions.details"));
    expect(details.closest("details")).not.toHaveAttribute("open");
    expect(within(details.closest("details") as HTMLElement).getByText("Connection error.")).toBeInTheDocument();
  });

  it("says a failure that happened four times in a row once, with the count: the same words are not written four times", () => {
    failing({ kind: "network", count: 4 });
    show();
    expect(screen.getAllByText("Connection error.")).toHaveLength(1);
    expect(within(panel() as HTMLElement).getByText(t("autopilot.failure.repeats", { count: 4 }))).toBeInTheDocument();
  });

  it("does not talk of repeating a failure that happened once", () => {
    failing({ kind: "auth", count: 1, message: "401 Unauthorized", detail: { status: 401 } });
    show();
    expect(within(panel() as HTMLElement).queryByText(/in a row/)).not.toBeInTheDocument();
  });

  it("says where it happened: the step, the endpoint, the model, the provider, the integration by its name, the status and which retry", () => {
    failing({ kind: "rate_limit", count: 2, message: "429 Rate limit reached" });
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, aiIntegrations: [{ id: "mock", name: "OpenAI (work)" } as never] } }));
    show();
    // The step is named by its kind and its chapter: its title is in the history, right under the panel, and is not said twice.
    expect(fact(t("autopilot.failure.facts.step"))).toHaveTextContent(t("autopilot.task.write", { number: 5 }));
    expect(fact(t("autopilot.failure.facts.endpoint"))).toHaveTextContent("https://api.openai.com");
    expect(fact(t("autopilot.failure.facts.model"))).toHaveTextContent("gpt-4.1");
    expect(fact(t("autopilot.failure.facts.provider"))).toHaveTextContent("openai");
    expect(fact(t("autopilot.failure.facts.integration"))).toHaveTextContent("OpenAI (work)");
    expect(fact(t("autopilot.failure.facts.status"))).toHaveTextContent("429");
    expect(fact(t("autopilot.failure.facts.attempt"))).toHaveTextContent(t("autopilot.failure.facts.attemptOf", { attempt: 3, retries: 3 }));
  });

  it("names the integration by its id when this browser does not have it (a run on the server may use one it does not)", () => {
    failing({ kind: "network" });
    show();
    expect(fact(t("autopilot.failure.facts.integration"))).toHaveTextContent("mock");
  });

  it("says nothing of what the engine did not say: no empty line, no zero", () => {
    failing({ kind: "auth", message: "401 Unauthorized", detail: { status: 401 } });
    show();
    const labels = [...(panel() as HTMLElement).querySelectorAll("dt")].map((item) => item.textContent);
    expect(labels).toEqual([t("autopilot.failure.facts.step"), t("autopilot.failure.facts.status")]);
  });

  it.each(KINDS)("has a title and an explanation for a failure of kind %s", (kind) => {
    failing({ kind, message: "Something went wrong" });
    show();
    expect(alerts()).toHaveLength(1);
    expect(within(alerts()[0]).getByRole("heading", { level: 2, name: title(kind) })).toBeInTheDocument();
    expect(alerts()[0]).toHaveTextContent(t(`autopilot.failure.kind.${kind}.explain`));
    expect(panel()?.getAttribute("data-kind")).toBe(kind);
  });

  it("is made once: the same words heard again are not announced again, and the element stays", async () => {
    failing({ kind: "network", count: 4 });
    show();
    const [alert] = alerts();
    for (let step = 1; step <= 5; step += 1) await act(async () => { useAutopilotStore.getState().ingest(stateEvent({ ...currentSummary(), updatedAt: at(100 + step) }, step), "The Glass Harbor"); });
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toBe(alert);
  });
});

describe("a log that has not caught up with the events", () => {
  it("finds the step that failed, and how many times, in the events the page heard, when the log of the steps does not have them yet", () => {
    const log = attempts(3);
    seedRun({
      status: "error",
      activities: [],
      feed: log.map((activity, index) => ({ bookId: "book-1", at: activity.endedAt as string, seq: index + 1, type: "task-finished", activity }) as AutopilotEvent),
      statePatch: { lastError: { message: "Connection error.", at: log[2].endedAt as string, task: "write", errorKind: "network", errorDetail: DETAIL } },
    });
    show();
    expect(fact(t("autopilot.failure.facts.step"))).toHaveTextContent(t("autopilot.task.write", { number: 5 }));
    expect(within(panel() as HTMLElement).getByText(t("autopilot.failure.repeats", { count: 3 }))).toBeInTheDocument();
  });

  it("does not take the events of another book for its own", () => {
    const log = attempts(3);
    seedRun({
      status: "error",
      activities: [],
      feed: log.map((activity, index) => ({ bookId: "book-2", at: activity.endedAt as string, seq: index + 1, type: "task-finished", activity }) as AutopilotEvent),
      statePatch: { lastError: { message: "Connection error.", at: log[2].endedAt as string, task: "write", errorKind: "network", errorDetail: DETAIL } },
    });
    show();
    expect(within(panel() as HTMLElement).queryByText(/in a row/)).not.toBeInTheDocument();
  });
});

describe("the title of each kind, in the words of the app", () => {
  it.each([
    ["network", "Problema di connessione"], ["auth", "Accesso rifiutato dal provider"], ["rate_limit", "Troppe richieste"], ["timeout", "Risposta troppo lenta"],
    ["truncated", "Risposta troncata dal limite di output"], ["refused", "Il provider ha rifiutato la richiesta"], ["conflict", "Il libro è cambiato altrove"], ["budget", "Budget raggiunto"],
    ["limit", "Limite raggiunto"], ["profile", "Un file del profilo ha problemi"], ["provider", "Errore del provider"], ["unknown", "Errore"],
  ] as const)("says %s in Italian: %s", async (kind, words) => {
    await i18n.changeLanguage("it");
    failing({ kind });
    show();
    expect(within(alerts()[0]).getByRole("heading", { level: 2 })).toHaveTextContent(words);
    expect(i18n.t(`autopilot.failure.kind.${kind}.explain`)).not.toBe(i18n.t(`autopilot.failure.kind.${kind}.explain`, { lng: "en" }));
  });

  it("says the places, the buttons and the count of the repeats in Italian", async () => {
    await i18n.changeLanguage("it");
    failing({ kind: "network", count: 4 });
    show();
    expect(screen.getByText("Non è riuscito 4 volte di fila.")).toBeInTheDocument();
    expect(screen.getByText("Passo", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("Indirizzo", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("Integrazione", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Riprova ora/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Apri le integrazioni AI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copia la diagnostica" })).toBeInTheDocument();
    expect(screen.getByText("Dettagli tecnici")).toBeInTheDocument();
  });
});

describe("a failure the engine did not classify (a state that an older engine wrote)", () => {
  it("is an error, with the words as they were, once, in the alert: they are all there is to tell it by", () => {
    failing({ message: "Too many steps in one run." });
    show();
    expect(alerts()).toHaveLength(1);
    expect(within(alerts()[0]).getByRole("heading", { level: 2, name: title("unknown") })).toBeInTheDocument();
    expect(alerts()[0]).toHaveTextContent(t("autopilot.lastError"));
    expect(alerts()[0]).toHaveTextContent("Too many steps in one run.");
    expect(screen.getAllByText(/Too many steps in one run\./)).toHaveLength(1);
  });

  it("has no places to name but the step, and no count to give", () => {
    failing({ message: "Too many steps in one run." });
    show();
    expect([...(panel() as HTMLElement).querySelectorAll("dt")].map((item) => item.textContent)).toEqual([t("autopilot.failure.facts.step")]);
  });

  it("is a problem with a file when the words are the refusal to rewrite one whose front matter cannot be read, with the way to open it and what to do", () => {
    const message = "The frontmatter of chapters/001-the-arrival/chapter.md (line 4: a mapping is not allowed here) cannot be read: the autopilot will not rewrite it.";
    failing({ message });
    show();
    expect(panel()?.getAttribute("data-kind")).toBe("profile");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toHaveTextContent(message);
    const link = screen.getByRole("link", { name: t("autopilot.fileError.openFileNamed", { path: "chapters/001-the-arrival/chapter.md" }) });
    expect(link).toHaveAttribute("href", "/app/books/book-1/chapters/001-the-arrival");
    expect(screen.getByText(t("autopilot.fileError.hint"))).toBeInTheDocument();
  });
});

describe("a conflict", () => {
  const message = "The book changed while the step was running: chapters/005-chapter-5/002-scene-2.md was edited somewhere else, and the retries are used up.";

  it("offers to open the file it names, when the site has a page for it, and not to change the integrations: they are not what is wrong", () => {
    failing({ kind: "conflict", message, detail: {} });
    show();
    expect(screen.getByRole("link", { name: t("autopilot.fileError.openFileNamed", { path: "chapters/005-chapter-5/002-scene-2.md" }) })).toHaveAttribute("href", "/app/books/book-1/chapters/005-chapter-5/paragraphs/002");
    expect(screen.queryByRole("link", { name: t("autopilot.failure.actions.integrations") })).not.toBeInTheDocument();
  });

  it("has no link when no file is named", () => {
    failing({ kind: "conflict", message: "The book changed while the step was running.", detail: {} });
    show();
    expect(screen.queryByRole("link", { name: new RegExp(t("autopilot.fileError.openFile")) })).not.toBeInTheDocument();
  });
});

describe("what can be done", () => {
  it("is to retry, to open the integrations and to copy what a person asks for, for a failure of the provider", () => {
    failing({ kind: "network" });
    show();
    expect(screen.getByRole("button", { name: quickName(t("autopilot.failure.actions.retry")) })).toBeEnabled();
    expect(screen.getByRole("link", { name: t("autopilot.failure.actions.integrations") })).toHaveAttribute("href", "/app/settings/ai-integrations");
    expect(screen.getByRole("button", { name: t("autopilot.failure.actions.copy") })).toBeEnabled();
  });

  it.each(["network", "auth", "rate_limit", "timeout", "truncated", "refused", "budget", "limit", "provider"] as const)("includes the integrations for a failure of kind %s", (kind) => {
    failing({ kind });
    show();
    expect(screen.getByRole("link", { name: t("autopilot.failure.actions.integrations") })).toBeInTheDocument();
  });

  it.each(["conflict", "profile", "unknown"] as const)("leaves out the integrations for a failure of kind %s", (kind) => {
    failing({ kind });
    show();
    expect(screen.queryByRole("link", { name: t("autopilot.failure.actions.integrations") })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: quickName(t("autopilot.failure.actions.retry")) })).toBeInTheDocument();
  });

  it("retries as the band does, with the same command that resumes", async () => {
    failing({ kind: "network" });
    show();
    fireEvent.click(screen.getByRole("button", { name: quickName(t("autopilot.failure.actions.retry")) }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
  });

  it("does not offer to retry what the runner is about to retry by itself", () => {
    failing({ kind: "rate_limit", count: 2, retry: { at: at(36), attempt: 2, retries: 3 } });
    show();
    expect(screen.queryByRole("button", { name: quickName(t("autopilot.failure.actions.retry")) })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("autopilot.failure.actions.integrations") })).toBeInTheDocument();
  });

  it("has a name for each button that no other button on the page has: the retry says which book", () => {
    failing({ kind: "network" });
    show();
    expect(screen.getByRole("button", { name: `${t("autopilot.failure.actions.retry")} — ${LOCAL_BOOK.name}` })).toBeInTheDocument();
  });

  it("does not offer to retry in a browser that has no AI model to retry with, and says where to put one", () => {
    failing({ kind: "network" });
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, aiIntegrations: [] } }));
    show();
    expect(screen.getByRole("button", { name: quickName(t("autopilot.failure.actions.retry")) })).toBeDisabled();
    expect(screen.getByRole("link", { name: t("autopilot.failure.actions.integrations") })).toBeInTheDocument();
  });
});

describe("the diagnostics", () => {
  const clipboard = () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  };

  it("are copied as short text with the category, where it happened, what it said, the versions of the app and of the engine and the time, and a message says so", async () => {
    const writeText = clipboard();
    failing({ kind: "rate_limit", count: 2, message: "429 Rate limit reached" });
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, aiIntegrations: [{ id: "mock", name: "OpenAI (work)" } as never] } }));
    show();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.failure.actions.copy") }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    for (const line of ["Narrarium autopilot diagnostics", `App: ${APP_VERSION}`, `Engine: ${ENGINE_VERSION}`, "Problem: rate_limit", "HTTP status: 429", "Endpoint: https://api.openai.com", "Model: gpt-4.1", "Integration: OpenAI (work) (mock)", "Retry: 3 of 3", "Message: 429 Rate limit reached"]) expect(text, line).toContain(line);
    expect(text).toMatch(/Time: \d{4}-\d{2}-\d{2}T/);
    const confirmation = await screen.findByText(t("autopilot.failure.actions.copied"));
    expect(confirmation.closest("[role='status']"), "the confirmation is a status: it is read out, politely").not.toBeNull();
  });

  it("have no key in them, however the message wrote it", async () => {
    const writeText = clipboard();
    failing({ kind: "auth", message: "401 Incorrect API key provided: sk-abcdefghijklmnopqrstuvwx. Authorization: Bearer abcdef123456789", detail: { status: 401 } });
    show();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.failure.actions.copy") }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect((writeText.mock.calls[0] as unknown as [string])[0]).not.toMatch(/sk-abcdefghijkl|abcdef123456789/);
  });

  it("say so when the browser did not allow the copy, and do not say they were copied", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => { throw new Error("denied"); }) }, configurable: true });
    failing({ kind: "network" });
    show();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.failure.actions.copy") }));
    expect(await screen.findByText(t("autopilot.failure.actions.copyFailed"))).toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.failure.actions.copied"))).not.toBeInTheDocument();
  });

  it("are no longer said to be copied when the failure is another one: the confirmation is of the text that was copied", async () => {
    clipboard();
    failing({ kind: "network" });
    show();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.failure.actions.copy") }));
    expect(await screen.findByText(t("autopilot.failure.actions.copied"))).toBeInTheDocument();
    await act(async () => { useAutopilotStore.getState().ingest(stateEvent({ ...currentSummary(), updatedAt: at(500), lastError: { message: "429 Rate limit reached", at: at(500), task: "write", kind: "rate_limit", errorKind: "rate_limit" } }, 9), "The Glass Harbor"); });
    expect(within(alerts()[0]).getByRole("heading", { level: 2, name: title("rate_limit") })).toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.failure.actions.copied"))).not.toBeInTheDocument();
  });

  it("do not come back with a panel that returns later: a failure after a run that went well starts without a confirmation", async () => {
    clipboard();
    failing({ kind: "network" });
    show();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.failure.actions.copy") }));
    expect(await screen.findByText(t("autopilot.failure.actions.copied"))).toBeInTheDocument();
    await act(async () => { useAutopilotStore.getState().ingest(stateEvent({ ...currentSummary(), status: "running", lastError: null, updatedAt: at(300) }, 5), "The Glass Harbor"); });
    expect(panel()).toBeNull();
    await act(async () => { useAutopilotStore.getState().ingest(stateEvent({ ...currentSummary(), status: "error", updatedAt: at(600), lastError: { message: "Connection error.", at: at(600), task: "write", kind: "network", errorKind: "network" } }, 6), "The Glass Harbor"); });
    expect(panel()).not.toBeNull();
    expect(screen.queryByText(t("autopilot.failure.actions.copied"))).not.toBeInTheDocument();
  });

  it("say so when the browser has no clipboard at all", async () => {
    failing({ kind: "network" });
    show();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.failure.actions.copy") }));
    expect(await screen.findByText(t("autopilot.failure.actions.copyFailed"))).toBeInTheDocument();
  });
});

describe("the focus when the panel goes away", () => {
  /** The band is right above the panel on the page: it has a name and can be given the focus by the program, and nothing else about it matters here. */
  const withBand = () => render(<MemoryRouter><button type="button">elsewhere</button><section data-autopilot-band tabIndex={-1} aria-label="band" /><ErrorPanel bookId="book-1" /></MemoryRouter>);
  const withdraw = async () => {
    const without = { ...currentSummary() };
    delete without.retry;
    await act(async () => { useAutopilotStore.getState().ingest(stateEvent({ ...without, updatedAt: currentSummary().updatedAt }, 1), "The Glass Harbor"); });
  };
  const waiting = () => failing({ kind: "rate_limit", count: 2, message: "429 Rate limit reached", retry: { at: at(36), attempt: 2, retries: 3 } });

  it("goes to the band, right above, when the panel is gone with the focus in it: it is not lost to the page", async () => {
    waiting();
    withBand();
    screen.getByRole("button", { name: t("autopilot.failure.actions.copy") }).focus();
    expect(panel()?.contains(document.activeElement)).toBe(true);
    await withdraw();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("[data-autopilot-band]"));
  });

  it("is the same when the run goes on after a retry the author asked for: the button that had the focus is gone", async () => {
    failing({ kind: "network" });
    withBand();
    screen.getByRole("button", { name: quickName(t("autopilot.failure.actions.retry")) }).focus();
    act(() => useAutopilotStore.setState((state) => ({ summaries: { ...state.summaries, "book-1": { ...state.summaries["book-1"], status: "running", lastError: null } } })));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("[data-autopilot-band]"));
  });

  it("leaves the focus where it is when it was somewhere else: the panel does not take it", async () => {
    waiting();
    withBand();
    const elsewhere = screen.getByRole("button", { name: "elsewhere" });
    elsewhere.focus();
    await withdraw();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("does nothing when the panel is not there at all, or when the page has no band", async () => {
    waiting();
    render(<MemoryRouter><ErrorPanel bookId="book-1" /></MemoryRouter>);
    screen.getByRole("button", { name: t("autopilot.failure.actions.copy") }).focus();
    await expect(withdraw()).resolves.toBeUndefined();
    expect(panel()).toBeNull();
  });
});

describe("a failure the runner is going to try again", () => {
  const retrying = (seconds = 36, patch: Failure = {}) => failing({ kind: "rate_limit", count: 2, message: "429 Rate limit reached", retry: { at: at(seconds), attempt: 2, retries: 3 }, ...patch });
  const timer = () => within(panel() as HTMLElement).getByRole("timer");
  const announcement = () => document.querySelector<HTMLElement>("[data-error-announcement]") as HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
  });

  it("is the same panel, with the countdown in it: when the next attempt is, in words", () => {
    retrying();
    show();
    expect(alerts()).toHaveLength(1);
    expect(within(alerts()[0]).getByRole("heading", { level: 2, name: title("rate_limit") })).toBeInTheDocument();
    expect(timer()).toHaveTextContent(t("autopilot.failure.countdown.in", { time: "36 s" }));
    expect(fact(t("autopilot.failure.facts.attempt"))).toHaveTextContent(t("autopilot.failure.facts.attemptOf", { attempt: 3, retries: 3 }));
  });

  it("goes down every second, in a timer that is not announced, and the alert does not change with it", () => {
    retrying();
    show();
    const [alert] = alerts();
    const before = alert.textContent;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(timer()).toHaveTextContent(t("autopilot.failure.countdown.in", { time: "35 s" }));
    act(() => { vi.advanceTimersByTime(4000); });
    expect(timer()).toHaveTextContent(t("autopilot.failure.countdown.in", { time: "31 s" }));
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toBe(alert);
    expect(alert.textContent).toBe(before);
    expect(timer().closest("[role='alert']"), "the countdown is not inside the alert: it would be read out at every tick").toBeNull();
    expect(timer().closest("[aria-live]")).toBeNull();
    expect(timer().hasAttribute("aria-live")).toBe(false);
  });

  it("counts from the moment the engine says, not from the moment the panel is drawn: a person who comes to the page in the middle of the wait sees what is left", () => {
    retrying(36);
    vi.setSystemTime(new Date(MS + 12_000));
    show();
    expect(timer()).toHaveTextContent(t("autopilot.failure.countdown.in", { time: "24 s" }));
  });

  it("writes a wait of more than a minute with the minutes", () => {
    retrying(272);
    show();
    expect(timer()).toHaveTextContent(t("autopilot.failure.countdown.in", { time: "4 min 32 s" }));
  });

  it("says only when it begins and when it ends, in a status that is read out politely, and nothing between", () => {
    retrying();
    show();
    expect(announcement()).toHaveAttribute("role", "status");
    expect(announcement()).toHaveTextContent(t("autopilot.failure.countdown.announceStart", { time: "36 s" }));
    for (let second = 1; second <= 35; second += 1) {
      act(() => { vi.advanceTimersByTime(1000); });
      expect(announcement().textContent, `after ${second} s`).toBe(t("autopilot.failure.countdown.announceStart", { time: "36 s" }));
    }
    act(() => { vi.advanceTimersByTime(1000); });
    expect(timer()).toHaveTextContent(t("autopilot.failure.countdown.now"));
    expect(announcement()).toHaveTextContent(t("autopilot.failure.countdown.announceNow"));
  });

  it("has no live region but the alert, the announcement of the countdown and the confirmation of the copy: the timer, the facts and the words are not live", () => {
    retrying();
    show();
    const live = (panel() as HTMLElement).querySelectorAll("[aria-live], [role='status'], [role='alert'], [role='log']");
    expect([...live].map((element) => element.getAttribute("role") ?? element.getAttribute("aria-live")).sort()).toEqual(["alert", "status", "status"]);
    expect(live.length).toBe((panel() as HTMLElement).querySelectorAll("[role='alert'], [role='status']").length);
  });

  it("holds at 'trying again now' when the time has come and the engine has not said yet: it never goes below zero", () => {
    retrying();
    show();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(timer()).toHaveTextContent(t("autopilot.failure.countdown.now"));
    expect(timer().textContent).not.toMatch(/-/);
  });

  it("withdraws when the attempt begins: the next summary of the engine has no retry in it, and the panel is gone", async () => {
    retrying();
    show();
    expect(panel()).not.toBeNull();
    const without = { ...currentSummary() };
    delete without.retry;
    await act(async () => { useAutopilotStore.getState().ingest(stateEvent({ ...without, updatedAt: currentSummary().updatedAt }, 1), "The Glass Harbor"); });
    expect(panel()).toBeNull();
    expect(alerts()).toHaveLength(0);
  });

  it("is there again, with a new count, when the next attempt fails too, and is the same alert if the words are the same", async () => {
    retrying(36);
    show();
    const [alert] = alerts();
    const next = { ...currentSummary(), retry: { at: at(100), attempt: 3, retries: 3 } };
    await act(async () => { useAutopilotStore.getState().ingest(stateEvent(next, 2), "The Glass Harbor"); });
    expect(timer()).toHaveTextContent(t("autopilot.failure.countdown.in", { time: "1 min 40 s" }));
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toBe(alert);
    expect(announcement()).toHaveTextContent(t("autopilot.failure.countdown.announceStart", { time: "1 min 40 s" }));
  });

  it("does not stop for a run that was paused in the middle of the wait: a retry is only a retry while the run runs", async () => {
    retrying();
    show();
    const paused = { ...summarizeAutopilotState({ ...useAutopilotStore.getState().views["book-1"].snapshot!.state!, status: "paused" }), retry: currentSummary().retry };
    await act(async () => { useAutopilotStore.getState().ingest(stateEvent({ ...paused, updatedAt: currentSummary().updatedAt }, 3), "The Glass Harbor"); });
    expect(panel()).toBeNull();
  });

  it("says in Italian that it will try again, and how long it waits", async () => {
    await i18n.changeLanguage("it");
    retrying();
    show();
    expect(timer()).toHaveTextContent("Nuovo tentativo tra 36 s");
    expect(announcement()).toHaveTextContent("Il prossimo tentativo parte tra 36 s.");
    act(() => { vi.advanceTimersByTime(36_000); });
    expect(announcement()).toHaveTextContent("Nuovo tentativo in corso.");
  });

  it("is told for a failure of any kind that is retried, with what the log says of it when the summary does not say it", () => {
    failing({ kind: "network", count: 1, message: "Connection error.", retry: { at: at(12), attempt: 1, retries: 3 } });
    show();
    expect(within(alerts()[0]).getByRole("heading", { level: 2, name: title("network") })).toBeInTheDocument();
    expect(timer()).toHaveTextContent(t("autopilot.failure.countdown.in", { time: "12 s" }));
  });
});

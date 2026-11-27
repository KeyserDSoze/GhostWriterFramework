import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAiCallStore, type AiCallStore } from "narrarium-engine";

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import TaskCalls from "@/components/autopilot/calls/TaskCalls";
import { LiveAnnouncer } from "@/components/autopilot/live/LiveControls";
import { localCallsSource } from "@/autopilot/calls/sourceLocal";
import { provideCallsSources } from "@/autopilot/calls/sourceHook";
import { unavailableCallsSource, type CallsSource } from "@/autopilot/calls/source";
import { useCallsView } from "@/components/autopilot/calls/callsView";
import { callElementId } from "@/components/autopilot/calls/anchors";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { openMenu, polyfillRadix } from "./helpers/radix";
import { BOOK, STEP, at, attemptOf, beginRecord, endOf, recordCall, saveTask, storeAsSource } from "./helpers/aiCalls";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const clipboard = { writeText: vi.fn(async (_text: string) => undefined) };

beforeAll(async () => {
  polyfillRadix();
  await loadAutopilotTranslations();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  clipboard.writeText.mockReset();
  clipboard.writeText.mockImplementation(async () => undefined);
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  provideCallsSources(null);
  useCallsView.setState({ raw: false, open: {}, live: {}, epoch: 0 });
  useAutopilotStore.setState({ live: {} });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

const announce = vi.fn();

function View({ running = false, activityIds = [STEP], hash = "" }: { running?: boolean; activityIds?: string[]; hash?: string }) {
  return (
    <MemoryRouter initialEntries={[`/app/books/${BOOK}/autopilot${hash}`]}>
      <TaskCalls bookId={BOOK} activityIds={activityIds} running={running} announce={announce} />
    </MemoryRouter>
  );
}

const callOf = (seq: number) => document.querySelector<HTMLElement>(`[data-call$="-${String(seq).padStart(4, "0")}"]`) as HTMLElement;
const headerOf = (seq: number) => within(callOf(seq)).getAllByRole("button")[0];
const paneOf = (seq: number, field: "system" | "user" | "response") => callOf(seq).querySelector<HTMLElement>(`[data-call-pane="${field}"]`) as HTMLElement;
const regionOf = (seq: number, field: "system" | "user" | "response") => within(paneOf(seq, field)).getByRole("region");
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("a call, in words", () => {
  it("has a header that says what it asked, the model, how it went, how long, what it received and its attempts; the last call of the step is open", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP, { seq: 1, label: "Plan the scene", texts: ["A plan."] });
    await recordCall(store, STEP, { seq: 2, label: "Write the scene", texts: ["Half of it", "The keeper climbed the stairs."] });
    await saveTask(store, STEP);
    render(<View />);
    await screen.findByText("The keeper climbed the stairs.");
    expect(headerOf(1)).toHaveAttribute("aria-expanded", "false");
    expect(headerOf(2)).toHaveAttribute("aria-expanded", "true");
    expect(headerOf(2)).toHaveTextContent(/^Write the scene/);
    expect(headerOf(2)).toHaveTextContent("gpt-5 · done · 42s · 30 B received · 2 attempts");
    expect(headerOf(1)).toHaveTextContent("gpt-5 · done · 42s · 7 B received");
    // The summary of the step: its calls and what they keep.
    expect(document.querySelector("[data-call-task]")).toHaveTextContent(/2 calls · \d+ B/);
  });

  it("lists its facts: what it asked and for what, the model, the times, what it sent and received, the tokens and the cost", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP, { label: "Write the scene", texts: ["Città di vetro"] });
    render(<View />);
    await screen.findByText("Città di vetro");
    const facts = Object.fromEntries([...callOf(1).querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]));
    expect(facts).toMatchObject({
      Asked: "Write the scene",
      For: t("settings.capability.autopilot"),
      Model: "gpt-5 (openai)",
      Status: "done",
      Took: "42s",
      "First words after": "1s",
      Received: "15 B (14 characters)",
      Tokens: "31,200 in (4,000 cached, 13%) · 2,100 out",
      Cost: "$0.0412",
    });
    expect(facts.Sent).toMatch(/^system \d+ B, user \d+ B$/);
  });

  it("tells the transport of a failed attempt in figures, with its error in words", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP, {
      texts: ["Half of it", "Whole."],
      attempts: [
        attemptOf(1, {
          outcome: "timeout",
          durationMs: 120_000,
          transport: { status: 200, bytes: 1234, chunks: 56, events: 60, lastChunkAfterMs: 118_000, silentMs: 2000, end: "timeout", finishReason: "length", requestId: "req_42", partialCharacters: 1200, tail: "…the last words" },
          error: { name: "AiTimeoutError", message: "No answer for 120 s", status: null, transient: true, timedOut: true },
        }),
        attemptOf(2),
      ],
    });
    render(<View />);
    await screen.findByText("Whole.");
    const failed = callOf(1).querySelector("[data-failed-attempts] li") as HTMLElement;
    expect(failed).toHaveTextContent("Attempt 1 · openai · gpt-5 · ran out of time · 2m 00s");
    expect(failed).toHaveTextContent("https://api.openai.com");
    expect(failed).toHaveTextContent("HTTP 200 · 1.2 KB received · 56 chunks · 60 events · first byte after 1s · last chunk after 1m 58s · silent for 2s before the end · a deadline ran out · finish reason: length · request req_42 · 1,200 characters had arrived");
    expect(failed).toHaveTextContent("Error AiTimeoutError: No answer for 120 s (timed out, temporary)");
    expect(failed).toHaveTextContent("Last characters received: …the last words");
  });

  it("opens and closes with its header, and reads its texts only when it is open", async () => {
    const { store, source } = storeAsSource();
    const read = vi.spyOn(source, "readText");
    await recordCall(store, STEP, { seq: 1, texts: ["First answer."] });
    await recordCall(store, STEP, { seq: 2, texts: ["Second answer."] });
    render(<View />);
    await screen.findByText("Second answer.");
    expect(read.mock.calls.every(([, callId]) => callId.endsWith("-0002"))).toBe(true);
    fireEvent.click(headerOf(1));
    expect(headerOf(1)).toHaveAttribute("aria-expanded", "true");
    expect(await within(callOf(1)).findByText("First answer.")).toBeInTheDocument();
    fireEvent.click(headerOf(2));
    expect(headerOf(2)).toHaveAttribute("aria-expanded", "false");
    expect(within(callOf(2)).queryByText("Second answer.")).not.toBeInTheDocument();
  });
});

describe("a call on a phone", () => {
  it("opens in a sheet as tall as the screen, where its texts have the whole width; it closes with Escape, and the focus goes back to its header", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: /max-width|max-height/.test(query), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
    const { store } = storeAsSource();
    await recordCall(store, STEP, { seq: 1, label: "Plan the scene", texts: ["A plan."] });
    await recordCall(store, STEP, { seq: 2, label: "Write the scene", texts: ["The scene."] });
    render(<View />);
    // The last call of the step is open: in its sheet.
    const sheet = await screen.findByRole("dialog", { name: "Write the scene" });
    expect(sheet).toHaveAttribute("data-call-sheet");
    expect(await within(sheet).findByText("The scene.")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "false");
    expect(within(sheet).getByRole("button", { name: t("autopilot.calls.close") }).className).toMatch(/(^|\s)h-11(\s|$)/);
    expect(document.activeElement).toBe(sheet);
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(headerOf(2));
    expect(headerOf(2)).toHaveAttribute("aria-expanded", "false");
    expect(headerOf(2)).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(headerOf(1));
    expect(await screen.findByRole("dialog", { name: "Plan the scene" })).toBeInTheDocument();
  });
});

describe("the system and the user messages", () => {
  const long = Array.from({ length: 100 }, (_, index) => `Line ${String(index).padStart(4, "0")} of the instructions.`).join("\n");

  it("show their first 40 lines, and all of them on request: «Show all · 100 lines · 3 KB»", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP, { user: long });
    render(<View />);
    const pane = await waitFor(() => {
      const found = paneOf(1, "user");
      expect(found).toHaveTextContent("Line 0000");
      return found;
    });
    expect(regionOf(1, "user")).toHaveTextContent("Line 0039 of the instructions.");
    expect(regionOf(1, "user")).not.toHaveTextContent("Line 0040");
    expect(pane).toHaveTextContent("100 lines · 3,099 characters · 3 KB");
    const all = within(pane).getByRole("button", { name: "Show all · 100 lines · 3 KB" });
    expect(all).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(all);
    expect(within(pane).getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    expect(regionOf(1, "user")).toHaveTextContent("Line 0040 of the instructions.");
    // A short message has nothing to show more.
    expect(within(paneOf(1, "system")).queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("are copied whole, collapsed or not, and «Copied» is said at once", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP, { user: long });
    render(<View />);
    await waitFor(() => expect(paneOf(1, "user")).toHaveTextContent("Line 0000"));
    const copy = within(paneOf(1, "user")).getByRole("button", { name: "Copy: User" });
    fireEvent.click(copy);
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(long));
    expect(announce).toHaveBeenCalledWith("Copied");
    await waitFor(() => expect(copy).toHaveTextContent("Copied"));
  });

  it("say when they could not be copied, where the button is, never in a toast", async () => {
    clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
    const { store } = storeAsSource();
    await recordCall(store, STEP);
    render(<View />);
    await waitFor(() => expect(paneOf(1, "system")).toHaveTextContent("ghostwriter"));
    fireEvent.click(within(paneOf(1, "system")).getByRole("button", { name: "Copy: System" }));
    expect(await within(paneOf(1, "system")).findByText(t("autopilot.calls.pane.copyFailed"))).toBeInTheDocument();
    expect(announce).toHaveBeenCalledWith(t("autopilot.calls.pane.copyFailed"));
  });
});

describe("the texts of a pane", () => {
  it("are a labelled region that scrolls and takes the keyboard, never a live region", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP, { label: "Write the scene", texts: ["Whole answer."] });
    render(<View />);
    await screen.findByText("Whole answer.");
    const region = regionOf(1, "response");
    expect(region).toHaveAccessibleName("Response of «Write the scene»");
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).not.toHaveAttribute("aria-busy");
    expect(region).not.toHaveAttribute("aria-live");
    expect(document.querySelector("[data-task-calls] [aria-live], [data-task-calls] [role='status'], [data-task-calls] [role='log']")).toBeNull();
    expect(region.className).toMatch(/overflow-y-auto/);
    expect(region.querySelector("[data-text-block]")!.className).toMatch(/\[overflow-wrap:anywhere\]/);
  });

  it("show a reply in JSON laid out once it is whole, and Raw shows the exact text in a fixed-width font, for the whole page", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP, { structured: true, tool: "director_review", texts: ['{"verdict":"approve","score":8}'] });
    render(<><View /><View /></>);
    await waitFor(() => expect(document.querySelectorAll("[data-call-pane='response'] [data-text-block]")).toHaveLength(2));
    const [first, second] = [...document.querySelectorAll<HTMLElement>("[data-task-calls]")];
    const response = () => first.querySelector("[data-call-pane='response'] [role='region']") as HTMLElement;
    expect(response().textContent).toBe('{\n  "verdict": "approve",\n  "score": 8\n}');
    expect(first).toHaveTextContent(t("autopilot.calls.pane.json"));
    expect(within(first).getByText("director_review").tagName).toBe("CODE");
    const raw = within(first).getByRole("button", { name: "Raw" });
    expect(raw).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(raw);
    expect(raw).toHaveAttribute("aria-pressed", "true");
    expect(within(second).getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "true");
    expect(response().textContent).toBe('{"verdict":"approve","score":8}');
    expect(response()).toHaveAttribute("data-raw");
    expect(response().className).toMatch(/font-mono/);
    expect(response().className).toMatch(/overflow-x-auto/);
    expect(response().querySelector("[data-text-block]")!.className).toMatch(/whitespace-pre(\s|$)/);
    expect(first).not.toHaveTextContent(t("autopilot.calls.pane.json"));
  });

  it("label a partial reply, and give the reply of each attempt that had one, a failed one labelled as such", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP, {
      status: "interrupted",
      texts: ["The first attempt, cut.", "The second attempt, cut too."],
      attempts: [attemptOf(1, { outcome: "failed" }), attemptOf(2, { outcome: "interrupted" })],
    });
    render(<View />);
    await screen.findByText("The second attempt, cut too.");
    const pane = paneOf(1, "response");
    expect(pane).toHaveTextContent(t("autopilot.calls.pane.partial"));
    const choices = within(pane).getAllByRole("radio");
    expect(choices.map((choice) => choice.closest("label")!.textContent)).toEqual(["attempt 1 (failed)", "attempt 2 (interrupted)"]);
    expect(choices[1]).toBeChecked();
    fireEvent.click(choices[0]);
    expect(await within(pane).findByText("The first attempt, cut.")).toBeInTheDocument();
    expect(pane).toHaveTextContent(t("autopilot.calls.pane.failed"));
    expect(pane).not.toHaveTextContent(t("autopilot.calls.pane.partial"));
  });
});

describe("Keep", () => {
  it("is pressed as the store says, and keeps the step's messages when it is pressed", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP);
    await saveTask(store, STEP);
    render(<View />);
    const keep = await screen.findByRole("button", { name: "Keep" });
    expect(keep).toHaveAttribute("aria-pressed", "false");
    expect(keep).toHaveAttribute("title", t("autopilot.calls.keepHint"));
    fireEvent.click(keep);
    expect(keep).toHaveAttribute("aria-pressed", "true");
    await waitFor(async () => expect((await store.readTask(BOOK, STEP))!.header.pinned).toBe(true));
  });

  it("takes the choice back when it cannot be saved, and says so beside it", async () => {
    const store = new MemoryAiCallStore();
    await recordCall(store, STEP);
    const source: CallsSource = { ...localCallsSource(store), keep: vi.fn(async () => { throw new Error("The server said no."); }) };
    provideCallsSources(() => source);
    render(<View />);
    const keep = await screen.findByRole("button", { name: "Keep" });
    fireEvent.click(keep);
    expect(await screen.findByText(t("autopilot.calls.keepFailed", { message: "The server said no." }))).toBeInTheDocument();
    expect(keep).toHaveAttribute("aria-pressed", "false");
  });
});

describe("deleting the messages of the book", () => {
  it("asks first, saying what it deletes and where; then every view of the book is empty, and it is said", async () => {
    const { store } = storeAsSource();
    await recordCall(store, STEP);
    await recordCall(store, "activity_other", { label: "Another step" });
    render(<View />);
    await screen.findByText("The keeper climbed the stairs counting the steps under his breath.");
    const menu = openMenu(screen.getByRole("button", { name: t("autopilot.calls.more") }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: t("autopilot.calls.deleteAll") }));
    const dialog = await screen.findByRole("dialog", { name: t("autopilot.calls.deleteTitle") });
    await waitFor(() => expect(dialog).toHaveTextContent(/for 2 steps \(\d+ B\) in this browser, kept ones included\. The steps of the history stay/));
    fireEvent.click(within(dialog).getByRole("button", { name: t("autopilot.calls.deleteConfirm") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText(t("autopilot.calls.empty"))).toBeInTheDocument();
    expect((await store.listTasks(BOOK, { limit: 10 })).tasks).toEqual([]);
    expect(announce).toHaveBeenCalledWith(t("autopilot.calls.deleted"));
  });

  it("says the personal server when the book runs there, and leaves everything as it was when the author cancels", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [{ id: BOOK, owner: "local", repo: BOOK, name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", autopilotHost: "server", addedAt: at(0) }] as typeof DEFAULT_SETTINGS.books } });
    const { store } = storeAsSource();
    await recordCall(store, STEP);
    render(<View />);
    await screen.findByText("The keeper climbed the stairs counting the steps under his breath.");
    fireEvent.click(within(openMenu(screen.getByRole("button", { name: t("autopilot.calls.more") }))).getByRole("menuitem", { name: t("autopilot.calls.deleteAll") }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog).toHaveTextContent(/for 1 step \(\d+ B\) on your personal server/));
    fireEvent.click(within(dialog).getByRole("button", { name: t("autopilot.calls.cancel") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await store.readTask(BOOK, STEP)).not.toBeNull();
  });
});

describe("when there is nothing to show", () => {
  it("says why the messages cannot be read here, in the author's words", async () => {
    for (const reason of ["server-outdated", "server-offline", "no-store", "recording-off"] as const) {
      provideCallsSources(() => unavailableCallsSource(reason));
      const { unmount } = render(<View />);
      expect(document.querySelector(`[data-calls-unavailable="${reason}"]`)).toHaveTextContent(t(`autopilot.calls.unavailable.${reason}`));
      expect(screen.queryByRole("button", { name: "Raw" })).not.toBeInTheDocument();
      unmount();
    }
    expect(t("autopilot.calls.unavailable.server-outdated")).toBe("This run's messages are not being recorded on this server: update it.");
    expect(t("autopilot.calls.unavailable.no-store")).toBe("This run's messages are not recorded in this browser (private window?).");
  });

  it("says it in Italian", async () => {
    await i18n.changeLanguage("it");
    provideCallsSources(() => unavailableCallsSource("server-outdated"));
    render(<View />);
    expect(screen.getByText("I messaggi di questa esecuzione non vengono registrati su questo server: aggiornalo.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Messaggi all'IA" })).toBeInTheDocument();
  });

  it("is nothing at all where this build does not read the records yet", () => {
    provideCallsSources(() => unavailableCallsSource("unwired"));
    const { container } = render(<View />);
    expect(container.querySelector("[data-task-calls]")).toBeNull();
  });

  it("says that no message was recorded for the step, or that the first one is on its way", async () => {
    storeAsSource();
    const { unmount } = render(<View />);
    expect(await screen.findByText(t("autopilot.calls.empty"))).toBeInTheDocument();
    unmount();
    render(<View running />);
    expect(await screen.findByText(t("autopilot.calls.emptyRunning"))).toBeInTheDocument();
  });

  it("says when the messages could not be read, and reads them again on request", async () => {
    const store = new MemoryAiCallStore();
    await recordCall(store, STEP, { texts: ["Read at last."] });
    let fail = true;
    const base = localCallsSource(store);
    provideCallsSources(() => ({ ...base, readTask: async (bookId, activityId) => {
      if (fail) throw new Error("The server did not answer.");
      return base.readTask(bookId, activityId);
    } }));
    render(<View />);
    expect(await screen.findByText(t("autopilot.calls.error", { message: "The server did not answer." }))).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.calls.retry") }));
    expect(await screen.findByText("Read at last.")).toBeInTheDocument();
  });
});

describe("a link to a call (#call-<id>)", () => {
  it("opens the call, brings it into sight and gives it the focus", async () => {
    const { store } = storeAsSource();
    const first = await recordCall(store, STEP, { seq: 1, texts: ["First answer."] });
    await recordCall(store, STEP, { seq: 2, texts: ["Second answer."] });
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<View hash={`#${callElementId(first.callId)}`} />);
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById(callElementId(first.callId))));
    expect(headerOf(1)).toHaveAttribute("aria-expanded", "true");
    expect(await within(callOf(1)).findByText("First answer.")).toBeInTheDocument();
    expect(scrolled).toHaveBeenCalledWith({ block: "start" });
    expect(callOf(1).className).toMatch(/scroll-mt-8/);
    expect(callOf(1).className).toMatch(/data-\[revealed\]:focus:ring-2/);
  });
});

/** A store whose source is asked often, so that the pace of the drawing is the pane's and not the source's. */
function quickSource(store: AiCallStore, pollMs = 50): CallsSource {
  const source = { ...localCallsSource(store), pollMs };
  provideCallsSources(() => source);
  return source;
}

describe("a call that streams", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date"] });
    vi.setSystemTime(new Date(at(70)));
  });

  async function begin(store: MemoryAiCallStore) {
    const started = beginRecord(STEP);
    await store.begin(started);
    await saveTask(store, STEP, "running");
    return started.record;
  }

  it("fills in as the store receives it, busy while it streams, and no longer once it ends", async () => {
    const store = new MemoryAiCallStore();
    storeAsSource(store);
    const record = await begin(store);
    render(<View running />);
    await advance(0);
    const region = () => regionOf(1, "response");
    expect(region()).toHaveAttribute("aria-busy", "true");
    expect(region()).toHaveTextContent(t("autopilot.calls.pane.waiting"));
    expect(headerOf(1)).toHaveTextContent("answering");
    await store.append(record.callId, 1, 0, "The keeper ");
    await advance(600);
    expect(region()).toHaveTextContent("The keeper");
    await store.append(record.callId, 1, 11, "climbed the stairs.");
    await advance(600);
    expect(region()).toHaveTextContent("The keeper climbed the stairs.");
    await store.end(record.callId, endOf(record, "ok", ["The keeper climbed the stairs."], [attemptOf(1)]));
    await saveTask(store, STEP, "done");
    await advance(1200);
    expect(region()).not.toHaveAttribute("aria-busy");
    expect(headerOf(1)).toHaveTextContent("done");
    expect(region()).toHaveTextContent("The keeper climbed the stairs.");
  });

  it("keeps its end in sight; when the reader scrolls up it stays where they are, and «Follow the text» takes them back to the end", async () => {
    const store = new MemoryAiCallStore();
    storeAsSource(store);
    const record = await begin(store);
    render(<View running />);
    await store.append(record.callId, 1, 0, "First words. ");
    await advance(600);
    const region = regionOf(1, "response");
    Object.defineProperty(region, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(region, "clientHeight", { configurable: true, get: () => 400 });
    await store.append(record.callId, 1, 13, "More words. ");
    await advance(600);
    expect(region.scrollTop).toBe(2000);
    expect(within(paneOf(1, "response")).queryByRole("button", { name: t("autopilot.calls.pane.follow") })).not.toBeInTheDocument();
    // The reader scrolls up: the pane stays there while the text goes on arriving.
    region.scrollTop = 300;
    fireEvent.scroll(region);
    await advance(50);
    const follow = within(paneOf(1, "response")).getByRole("button", { name: t("autopilot.calls.pane.follow") });
    await store.append(record.callId, 1, 25, "And more. ");
    await advance(600);
    expect(region.scrollTop).toBe(300);
    fireEvent.click(follow);
    expect(region.scrollTop).toBe(2000);
    expect(document.activeElement).toBe(region);
    expect(within(paneOf(1, "response")).queryByRole("button", { name: t("autopilot.calls.pane.follow") })).not.toBeInTheDocument();
  });

  it("starts again when a new attempt begins, says so, and goes on with the new text", async () => {
    const store = new MemoryAiCallStore();
    storeAsSource(store);
    const record = await begin(store);
    render(<><View running /><LiveAnnouncer bookIds={[BOOK]} /></>);
    await store.append(record.callId, 1, 0, "The first attempt");
    await advance(600);
    expect(regionOf(1, "response")).toHaveTextContent("The first attempt");
    await store.append(record.callId, 2, 0, "The second attempt");
    await advance(1200);
    expect(regionOf(1, "response")).toHaveTextContent("The second attempt");
    expect(regionOf(1, "response")).not.toHaveTextContent("The first attempt");
    expect(paneOf(1, "response")).toHaveTextContent(t("autopilot.calls.pane.restarted", { number: 2 }));
    await advance(100);
    expect(document.querySelector("[data-live-announcer]")).toHaveTextContent(t("autopilot.calls.say.retrying", { call: record.label }));
  });

  it("draws the end of the live events after what the record has, and the live events alone before it has anything", async () => {
    const store = new MemoryAiCallStore();
    storeAsSource(store);
    const record = await begin(store);
    const activity = { id: STEP, runId: "run-1", task: "write", phase: "write", title: "Writing", status: "running", startedAt: at(0) } as never;
    act(() => useAutopilotStore.setState({ live: { [BOOK]: { activity, characters: 30, preview: "The keeper climbed the stairs" } } }));
    render(<View running />);
    await advance(600);
    expect(regionOf(1, "response")).toHaveTextContent("The keeper climbed the stairs");
    const kept = "The keeper climbed the stairs counting the steps under his breath, and on every";
    await store.append(record.callId, 1, 0, kept);
    act(() => useAutopilotStore.setState({ live: { [BOOK]: { activity, characters: 120, preview: `${kept} landing the wind changed its note.` } } }));
    await advance(600);
    expect(regionOf(1, "response").textContent).toBe(`${kept} landing the wind changed its note.`);
  });

  it("says how much of a reply that answers with a value has arrived, until the record has its text", async () => {
    const store = new MemoryAiCallStore();
    storeAsSource(store);
    await begin(store);
    const activity = { id: STEP, runId: "run-1", task: "plan", phase: "plan", title: "Planning", status: "running", startedAt: at(0) } as never;
    act(() => useAutopilotStore.setState({ live: { [BOOK]: { activity, characters: 0, preview: "", bytes: 12_288 } } }));
    render(<View running />);
    await advance(600);
    expect(regionOf(1, "response")).toHaveTextContent("Answering… 12 KB");
    expect(regionOf(1, "response")).toHaveAttribute("aria-busy", "true");
  });

  it("says out loud, in the one polite voice of the page, that a later call of the step answers, and that its answer is complete or failed", async () => {
    const store = new MemoryAiCallStore();
    storeAsSource(store);
    await recordCall(store, STEP, { seq: 1, texts: ["The plan."] });
    const second = beginRecord(STEP, { seq: 2, label: "Write the scene" });
    await store.begin(second);
    await saveTask(store, STEP, "running");
    render(<><View running /><LiveAnnouncer bookIds={[BOOK]} /></>);
    await advance(600);
    const voice = () => document.querySelector("[data-live-announcer]") as HTMLElement;
    await store.append(second.record.callId, 1, 0, "The keeper climbed.");
    await advance(700);
    // The voice empties its line and writes the words a moment later, so that the same words twice are said twice.
    await advance(100);
    expect(voice()).toHaveTextContent(t("autopilot.calls.say.answering", { call: "Write the scene" }));
    await store.end(second.record.callId, endOf(second.record, "ok", ["The keeper climbed."], [attemptOf(1)]));
    await advance(1200);
    // At most one message every ten seconds: the end waits for its turn.
    expect(voice()).toHaveTextContent(t("autopilot.calls.say.answering", { call: "Write the scene" }));
    await advance(10_000);
    await advance(100);
    expect(voice()).toHaveTextContent(t("autopilot.calls.say.complete", { count: 19, value: "19" }));
  });

  it("is drawn again at most four times a second, however often the text arrives", async () => {
    const store = new MemoryAiCallStore();
    quickSource(store);
    const record = await begin(store);
    render(<View running />);
    await advance(100);
    const region = regionOf(1, "response");
    const drawn = new Set<string>();
    const observer = new MutationObserver(() => drawn.add(region.textContent ?? ""));
    observer.observe(region, { subtree: true, childList: true, characterData: true });
    let offset = 0;
    for (let chunk = 1; chunk <= 40; chunk += 1) {
      const piece = `chunk ${chunk} `;
      await store.append(record.callId, 1, offset, piece);
      offset += new TextEncoder().encode(piece).length;
      await advance(50);
    }
    await advance(300);
    observer.disconnect();
    expect(region).toHaveTextContent("chunk 40");
    expect(drawn.size, `drawn ${drawn.size} times in two seconds`).toBeLessThanOrEqual(9);
  });
});

describe("a response of megabytes", () => {
  it("is a bounded number of elements, wherever the reader is in it, and is copied whole", async () => {
    const store = new MemoryAiCallStore();
    storeAsSource(store);
    const line = "The keeper climbed the stairs counting the steps under his breath, and the wind changed its note.\n";
    const huge = line.repeat(Math.ceil((3 * 1024 * 1024) / line.length));
    await recordCall(store, STEP, { texts: [huge] });
    render(<View />);
    const region = await waitFor(() => {
      const found = regionOf(1, "response");
      expect(found.querySelector("[data-text-block]")).not.toBeNull();
      return found;
    });
    const count = () => region.querySelectorAll("*").length;
    expect(count(), "elements at the top").toBeLessThan(40);
    expect(paneOf(1, "response")).toHaveTextContent("3 MB");
    region.scrollTop = 30_000_000;
    fireEvent.scroll(region);
    await waitFor(() => expect(region.querySelector("[data-text-block]")!.getAttribute("data-text-block")).not.toBe("0"));
    expect(count(), "elements at the end").toBeLessThan(40);
    fireEvent.click(within(paneOf(1, "response")).getByRole("button", { name: "Copy: Response" }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
    expect(clipboard.writeText.mock.calls[0][0]).toHaveLength(huge.length);
  });

  it("stays a bounded number of elements while it streams in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    const store = new MemoryAiCallStore();
    quickSource(store, 100);
    const started = beginRecord(STEP);
    await store.begin(started);
    render(<View running />);
    const piece = "x".repeat(1023) + "\n";
    const chunk = piece.repeat(256);
    let offset = 0;
    let most = 0;
    for (let step = 0; step < 12; step += 1) {
      await store.append(started.record.callId, 1, offset, chunk);
      offset += chunk.length;
      await advance(300);
      most = Math.max(most, regionOf(1, "response").querySelectorAll("*").length);
    }
    expect(regionOf(1, "response").textContent!.length).toBeGreaterThan(0);
    expect(paneOf(1, "response")).toHaveTextContent("3 MB");
    expect(most).toBeLessThan(40);
  });
});

describe("when nothing more is kept", () => {
  it("reads what was kept all the same, says in words that the recording is turned off, and leaves the author the means to delete it", async () => {
    const store = new MemoryAiCallStore();
    await recordCall(store, STEP);
    await saveTask(store, STEP);
    const source = localCallsSource(store, { notRecording: true });
    provideCallsSources(() => source);
    render(<View />);
    await screen.findByText("The keeper climbed the stairs counting the steps under his breath.");
    expect(document.querySelector('[data-calls-unavailable="recording-off"]')).toHaveTextContent(t("autopilot.calls.unavailable.recording-off"));
    expect(screen.getByRole("button", { name: "Raw" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("autopilot.calls.more") })).toBeInTheDocument();
  });

  it("says nothing of it while the recording is on", async () => {
    const store = new MemoryAiCallStore();
    await recordCall(store, STEP);
    await saveTask(store, STEP);
    const source = localCallsSource(store);
    provideCallsSources(() => source);
    render(<View />);
    await screen.findByText("The keeper climbed the stairs counting the steps under his breath.");
    expect(document.querySelector('[data-calls-unavailable="recording-off"]')).toBeNull();
  });
});

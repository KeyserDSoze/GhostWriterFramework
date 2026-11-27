import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";

const env = vi.hoisted(() => ({ octokit: null as unknown as Octokit, save: vi.fn(async () => true) }));
vi.mock("@/repository/githubRequest", () => ({ createTrackedGitHubClient: () => env.octokit }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: env.save }) }));
vi.mock("@/readerAccess/sealedBox", () => ({ sealSecret: (value: string, key: string) => `sealed:${key.length}:${value.length}` }));

import i18n from "@/i18n";
import { ReaderAccessCard } from "@/components/book/readerAccess/ReaderAccessCard";
import { useSettingsStore } from "@/store/settingsStore";
import { useOutsideStore } from "@/readerRun/outsideStore";
import { RUN_STORAGE_KEY, usePublicationStore } from "@/readerRun/store";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { createFakeReaderGitHub, type FakeReaderGitHub } from "./helpers/fakeReaderGitHub";

// The live state of the publication that «Publish again» (or a change of the passwords) started: the run is found by its trigger, polled every 20 seconds while the
// card is open and the run goes, paused while the tab is hidden, slowed down by the rate limit, kept across a reload, and not asked about when nothing publishes.

const book: BookEntry = { id: "b1", owner: "me", repo: "book", name: "Book", tokenIndex: null, addedAt: "2026-11-01T00:00:00.000Z" };
const runsUrl = "https://github.com/me/book/actions/runs";
let github: FakeReaderGitHub;
let visibility: "visible" | "hidden" = "visible";

const TEXTS = {
  en: { publishAgain: "Publish again", waiting: "Waiting for GitHub to start the run…", queued: "Queued: waiting for GitHub to give it a machine.", running: "Running", succeeded: "Succeeded: the reader is published.", failed: "Failed: the reader was not published.", step: "Step 2 of 3: Build reader site", openRun: /Open the run on GitHub/, all: /View all runs/, announceRunning: "Publication running.", announceSucceeded: "Publication succeeded. The reader is published.", paused: /Paused while this tab is hidden/, rate: /GitHub's limit on requests was reached\. The next check is in about \d+ s\./, notFound: /GitHub has not started a run for this action/, budget: "GitHub Actions cannot run: the budget or billing blocks it", checked: /Checked from outside: the EPUB answers 404/ },
  it: { publishAgain: "Pubblica di nuovo", waiting: "In attesa che GitHub avvii l'esecuzione…", queued: "In coda: aspetta che GitHub le dia una macchina.", running: "In esecuzione", succeeded: "Riuscita: il lettore è pubblicato.", failed: "Fallita: il lettore non è stato pubblicato.", step: "Passo 2 di 3: Build reader site", openRun: /Apri l'esecuzione su GitHub/, all: /Vedi tutte le esecuzioni/, announceRunning: "Pubblicazione in esecuzione.", announceSucceeded: "Pubblicazione riuscita. Il lettore è pubblicato.", paused: /In pausa finché questa scheda è nascosta/, rate: /Il limite di richieste di GitHub è stato raggiunto\. Il prossimo controllo è tra circa \d+ s\./, notFound: /GitHub non ha avviato nessuna esecuzione per questa azione/, budget: "GitHub Actions non può girare: lo blocca il budget o la fatturazione", checked: /Controllato da fuori: l'EPUB risponde 404/ },
} as const;

function setVisibility(state: "visible" | "hidden") {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}
const callsOf = (...methods: string[]) => github.calls.filter((call) => methods.includes(call.method)).length;
const runPolls = () => callsOf("getWorkflowRun") + github.calls.filter((call) => call.method === "listWorkflowRuns" && (call.args as { event?: string }).event !== undefined).length;

beforeEach(() => {
  localStorage.clear();
  usePublicationStore.setState({ entries: {}, live: {} });
  useOutsideStore.setState({ entries: {} });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  github = createFakeReaderGitHub();
  github.pages.enabled = true;
  env.octokit = github.octokit;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "github_pat_default", books: [book] } });
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

async function open(language: "en" | "it") {
  await i18n.changeLanguage(language);
  render(<ReaderAccessCard book={book} />);
  await screen.findByText(language === "en" ? "Reader access" : "Accesso al lettore");
}
const panel = () => screen.getByTestId("reader-publication");
const phase = () => panel().getAttribute("data-phase");
async function publish(language: "en" | "it") {
  fireEvent.click((await screen.findAllByRole("button", { name: TEXTS[language].publishAgain }))[0]);
  await screen.findByTestId("reader-publication");
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe.each(["en", "it"] as const)("the live state of a publication, in %s", (language) => {
  const text = TEXTS[language];

  it("follows the run its click made, from queued to succeeded, with its step, start, duration and the link that opens it in a new tab", async () => {
    await open(language);
    await publish(language);
    await waitFor(() => expect(phase()).toBe("queued"));
    expect(within(panel()).getByText(text.queued)).toBeInTheDocument();
    const link = within(panel()).getByRole("link", { name: text.openRun });
    expect(link).toHaveAttribute("href", `${runsUrl}/1`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(within(panel()).getByRole("link", { name: text.all })).toHaveAttribute("href", "https://github.com/me/book/actions/workflows/deploy-reader-pages.yml");

    github.runs[0].status = "in_progress";
    github.runs[0].run_started_at = new Date(Date.now() - 65_000).toISOString();
    github.jobs.push({ id: 1, name: "build", conclusion: null, status: "in_progress", steps: [{ name: "Checkout", status: "completed" }, { name: "Build reader site", status: "in_progress" }, { name: "Upload", status: "queued" }] });
    await advance(20_100);
    await waitFor(() => expect(phase()).toBe("running"));
    expect(within(panel()).getByTestId("reader-publication-step")).toHaveTextContent(text.step);
    expect(panel().querySelector("time")).toHaveAttribute("datetime", github.runs[0].run_started_at!);
    expect(within(panel()).getByTestId("reader-publication-duration")).toHaveTextContent(/1 min \d+ s/);

    github.runs[0].status = "completed";
    github.runs[0].conclusion = "success";
    github.runs[0].updated_at = new Date(new Date(github.runs[0].run_started_at!).getTime() + 130_000).toISOString();
    await advance(20_100);
    await waitFor(() => expect(phase()).toBe("succeeded"));
    expect(within(panel()).getByText(text.succeeded)).toBeInTheDocument();
    expect(within(panel()).getByTestId("reader-publication-duration")).toHaveTextContent(/^2 min 10 s$/);
    expect(within(panel()).queryByTestId("reader-publication-step")).toBeNull();
  });

  it("asks about the run about every 20 seconds while it goes, and not at all once it has ended", async () => {
    await open(language);
    await publish(language);
    await waitFor(() => expect(phase()).toBe("queued"));
    const before = runPolls();
    await advance(60_100);
    const during = runPolls() - before;
    expect(during).toBeGreaterThanOrEqual(2);
    expect(during).toBeLessThanOrEqual(4);
    github.runs[0].status = "completed";
    github.runs[0].conclusion = "success";
    await advance(20_100);
    await waitFor(() => expect(phase()).toBe("succeeded"));
    const ended = runPolls();
    await advance(120_000);
    expect(runPolls()).toBe(ended);
  });

  it("tells the state to a screen reader once for each state, politely, and not at every poll", async () => {
    await open(language);
    await publish(language);
    const announce = () => screen.getByTestId("reader-publication-announce");
    expect(announce()).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(announce()).toHaveTextContent(text.queued.split(":")[0] === "Queued" ? "Publication queued." : "Pubblicazione in coda."));
    github.runs[0].status = "in_progress";
    await advance(20_100);
    await waitFor(() => expect(announce()).toHaveTextContent(text.announceRunning));
    const node = announce();
    await advance(20_100);
    expect(announce()).toBe(node);
    expect(announce()).toHaveTextContent(text.announceRunning);
    github.runs[0].status = "completed";
    github.runs[0].conclusion = "success";
    await advance(20_100);
    await waitFor(() => expect(announce()).toHaveTextContent(text.announceSucceeded));
  });

  it("takes the run of its own click, not a newer push run and not an older click's run", async () => {
    github.runs.unshift({ id: 50, status: "completed", conclusion: "success", html_url: "x", created_at: "2026-11-24T10:00:00Z", head_branch: "main", event: "workflow_dispatch" });
    await open(language);
    github.runs.unshift({ id: 51, status: "in_progress", conclusion: null, html_url: "x", created_at: "2026-11-25T10:00:00Z", head_branch: "main", event: "push", head_sha: "pushed" });
    github.runs.pop();
    github.runs.push({ id: 50, status: "completed", conclusion: "success", html_url: "x", created_at: "2026-11-24T10:00:00Z", head_branch: "main", event: "workflow_dispatch" });
    await publish(language);
    await waitFor(() => expect(panel().getAttribute("data-run-id")).toBe("52"));
    expect(within(panel()).getByRole("link", { name: text.openRun })).toHaveAttribute("href", `${runsUrl}/52`);
  });

  it("waits for GitHub to make the run, quickly at first, and says so when none appears", async () => {
    await open(language);
    // GitHub accepts the dispatch and makes no run (yet): the request is answered and nothing is created.
    const original = github.octokit.request;
    (github.octokit as { request: unknown }).request = async (route: string, args?: Record<string, unknown>) => (route.includes("/dispatches") ? { status: 204, data: {} } : (original as unknown as (route: string, args?: Record<string, unknown>) => Promise<unknown>)(route, args));
    await publish(language);
    expect(phase()).toBe("waiting");
    expect(within(panel()).getByText(text.waiting)).toBeInTheDocument();
    const first = callsOf("listWorkflowRuns");
    await advance(5_100);
    expect(callsOf("listWorkflowRuns")).toBeGreaterThan(first);
    await advance(3 * 60_000 + 30_000);
    await waitFor(() => expect(within(panel()).getByText(text.notFound)).toBeInTheDocument());
    expect(phase()).toBe("not-found");
    const stopped = callsOf("listWorkflowRuns");
    await advance(120_000);
    expect(callsOf("listWorkflowRuns")).toBe(stopped);
    (github.octokit as { request: unknown }).request = original;
  });

  it("stops asking while the tab is hidden, and asks again at once when it is seen", async () => {
    await open(language);
    await publish(language);
    await waitFor(() => expect(phase()).toBe("queued"));
    setVisibility("hidden");
    await advance(10);
    await waitFor(() => expect(within(panel()).getByText(text.paused)).toBeInTheDocument());
    const hiddenAt = runPolls();
    await advance(5 * 60_000);
    expect(runPolls()).toBe(hiddenAt);
    github.runs[0].status = "in_progress";
    setVisibility("visible");
    await waitFor(() => expect(phase()).toBe("running"));
    expect(runPolls()).toBeGreaterThan(hiddenAt);
    expect(within(panel()).queryByText(text.paused)).toBeNull();
  });

  it("slows down when GitHub limits the requests, says so, and goes back to the normal pace at the first answer", async () => {
    await open(language);
    await publish(language);
    await waitFor(() => expect(phase()).toBe("queued"));
    github.fail("getWorkflowRun", { status: 403, message: "API rate limit exceeded", headers: { "x-ratelimit-remaining": "0" } });
    await advance(20_100);
    await waitFor(() => expect(within(panel()).getByTestId("reader-publication-problem")).toHaveTextContent(text.rate));
    const limited = runPolls();
    await advance(30_000);
    expect(runPolls()).toBe(limited);
    await advance(20_000);
    expect(runPolls()).toBeGreaterThan(limited);
    github.clearFailures();
    await advance(90_000);
    await waitFor(() => expect(within(panel()).queryByTestId("reader-publication-problem")).toBeNull());
  });

  it("goes on after a reload: the run is found again from what was kept, and its state is current", async () => {
    await open(language);
    await publish(language);
    await waitFor(() => expect(phase()).toBe("queued"));
    expect(JSON.parse(localStorage.getItem(RUN_STORAGE_KEY)!)["me/book"]).toMatchObject({ trigger: "dispatch", runId: 1, state: "queued" });
    cleanup();
    usePublicationStore.setState({ entries: {}, live: {} });
    // A new page: the store is read from the device's storage again.
    const { readStoredPublications } = await import("@/readerRun/store");
    usePublicationStore.setState({ entries: readStoredPublications(localStorage, Date.now()) });
    github.runs[0].status = "in_progress";
    await open(language);
    await waitFor(() => expect(phase()).toBe("running"));
    expect(within(panel()).getByRole("link", { name: text.openRun })).toHaveAttribute("href", `${runsUrl}/1`);
  });

  it("asks nothing about runs when nothing is publishing: not on opening the card, not for as long as it is open", async () => {
    github.runs.unshift({ id: 8, status: "completed", conclusion: "success", html_url: "x", created_at: "2026-11-25T10:00:00Z", head_branch: "main", event: "workflow_dispatch" });
    await open(language);
    await screen.findByTestId("reader-run");
    const asked = callsOf("listWorkflowRuns", "getWorkflowRun");
    await advance(5 * 60_000);
    expect(callsOf("listWorkflowRuns", "getWorkflowRun")).toBe(asked);
    expect(screen.queryByTestId("reader-publication")).toBeNull();
  });

  it("follows a run that was already going when the card opened (someone else's push), and a stale queued run is left alone", async () => {
    github.runs.unshift({ id: 8, status: "in_progress", conclusion: null, html_url: "x", created_at: new Date().toISOString(), head_branch: "main", event: "push", head_sha: "pp" });
    await open(language);
    await waitFor(() => expect(phase()).toBe("running"));
    cleanup();
    usePublicationStore.setState({ entries: {}, live: {} });
    github.runs[0] = { id: 9, status: "queued", conclusion: null, html_url: "x", created_at: new Date(Date.now() - 5 * 3_600_000).toISOString(), head_branch: "main", event: "push" };
    await open(language);
    await screen.findByTestId("reader-run");
    expect(screen.queryByTestId("reader-publication")).toBeNull();
  });

  it("says why a run failed in words under its state, from the annotation GitHub put on it", async () => {
    await open(language);
    await publish(language);
    await waitFor(() => expect(phase()).toBe("queued"));
    github.runs[0].status = "completed";
    github.runs[0].conclusion = "failure";
    github.jobs.push({ id: 7, name: "build", conclusion: "failure", steps: [] });
    github.annotations[7] = [{ message: "The job was not started because an Actions budget is preventing further use." }];
    await advance(20_100);
    await waitFor(() => expect(phase()).toBe("failed"));
    expect(within(panel()).getByText(text.failed)).toBeInTheDocument();
    await waitFor(() => expect(within(panel()).getByTestId("reader-publication-cause")).toHaveTextContent(text.budget));
    expect(within(panel()).getByRole("link", { name: text.openRun })).toHaveAttribute("href", `${runsUrl}/1`);
  });

  it("checks the published reader from outside once, when a publication of a reader with passwords has succeeded", async () => {
    github.secrets.set("READER_PASSWORD_001", "x");
    github.variable.value = "READER_PASSWORD_001";
    const fetcher = vi.fn(async (url: string) => (String(url).includes("downloads/book.epub") ? { status: 404, ok: false, json: async () => ({}) } : { status: 200, ok: true, json: async () => ({ protected: true }) }));
    vi.stubGlobal("fetch", fetcher);
    await open(language);
    await publish(language);
    await waitFor(() => expect(phase()).toBe("queued"));
    github.runs[0].status = "completed";
    github.runs[0].conclusion = "success";
    await advance(20_100);
    await waitFor(() => expect(phase()).toBe("succeeded"));
    await waitFor(() => expect(within(panel()).getByTestId("reader-publication-outside")).toHaveTextContent(text.checked));
    const calls = fetcher.mock.calls.length;
    await advance(120_000);
    expect(fetcher.mock.calls.length).toBe(calls);
    expect(fetcher.mock.calls[0][0]).toContain("https://me.github.io/book/downloads/book.epub");
  });
});

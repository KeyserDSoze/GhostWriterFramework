import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAiCallStore } from "narrarium-engine";

const save = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save }) }));
// The tab is tested with the services these tests wire themselves: the host that wires the real store is tested apart (`aiCallsHost.test.ts`).
vi.mock("@/autopilot/calls/host", () => ({ ensureCallsHost: async () => null, deleteBookRecords: async () => undefined }));

import i18n from "@/i18n";
import { AiCallsCard } from "@/components/autopilot/config/AiCallsCard";
import { CopyError, type CopyTarget, type CopyTargetKind } from "@/autopilot/calls/copies/types";
import { configureCopyServices, resetCopyServicesForTests } from "@/autopilot/calls/copies/services";
import { stopCopiesRuntimeForTests } from "@/autopilot/calls/copies/runtime";
import { MemoryCopyLedger, MemoryCopyOutbox } from "@/autopilot/calls/copies/stores";
import { isRecording, resetRecordingForTests } from "@/autopilot/calls/recording";
import { useConnectionStore } from "@/account/connectionStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import type { LocalGoogleConnection, LocalMicrosoftConnection } from "@/account/types";
import { BOOK, seedTask } from "./aiCallCopiesKit";

const SCOPE = "workspace:test";
const book = (patch: Partial<BookEntry> = {}): BookEntry => ({ id: BOOK, owner: "me", repo: "book", name: "Book", tokenIndex: null, addedAt: "2026-11-01T00:00:00.000Z", ...patch });
const google = (status: "idle" | "needs-auth" = "idle"): LocalGoogleConnection => ({ backend: "google-drive", method: "google", identity: { provider: "google", providerAccountId: "g-1", displayName: "Writer" }, accessToken: "t", rememberMe: true, replica: { enabled: true, status } });
const microsoft = (status: "idle" | "needs-auth" = "idle"): LocalMicrosoftConnection => ({ backend: "onedrive", method: "microsoft", identity: { provider: "microsoft", providerAccountId: "m-1", displayName: "Writer" }, accessToken: "t", homeAccountId: "m-1", localAccountId: "l-1", rememberMe: true, replica: { enabled: true, status } });

const TEXTS = {
  en: {
    legend: "Also copy to", none: "Nowhere else", github: "This book's GitHub repository", google: "Google Drive", onedrive: "OneDrive",
    privacy: "These records hold what the autopilot sent to the AI (your book's text, its secrets, your notes and your director's notes) and what it wrote back. Keys and passwords are never recorded. A copy stays in the account you choose until you delete it there. GitHub keeps history after deletion, so public repositories are refused.",
    notConnected: "Not connected.", link: "Connect it in Settings → Account", reconnect: (service: string) => `Reconnect ${service}`, renew: "The sign-in needs to be renewed.",
    savedGoogle: "Saved. Finished tasks will also be copied to Google Drive.", savedNone: "Saved. The records stay on this device only.",
    waitingOffline: "14 tasks waiting for Google Drive · offline", nothing: "Nothing has been copied yet.", copiedUpTo: "Copied up to",
    pub: "The repository is public: copies are refused. Make it private to copy the AI calls here.",
    deleteCopies: "Delete the copies in Google Drive", confirmTitle: "Delete the copies in Google Drive?", confirm: "Delete the copies", cancel: "Cancel", deleted: "The copies in Google Drive were deleted.",
    deleteRecords: "Delete the records", recordsTitle: "Delete the records of this book?", recordsServer: /on this device and on the personal server, together/, recordsDevice: /on this device\. Copies in other places stay/,
    device: "This device", server: "Personal server", budget: /up to 256 MiB for this book/, used: "1 MiB used by 3 tasks.", recording: "Keep the messages of this run",
    reconnectWaiting: "Reconnect OneDrive: its sign-in needs to be renewed, and 2 tasks are waiting.", archiveFull: /The archive in GitHub is full, so copying has stopped/, archive: /Archive in Google Drive: .* of 2 GiB\./,
  },
  it: {
    legend: "Copia anche in", none: "Da nessun'altra parte", github: "Il repository GitHub di questo libro", google: "Google Drive", onedrive: "OneDrive",
    privacy: "Queste registrazioni contengono ciò che l'autopilot ha inviato all'AI (il testo del tuo libro, i suoi segreti, le tue note e quelle del tuo direttore) e ciò che ha risposto. Le chiavi e le password non vengono mai registrate. Una copia resta nell'account che scegli finché non la elimini da lì. GitHub conserva la cronologia anche dopo l'eliminazione, per questo i repository pubblici sono rifiutati.",
    notConnected: "Non connesso.", link: "Collegalo in Impostazioni → Account", reconnect: (service: string) => `Riconnetti ${service}`, renew: "L'accesso va rinnovato.",
    savedGoogle: "Salvato. I compiti conclusi verranno copiati anche in Google Drive.", savedNone: "Salvato. Le registrazioni restano solo su questo dispositivo.",
    waitingOffline: "14 compiti in attesa di Google Drive · offline", nothing: "Non è stato ancora copiato nulla.", copiedUpTo: "Copiato fino a",
    pub: "Il repository è pubblico: le copie sono rifiutate. Rendilo privato per copiare qui le chiamate AI.",
    deleteCopies: "Elimina le copie in Google Drive", confirmTitle: "Eliminare le copie in Google Drive?", confirm: "Elimina le copie", cancel: "Annulla", deleted: "Le copie in Google Drive sono state eliminate.",
    deleteRecords: "Elimina le registrazioni", recordsTitle: "Eliminare le registrazioni di questo libro?", recordsServer: /su questo dispositivo e sul server personale, insieme/, recordsDevice: /su questo dispositivo\. Le copie negli altri posti restano/,
    device: "Questo dispositivo", server: "Server personale", budget: /fino a 256 MiB per questo libro/, used: "1 MiB usati da 3 compiti.", recording: "Conserva i messaggi di questa esecuzione",
    reconnectWaiting: "Riconnetti OneDrive: il suo accesso va rinnovato e 2 compiti sono in attesa.", archiveFull: /L'archivio in GitHub è pieno, quindi la copia si è fermata/, archive: /Archivio in Google Drive: .* su 2 GiB\./,
  },
} as const;

interface Fake { removed: CopyTargetKind[]; prepare: () => Promise<void>; online: boolean; recordsDeleted: Array<[string, string]>; store: MemoryAiCallStore; outbox: MemoryCopyOutbox; ledger: MemoryCopyLedger }
let fake: Fake;

function wire(options: { prepareError?: unknown } = {}) {
  const store = new MemoryAiCallStore();
  const outbox = new MemoryCopyOutbox();
  const ledger = new MemoryCopyLedger();
  fake = { removed: [], prepare: async () => { if (options.prepareError) throw options.prepareError; }, online: true, recordsDeleted: [], store, outbox, ledger };
  configureCopyServices({
    store: () => store,
    outbox,
    ledger,
    scope: () => SCOPE,
    online: () => fake.online,
    openTarget: async (_bookId, kind): Promise<CopyTarget> => ({ kind, prepare: fake.prepare, write: async () => undefined, removeDays: async () => undefined, removeAll: async () => { fake.removed.push(kind); } }),
    deleteRecords: async (bookId, host) => { fake.recordsDeleted.push([bookId, host]); },
  });
}

async function open(language: "en" | "it", configuration: { books?: BookEntry[]; token?: string; google?: LocalGoogleConnection; microsoft?: LocalMicrosoftConnection; host?: "server" } = {}) {
  const books = configuration.books ?? [book({ autopilotHost: configuration.host })];
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: configuration.token ?? "ghp_token", books, ui: { ...DEFAULT_SETTINGS.ui, language } } });
  useConnectionStore.setState({ hydrated: true, configuration: { ...(configuration.google ? { google: configuration.google } : {}), ...(configuration.microsoft ? { microsoft: configuration.microsoft } : {}) } });
  await i18n.changeLanguage(language);
  render(<MemoryRouter><AiCallsCard book={books[0]} /></MemoryRouter>);
  await screen.findByRole("heading", { level: 2 });
}

const radio = (name: string) => screen.getByRole("radio", { name });
const saved = () => useSettingsStore.getState().settings.books.map((entry) => entry.aiCallsCopy);

beforeEach(() => { wire(); save.mockClear(); });
afterEach(async () => {
  cleanup();
  window.localStorage.removeItem("narrarium.aiCalls.recording.v1");
  resetRecordingForTests();
  stopCopiesRuntimeForTests();
  resetCopyServicesForTests();
  useConnectionStore.setState({ hydrated: true, configuration: {} });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe.each(["en", "it"] as const)("the AI calls tab in %s", (language) => {
  const text = TEXTS[language];

  it("is a real radio group of four choices in one fieldset, with None chosen by default", async () => {
    await open(language, { google: google(), microsoft: microsoft() });
    const group = screen.getByRole("group", { name: text.legend });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((input) => (input as HTMLInputElement).value)).toEqual(["none", "github", "google-drive", "onedrive"]);
    expect(new Set(radios.map((input) => (input as HTMLInputElement).name)).size).toBe(1);
    expect(radios.map((input) => (input as HTMLInputElement).checked)).toEqual([true, false, false, false]);
    expect(radios.every((input) => !(input as HTMLInputElement).disabled)).toBe(true);
    expect(radio(text.none)).toHaveAccessibleDescription(/\S/);
  });

  it("shows the privacy sentence next to the choice, in the words of the owner, and ties it to the group", async () => {
    await open(language, { google: google() });
    const sentence = screen.getByText(text.privacy);
    expect(sentence).toBeInTheDocument();
    expect(screen.getByRole("group", { name: text.legend })).toHaveAttribute("aria-describedby", expect.stringContaining(sentence.parentElement!.id));
  });

  it("says what This device keeps, with the budget and what it uses, and has one switch: whether the messages of this book are kept here, on by default", async () => {
    await seedTask(wiredStore(), "a1", "2026-11-20T10:00:00.000Z");
    await open(language, { google: google() });
    const section = screen.getByRole("region", { name: text.device });
    expect(section).toHaveTextContent(text.budget);
    expect(within(section).queryByRole("checkbox")).toBeNull();
    const recording = within(section).getByRole("switch", { name: text.recording });
    expect(recording).toBeChecked();
    expect(recording).toHaveAccessibleDescription(/\S/);
    await waitFor(() => expect(section).toHaveTextContent(/1 task|1 compito/));
    expect(screen.queryByRole("region", { name: text.server })).toBeNull();
  });

  it("turns the recording of this book off and on for this device only: nothing is saved with the account's settings", async () => {
    await open(language, { google: google() });
    const recording = screen.getByRole("switch", { name: text.recording });
    const before = recording.getAttribute("aria-describedby");
    fireEvent.click(recording);
    expect(recording).not.toBeChecked();
    expect(isRecording(BOOK)).toBe(false);
    expect(recording.getAttribute("aria-describedby")).toBe(before);
    expect(document.getElementById(before!)).toHaveTextContent(language === "it" ? /Disattivo/ : /Off:/);
    expect(save).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem("narrarium.aiCalls.recording.v1") ?? "[]")).toEqual([BOOK]);
    fireEvent.click(recording);
    expect(recording).toBeChecked();
    expect(isRecording(BOOK)).toBe(true);
    expect(window.localStorage.getItem("narrarium.aiCalls.recording.v1")).toBeNull();
  });

  it("says, for a book that runs on the personal server, that the switch is about the copy this device keeps", async () => {
    await open(language, { host: "server" });
    const recording = screen.getByRole("switch", { name: text.recording });
    expect(document.getElementById(recording.getAttribute("aria-describedby")!)).toHaveTextContent(language === "it" ? /server personale ha mandato/ : /personal server sent/);
  });

  it("lists the personal server only when the book runs there, always on, with the private folder said", async () => {
    await open(language, { host: "server" });
    const section = screen.getByRole("region", { name: text.server });
    expect(section).toHaveTextContent(language === "it" ? "cartella privata del libro sul server, fuori da git" : "book's private folder on the server, outside git");
    expect(within(section).queryByRole("radio")).toBeNull();
  });

  it("disables a place without a connection and says how to connect it, with a link to Settings → Account", async () => {
    await open(language, { books: [book({ storageMode: "local-only" })], token: "" });
    for (const name of [text.github, text.google, text.onedrive]) expect(radio(name)).toBeDisabled();
    expect(radio(text.none)).toBeEnabled();
    const links = screen.getAllByRole("link", { name: text.link });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute("href", "/app/account-sync");
    expect(radio(text.github)).toHaveAccessibleDescription(language === "it" ? /non ha un repository GitHub/ : /no GitHub repository/);
    expect(radio(text.google)).toHaveAccessibleDescription(new RegExp(text.notConnected.replace(".", "\\.")));
    fireEvent.click(radio(text.google));
    expect(saved()).toEqual([undefined]);
  });

  it("offers the places the author has, and GitHub for a book that is on GitHub with a token", async () => {
    await open(language, { google: google(), microsoft: microsoft() });
    for (const name of [text.github, text.google, text.onedrive]) expect(radio(name)).toBeEnabled();
  });

  it("saves the choice at once, for this book only, with the account's settings, and says so politely", async () => {
    const other = book({ id: "book-2", repo: "other", aiCallsCopy: "onedrive" });
    await open(language, { books: [book(), other], google: google(), microsoft: microsoft() });

    fireEvent.click(radio(text.google));

    await waitFor(() => expect(saved()).toEqual(["google-drive", "onedrive"]));
    expect(save).toHaveBeenCalledTimes(1);
    const status = await screen.findByText(text.savedGoogle);
    expect(status.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
    expect(radio(text.google)).toBeChecked();
    expect(screen.queryByRole("button", { name: /^(Save|Salva)$/ })).toBeNull();

    fireEvent.click(radio(text.none));
    await waitFor(() => expect(saved()).toEqual([undefined, "onedrive"]));
    expect(await screen.findByText(text.savedNone)).toBeInTheDocument();
    expect(useSettingsStore.getState().settings.books[0]).not.toHaveProperty("aiCallsCopy");
  });

  it("shows the saved choice of the book, and can be changed while a run goes on (it is not a run setting)", async () => {
    await open(language, { books: [book({ aiCallsCopy: "google-drive" })], google: google() });
    expect(radio(text.google)).toBeChecked();
    expect(screen.getByRole("group", { name: text.legend })).not.toHaveAttribute("disabled");
    fireEvent.click(radio(text.none));
    await waitFor(() => expect(saved()).toEqual([undefined]));
  });

  it("stops waiting for the place it leaves, but never deletes what was copied there", async () => {
    await fake.outbox.put({ bookId: BOOK, taskId: "t1", target: "google-drive", attempts: 0, nextAt: 0, error: null, scope: SCOPE });
    await open(language, { books: [book({ aiCallsCopy: "google-drive" })], google: google(), microsoft: microsoft() });
    fireEvent.click(radio(text.onedrive));
    await waitFor(() => expect(saved()).toEqual(["onedrive"]));
    await waitFor(async () => expect((await fake.outbox.list()).filter((item) => item.target === "google-drive")).toEqual([]));
    expect(fake.removed).toEqual([]);
  });

  it("offers «Reconnect» for a connection whose sign-in must be renewed, as a link to the account page", async () => {
    await open(language, { microsoft: microsoft("needs-auth"), google: google() });
    const link = screen.getByRole("link", { name: text.reconnect("OneDrive") });
    expect(link).toHaveAttribute("href", "/app/account-sync");
    expect(radio(text.onedrive)).toHaveAccessibleDescription(new RegExp(text.renew.replace(".", "\\.")));
    expect(screen.queryByRole("link", { name: text.reconnect("Google Drive") })).toBeNull();
  });

  it("says the copy is waiting for a lapsed sign-in as «Reconnect», with the number of tasks", async () => {
    for (const taskId of ["a", "b"]) await fake.outbox.put({ bookId: BOOK, taskId, target: "onedrive", attempts: 1, nextAt: Date.now() + 60_000, error: "reconnect", scope: SCOPE });
    await open(language, { books: [book({ aiCallsCopy: "onedrive" })], microsoft: microsoft("needs-auth") });
    expect(await screen.findByText(text.reconnectWaiting)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: text.reconnect("OneDrive") }).length).toBeGreaterThanOrEqual(1);
  });

  it("says how many tasks wait, and that the device is offline", async () => {
    fake.online = false;
    for (let index = 0; index < 14; index += 1) await fake.outbox.put({ bookId: BOOK, taskId: `t${index}`, target: "google-drive", attempts: 0, nextAt: 0, error: null, scope: SCOPE });
    await open(language, { books: [book({ aiCallsCopy: "google-drive" })], google: google() });
    expect(await screen.findByText(text.waitingOffline)).toBeInTheDocument();
  });

  it("says up to when the copy is done, with the size of the archive and its cap", async () => {
    await fake.ledger.write(BOOK, "google-drive", SCOPE, { target: "google-drive", copied: { a: ["2026/11/20", 1024 * 1024] }, bytes: 1024 * 1024, copiedUpTo: "2026-11-20T10:00:00.000Z", warning: null, skipped: [], trimmedDays: 2 });
    await open(language, { books: [book({ aiCallsCopy: "google-drive" })], google: google() });
    const state = await screen.findByTestId("ai-calls-state");
    await waitFor(() => expect(state).toHaveTextContent(text.copiedUpTo));
    expect(state.querySelector("time")).toHaveAttribute("datetime", "2026-11-20T10:00:00.000Z");
    expect(screen.getByText(text.archive)).toBeInTheDocument();
    expect(screen.getByText(text.archive)).toHaveTextContent(/1 MiB/);
    expect(screen.getByText(text.archive)).toHaveTextContent(language === "it" ? "2 giorni più vecchi sono stati eliminati" : "2 oldest days were deleted");
  });

  it("says nothing has been copied yet when nothing was", async () => {
    await open(language, { books: [book({ aiCallsCopy: "onedrive" })], microsoft: microsoft() });
    expect(await screen.findByText(text.nothing)).toBeInTheDocument();
  });

  it("says a public repository is refused as soon as it is chosen, before any copy", async () => {
    wire({ prepareError: new CopyError("public-repository") });
    await open(language, { google: google() });
    fireEvent.click(radio(text.github));
    expect(await screen.findByText(text.pub)).toBeInTheDocument();
    expect(radio(text.github)).toBeChecked();
  });

  it("says a full GitHub archive has stopped copying", async () => {
    await fake.ledger.write(BOOK, "github", SCOPE, { target: "github", copied: {}, bytes: 512 * 1024 * 1024, copiedUpTo: null, warning: "archive-full", skipped: [], trimmedDays: 0 });
    await open(language, { books: [book({ aiCallsCopy: "github" })] });
    expect(await screen.findByText(text.archiveFull)).toBeInTheDocument();
  });

  it("deletes the copies only on an explicit second choice, with a confirmation that can be cancelled", async () => {
    await open(language, { books: [book({ aiCallsCopy: "google-drive" })], google: google() });
    fireEvent.click(await screen.findByRole("button", { name: text.deleteCopies }));
    const dialog = await screen.findByRole("dialog", { name: text.confirmTitle });
    expect(fake.removed).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: text.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.removed).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: text.deleteCopies }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: text.confirm }));
    await waitFor(() => expect(fake.removed).toEqual(["google-drive"]));
    expect(await screen.findByText(text.deleted)).toBeInTheDocument();
    expect(saved()).toEqual(["google-drive"]);
  });

  it("puts the focus back on the button that opened the confirmation when it closes, and traps it while it is open", async () => {
    await open(language, { books: [book({ aiCallsCopy: "google-drive" })], google: google() });
    const button = await screen.findByRole("button", { name: text.deleteCopies });
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("keeps listing a place the author left while its copies are there, so they can be deleted", async () => {
    await fake.ledger.write(BOOK, "onedrive", SCOPE, { target: "onedrive", copied: { a: ["2026/11/20", 5000] }, bytes: 5000, copiedUpTo: "2026-11-20T10:00:00.000Z", warning: null, skipped: [], trimmedDays: 0 });
    await open(language, { microsoft: microsoft() });
    const button = await screen.findByRole("button", { name: language === "it" ? "Elimina le copie in OneDrive" : "Delete the copies in OneDrive" });
    expect(screen.getByText(language === "it" ? "Le copie già fatte restano in OneDrive finché non le elimini da lì." : "Copies already made stay in OneDrive until you delete them there.")).toBeInTheDocument();
    fireEvent.click(button);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: text.confirm }));
    await waitFor(() => expect(fake.removed).toEqual(["onedrive"]));
  });

  it("deletes the records of a browser book on the device, and says so; for a server book on the device and the server together", async () => {
    await open(language);
    fireEvent.click(screen.getByRole("button", { name: text.deleteRecords }));
    const dialog = await screen.findByRole("dialog", { name: text.recordsTitle });
    expect(dialog).toHaveTextContent(text.recordsDevice);
    expect(dialog).not.toHaveTextContent(text.recordsServer);
    fireEvent.click(within(dialog).getByRole("button", { name: text.deleteRecords }));
    await waitFor(() => expect(fake.recordsDeleted).toEqual([[BOOK, "browser"]]));
    cleanup();

    await open(language, { host: "server" });
    fireEvent.click(screen.getByRole("button", { name: text.deleteRecords }));
    expect(await screen.findByRole("dialog", { name: text.recordsTitle })).toHaveTextContent(text.recordsServer);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: text.deleteRecords }));
    await waitFor(() => expect(fake.recordsDeleted).toEqual([[BOOK, "browser"], [BOOK, "server"]]));
  });

  it("has no text smaller than the readable minimum and no state shown by colour alone", async () => {
    await open(language, { google: google("needs-auth"), books: [book({ aiCallsCopy: "google-drive" })] });
    await screen.findByTestId("ai-calls-state");
    expect(document.body.innerHTML).not.toMatch(/text-\[(?:[0-9]|1[01])px\]/);
    expect(screen.getByRole("link", { name: text.reconnect("Google Drive") })).toBeVisible();
  });
});

function wiredStore(): MemoryAiCallStore { return fake.store; }

describe("the tab keeps what it needs out of the entry", () => {
  it("is registered lazily, with its label in the tab list", async () => {
    const { tabOfHash } = await import("@/components/autopilot/config/ConfigTabs");
    expect(tabOfHash("#autopilot-calls")).toBe("calls");
  });
});


describe("a book on GitHub without a token", () => {
  it("says it has none and links to the GitHub token in Settings", async () => {
    await open("en", { token: "", google: google() });
    expect(radio("This book's GitHub repository")).toBeDisabled();
    expect(screen.getByRole("link", { name: "Add a token in Settings → GitHub" })).toHaveAttribute("href", "/app/settings/github");
  });
});

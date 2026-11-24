import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { planPagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";

const env = vi.hoisted(() => ({
  octokit: null as unknown as Octokit,
  save: vi.fn(async () => true),
  inspect: vi.fn(),
  apply: vi.fn(),
}));
vi.mock("@/repository/githubRequest", () => ({ createTrackedGitHubClient: () => env.octokit }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: env.save }) }));
vi.mock("@/readerAccess/sealedBox", () => ({ sealSecret: (value: string) => `sealed:${value.length}` }));
vi.mock("@/readerUpdate/inspect", () => ({ inspectReaderUpdate: env.inspect }));
vi.mock("@/readerUpdate/apply", () => ({ applyReaderUpdate: env.apply }));
vi.mock("@/narrarium/bookTemplate", async (importOriginal) => ({ ...await importOriginal<typeof import("@/narrarium/bookTemplate")>(), loadBookTemplate: async () => ({ format: 1, placeholders: { package: "p", readerPackage: "r" }, files: {} }) }));

import i18n from "@/i18n";
import { ReaderTabContent } from "@/components/book/readerAccess/ReaderTabContent";
import { ReaderUpdateNotice } from "@/components/book/readerAccess/ReaderUpdateNotice";
import { CustomizedWorkflowRefused } from "@/readerUpdate/commit";
import { decideReaderUpdate, type ReaderUpdateInputs } from "@/readerUpdate/decision";
import type { ReaderFolderPlan } from "@/readerUpdate/folderPlan";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { createFakeReaderGitHub, type FakeReaderGitHub } from "./helpers/fakeReaderGitHub";
import v1 from "./fixtures/pagesWorkflowV1.yml?raw";

const folder = (overrides: Partial<ReaderFolderPlan> = {}): ReaderFolderPlan => ({
  present: true,
  writes: [
    { path: "reader/src/lib/book.ts", content: "new", change: "replaced", expectedHash: "h1" },
    { path: "reader/src/lib/reader-passwords.ts", content: "added", change: "added", expectedHash: null },
  ],
  deletes: [], unchanged: 70, kept: ["reader/.env"], version: "0.1.61", ...overrides,
});
const legacy = v1.replace("          SITE_BASE:", "          NARRARIUM_READER_PASSWORD: ${{ secrets.BOOK_PASSWORD }}\n          SITE_BASE:");
const current = planPagesWorkflowUpgrade(v1).text;
const inputs = (overrides: Partial<ReaderUpdateInputs> = {}): ReaderUpdateInputs => ({ storage: "github", workingCopy: true, workflowText: legacy, folder: folder(), branch: "main", online: true, credential: true, localChanges: false, ...overrides });
const found = (overrides: Partial<ReaderUpdateInputs> = {}) => ({ decision: decideReaderUpdate(inputs(overrides)), workflowHash: "wf", checkedAt: 1 });

let github: FakeReaderGitHub;
let counter = 0;
let book: BookEntry;

const TEXTS = {
  en: {
    title: "Update the reader", exposure: "Your published book is less private than it looks", exposureBody: /still publishes the EPUB \(downloads\/book\.epub\) and the titles of the chapters in clear/, what: "What the update changes",
    workflow: /Updates the workflow so that the reader can have several passwords/, legacy: /The password you use today \(the secret NARRARIUM_READER_PASSWORD\) stays valid/, folder: /Replaces 1 files of the reader\/ folder and adds 1, at the version 0\.1\.61/, untouched: /The files of your book/,
    now: /Narrarium makes one commit on the branch “main”/, noCredential: /This book has no GitHub credential on this device/, offline: /You are offline/, otherBranch: /“draft” is not a branch the workflow publishes from/, update: "Update the reader",
    customized: "This workflow has edits of yours", replace: "Replace my edits with the standard workflow", needed: /Tick “Replace my edits” to update/, published: /The update is committed on “main” and published \(commit abc1234\)/, local: /committed on this device\. It is published at the next sync/,
    waiting: /Waiting for GitHub to start the publication/, current: /The reader of this book is up to date: its workflow and its reader\/ folder are the ones of version 0\.1\.61/, check: "Check now", protectedResult: /Protected: the EPUB answers 404/, exposed: /The EPUB is still published in clear \(it answered 200\)/, unreachable: /The browser cannot read the answer/, copy: "Copy the line",
    refused: /“Replace my edits” was not ticked: nothing was committed/, changed: /A file changed after it was checked/, permission: /lacks the permission “Workflows”/, noticeTitle: "The reader of this book is out of date", noticePassword: /published with a password but an old reader/, noticeGo: "Open the Online reader tab", files: "Show the files", paused: /The publishing workflow is paused on GitHub/,
  },
  it: {
    title: "Aggiorna il lettore", exposure: "Il tuo libro pubblicato è meno riservato di quanto sembra", exposureBody: /pubblica ancora l'EPUB \(downloads\/book\.epub\) e i titoli dei capitoli in chiaro/, what: "Cosa cambia l'aggiornamento",
    workflow: /Aggiorna il workflow perché il lettore possa avere più password/, legacy: /La password che usi oggi \(il segreto NARRARIUM_READER_PASSWORD\) resta valida/, folder: /Sostituisce 1 file della cartella reader\/ e ne aggiunge 1, alla versione 0\.1\.61/, untouched: /I file del tuo libro/,
    now: /Narrarium fa un solo commit sul ramo “main”/, noCredential: /Questo libro non ha una credenziale GitHub su questo dispositivo/, offline: /Sei offline/, otherBranch: /“draft” non è un ramo da cui il workflow pubblica/, update: "Aggiorna il lettore",
    customized: "Questo workflow ha modifiche tue", replace: "Sostituisci le mie modifiche con il workflow standard", needed: /Spunta “Sostituisci le mie modifiche” per aggiornare/, published: /L'aggiornamento è salvato su “main” e pubblicato \(commit abc1234\)/, local: /salvato su questo dispositivo\. Viene pubblicato alla prossima sincronizzazione/,
    waiting: /In attesa che GitHub avvii la pubblicazione/, current: /Il lettore di questo libro è aggiornato: il suo workflow e la sua cartella reader\/ sono quelli della versione 0\.1\.61/, check: "Controlla ora", protectedResult: /Protetto: l'EPUB risponde 404/, exposed: /L'EPUB è ancora pubblicato in chiaro \(ha risposto 200\)/, unreachable: /Il browser non riesce a leggere la risposta/, copy: "Copia la riga",
    refused: /“Sostituisci le mie modifiche” non era spuntato: non è stato salvato nulla/, changed: /Un file è cambiato dopo il controllo/, permission: /non ha il permesso “Workflows”/, noticeTitle: "Il lettore di questo libro è vecchio", noticePassword: /pubblicato con una password ma con un lettore vecchio/, noticeGo: "Apri la scheda Lettore online", files: "Mostra i file", paused: /Il workflow di pubblicazione è in pausa su GitHub/,
  },
} as const;

beforeEach(() => {
  counter += 1;
  book = { id: `reader-update-${counter}`, owner: "me", repo: "book", name: "Book", tokenIndex: null, activeBranch: "main", addedAt: "2026-11-01T00:00:00.000Z" };
  github = createFakeReaderGitHub();
  github.pages.enabled = true;
  env.octokit = github.octokit;
  env.save.mockClear();
  env.inspect.mockReset().mockImplementation(async () => found());
  env.apply.mockReset();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "github_pat_default", books: [book] } });
});
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); useSettingsStore.setState({ settings: DEFAULT_SETTINGS }); await i18n.changeLanguage("en"); });

async function open(language: "en" | "it") {
  await i18n.changeLanguage(language);
  render(<ReaderTabContent book={book} />);
}
const card = () => screen.getByTestId("reader-update-card");

describe.each(["en", "it"] as const)("Update the reader in %s", (language) => {
  const text = TEXTS[language];

  it("warns, in plain words, that a book published with a password and an old reader exposes its EPUB and titles, and says what the update changes", async () => {
    await open(language);
    const exposure = await screen.findByTestId("reader-update-exposure");
    expect(within(exposure).getByText(text.exposure)).toBeInTheDocument();
    expect(within(exposure).getByText(text.exposureBody)).toBeInTheDocument();
    const scope = within(card());
    expect(scope.getByText(text.what)).toBeInTheDocument();
    expect(scope.getByText(text.workflow)).toBeInTheDocument();
    expect(scope.getByText(text.legacy)).toBeInTheDocument();
    expect(scope.getByText(text.folder)).toBeInTheDocument();
    expect(scope.getByText(text.untouched)).toBeInTheDocument();
    expect(scope.getByText(text.now)).toBeInTheDocument();
    expect(scope.getByRole("button", { name: text.update })).toBeEnabled();
    expect(env.apply).not.toHaveBeenCalled();
  });

  it("lists the files only when asked, under the headings of what is replaced and what is added", async () => {
    await open(language);
    await screen.findByTestId("reader-update-exposure");
    const summary = within(card()).getByText(text.files);
    fireEvent.click(summary);
    expect(within(card()).getByText("reader/src/lib/book.ts")).toBeInTheDocument();
    expect(within(card()).getByText("reader/src/lib/reader-passwords.ts")).toBeInTheDocument();
  });

  it("says, for each reason the commit cannot be published now, that it stays on this device and that the site stays exposed until the next sync", async () => {
    for (const [overrides, expected] of [[{ credential: false }, text.noCredential], [{ online: false }, text.offline]] as const) {
      env.inspect.mockImplementation(async () => found(overrides));
      await open(language);
      expect(await within(card()).findByText(expected)).toBeInTheDocument();
      cleanup();
      counter += 1;
      book = { ...book, id: `reader-update-${counter}` };
    }
    env.inspect.mockImplementation(async () => found({ branch: "draft" }));
    book = { ...book, id: `reader-update-draft-${counter}`, activeBranch: "draft" };
    await open(language);
    expect(await within(card()).findByText(text.otherBranch)).toBeInTheDocument();
  });

  it("commits once on the button, says it was published, and follows the publication of that commit until its run is there", async () => {
    env.apply.mockResolvedValue({ commitSha: "abc1234def", published: true, paths: ["x"] });
    await open(language);
    await screen.findByTestId("reader-update-exposure");
    fireEvent.click(within(card()).getByRole("button", { name: text.update }));
    expect(await screen.findByText(text.published)).toBeInTheDocument();
    expect(env.apply).toHaveBeenCalledTimes(1);
    expect(env.apply.mock.calls[0][0]).toMatchObject({ branch: "main", replaceEdits: false, workflowHash: "wf" });
    expect(within(screen.getByTestId("reader-update-outcome")).getByText(text.waiting)).toBeInTheDocument();
  });

  it("shows the run of the commit that was published, and offers the outside check once that run has succeeded", async () => {
    env.apply.mockImplementation(async () => {
      github.runs.unshift({ id: 9, status: "completed", conclusion: "success", html_url: "https://github.com/me/book/actions/runs/9", created_at: "2026-11-25T10:00:00Z", head_branch: "main", head_sha: "abc1234def" });
      return { commitSha: "abc1234def", published: true, paths: ["x"] };
    });
    await open(language);
    await screen.findByTestId("reader-update-exposure");
    fireEvent.click(within(card()).getByRole("button", { name: text.update }));
    const outcome = await screen.findByTestId("reader-update-outcome");
    await waitFor(() => expect(within(outcome).getByRole("link", { name: /GitHub/ })).toHaveAttribute("href", "https://github.com/me/book/actions/runs/9"));
    expect(await screen.findByTestId("reader-outside-check")).toBeInTheDocument();
  });

  it("says that the update waits on this device when it could not be published", async () => {
    env.apply.mockResolvedValue({ commitSha: "local-1", published: false, paths: ["x"] });
    await open(language);
    await screen.findByTestId("reader-update-exposure");
    fireEvent.click(within(card()).getByRole("button", { name: text.update }));
    expect(await screen.findByText(text.local)).toBeInTheDocument();
  });

  it("does not let a workflow with edits be replaced without the owner's tick, shows the differing lines, and then passes the tick on", async () => {
    env.inspect.mockImplementation(async () => found({ workflowText: `${current}\n  notify:\n    runs-on: ubuntu-latest\n` }));
    env.apply.mockResolvedValue({ commitSha: "abc1234def", published: false, paths: ["x"] });
    await open(language);
    const section = await screen.findByTestId("reader-update-customized");
    expect(within(section).getByText(text.customized)).toBeInTheDocument();
    expect(within(section).getByText(/notify:/)).toBeInTheDocument();
    const button = within(card()).getByRole("button", { name: text.update });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(text.needed);
    fireEvent.click(within(section).getByRole("checkbox", { name: text.replace }));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(env.apply).toHaveBeenCalledTimes(1));
    expect(env.apply.mock.calls[0][0]).toMatchObject({ replaceEdits: true });
  });

  it("explains a refusal of the customized workflow, a file that changed, and a missing Workflows permission, each as an alert that says nothing was committed", async () => {
    await open(language);
    await screen.findByTestId("reader-update-exposure");
    const button = () => within(card()).getByRole("button", { name: text.update });
    env.apply.mockRejectedValueOnce(new CustomizedWorkflowRefused());
    fireEvent.click(button());
    expect(await within(card()).findByRole("alert")).toHaveTextContent(text.refused);
    env.apply.mockRejectedValueOnce(Object.assign(new Error("File changed"), { code: "REPOSITORY_CONFLICT" }));
    fireEvent.click(button());
    await waitFor(() => expect(within(card()).getByRole("alert")).toHaveTextContent(text.changed));
    env.apply.mockRejectedValueOnce(Object.assign(new Error("refusing to allow an OAuth App to create or update workflow `.github/workflows/deploy-reader-pages.yml` without `workflow` scope"), { status: 404 }));
    fireEvent.click(button());
    await waitFor(() => expect(within(card()).getByRole("alert")).toHaveTextContent(text.permission));
  });

  it("says when the publishing workflow is paused, because Pages was turned off", async () => {
    github.workflowState.value = "disabled_manually";
    await open(language);
    await screen.findByTestId("reader-update-exposure");
    expect(await within(card()).findByText(text.paused)).toBeInTheDocument();
  });

  describe("when the reader is current", () => {
    beforeEach(() => { env.inspect.mockImplementation(async () => found({ workflowText: current, folder: folder({ writes: [] }) })); });

    it("says so, and offers the check from outside: the EPUB must answer 404 and version.json must say protected", async () => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); return url.includes("book.epub") ? { status: 404, ok: false, json: async () => ({}) } : { status: 200, ok: true, json: async () => ({ protected: true }) }; }));
      await open(language);
      expect(await within(card()).findByText(text.current)).toBeInTheDocument();
      expect(within(card()).queryByRole("button", { name: text.update })).toBeNull();
      const outside = await screen.findByTestId("reader-outside-check");
      fireEvent.click(within(outside).getByRole("button", { name: text.check }));
      expect(await within(outside).findByText(text.protectedResult)).toBeInTheDocument();
      expect(calls[0]).toMatch(/^https:\/\/me\.github\.io\/book\/downloads\/book\.epub\?check=\d+$/);
      expect(calls[1]).toMatch(/^https:\/\/me\.github\.io\/book\/version\.json\?check=\d+$/);
    });

    it("tells the owner the EPUB is still served when it answers", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}) })));
      await open(language);
      const outside = await screen.findByTestId("reader-outside-check");
      fireEvent.click(within(outside).getByRole("button", { name: text.check }));
      expect(await within(outside).findByText(text.exposed)).toBeInTheDocument();
    });

    it("gives the line to copy when the browser cannot read the answer", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
      await open(language);
      const outside = await screen.findByTestId("reader-outside-check");
      fireEvent.click(within(outside).getByRole("button", { name: text.check }));
      expect(await within(outside).findByText(text.unreachable)).toBeInTheDocument();
      expect(outside.querySelector("pre")?.textContent).toMatch(/^curl -s -o \/dev\/null -w "%\{http_code\}\\n" "https:\/\/me\.github\.io\/book\/downloads\/book\.epub\?check=\d+" && curl -s /);
      expect(within(outside).getByRole("button", { name: text.copy })).toBeInTheDocument();
    });
  });

  describe("the notice in the GitHub tab", () => {
    it("says once that the reader is old, says what it exposes when a password is set, and opens the Online reader tab", async () => {
      await i18n.changeLanguage(language);
      const open = vi.fn();
      render(<ReaderUpdateNotice book={book} onOpen={open} />);
      const notice = await screen.findByTestId("reader-update-notice");
      expect(within(notice).getByText(text.noticeTitle)).toBeInTheDocument();
      expect(within(notice).getByText(text.noticePassword)).toBeInTheDocument();
      fireEvent.click(within(notice).getByRole("button", { name: text.noticeGo }));
      expect(open).toHaveBeenCalledTimes(1);
    });

    it("shows nothing when the reader is current or there is no reader", async () => {
      await i18n.changeLanguage(language);
      env.inspect.mockImplementation(async () => found({ workflowText: current, folder: folder({ writes: [] }) }));
      render(<ReaderUpdateNotice book={book} onOpen={() => undefined} />);
      await waitFor(() => expect(env.inspect).toHaveBeenCalled());
      expect(screen.queryByTestId("reader-update-notice")).toBeNull();
    });
  });
});

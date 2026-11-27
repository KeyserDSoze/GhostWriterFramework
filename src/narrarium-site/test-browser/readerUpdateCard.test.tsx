import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { planPagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";

const env = vi.hoisted(() => ({
  octokit: null as unknown as Octokit,
  save: vi.fn(async () => true),
  inspect: vi.fn(),
  apply: vi.fn(),
  openPr: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("@/repository/githubRequest", () => ({ createTrackedGitHubClient: () => env.octokit }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: env.save }) }));
vi.mock("@/readerAccess/sealedBox", () => ({ sealSecret: (value: string) => `sealed:${value.length}` }));
vi.mock("@/readerUpdate/inspect", () => ({ inspectReaderUpdate: env.inspect }));
vi.mock("@/readerUpdate/apply", () => ({ applyReaderUpdate: env.apply, openReaderUpdatePullRequest: env.openPr }));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({ ...await importOriginal<typeof import("@/repository/repositoryService")>(), syncFullRepository: env.sync }));
vi.mock("@/narrarium/bookTemplate", async (importOriginal) => ({ ...await importOriginal<typeof import("@/narrarium/bookTemplate")>(), loadBookTemplate: async () => ({ format: 1, placeholders: { package: "p", readerPackage: "r" }, files: {} }) }));

import i18n from "@/i18n";
import { ReaderTabContent } from "@/components/book/readerAccess/ReaderTabContent";
import { ReaderUpdateNotice } from "@/components/book/readerAccess/ReaderUpdateNotice";
import { CustomizedWorkflowRefused } from "@/readerUpdate/commit";
import { decideReaderUpdate, type ReaderUpdateInputs } from "@/readerUpdate/decision";
import type { ReaderFolderPlan } from "@/readerUpdate/folderPlan";
import { useSettingsStore } from "@/store/settingsStore";
import { useBranchSyncStore, emptyBookSyncState } from "@/branches/syncStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { usePublicationStore } from "@/readerRun/store";
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
const remoteOk = { pagesOn: true, passwordsSet: true, workflowText: planPagesWorkflowUpgrade(v1).text };
const inputs = (overrides: Partial<ReaderUpdateInputs> = {}): ReaderUpdateInputs => ({ storage: "github", workingCopy: true, workflowText: legacy, folder: folder(), branch: "main", online: true, credential: true, localChanges: false, ...overrides });
const found = (overrides: Partial<ReaderUpdateInputs> = {}) => ({ decision: decideReaderUpdate(inputs(overrides)), workflowHash: "wf", checkedAt: 1 });

let github: FakeReaderGitHub;
let counter = 0;
let book: BookEntry;

const TEXTS = {
  en: {
    title: "Update the reader", exposure: "Your published book is less private than it looks", exposureBody: /still publishes the EPUB \(downloads\/book\.epub\) and the titles of the chapters in clear/, what: "What the update changes",
    workflow: /Updates the workflow so that the reader can have several passwords/, legacy: /The password you use today \(the secret NARRARIUM_READER_PASSWORD\) stays valid/, folder: /Replaces 1 files of the reader\/ folder and adds 1, at the version 0\.1\.61/, untouched: /The files of your book/,
    now: /Narrarium makes one commit on the branch “main”/, noCredential: /This book has no GitHub credential on this device/, offline: /You are offline/, otherBranch: /“draft” is not the branch the reader is published from \(“main” is\)/, update: "Update the reader",
    customized: "This workflow has edits of yours", replace: "Replace my edits with the standard workflow", needed: /Tick “Replace my edits” to update/, published: /The update is committed on “main” and published \(commit abc1234\)/, local: /committed on this device\. It is published at the next sync/,
    waiting: /Waiting for GitHub to start the publication/, current: /The reader of this book is up to date: its workflow and its reader\/ folder are the ones of version 0\.1\.61/, check: "Check now", protectedResult: /Protected: the EPUB answers 404/, exposed: /The EPUB is still published in clear \(it answered 200\)/, unreachable: /The browser cannot read the answer/, copy: "Copy the line",
    refused: /“Replace my edits” was not ticked: nothing was committed/, changed: /A file changed after it was checked/, permission: /lacks the permission “Workflows”/, onDeviceTitle: "Updated on this device, not yet on GitHub", remoteOld: /On GitHub the workflow is the old one/, localCommits: /3 files\) that GitHub does not have yet/, filesSummary: "Show the 3 files not on GitHub yet", syncNow: "Sync now", notSent: /Not sent to GitHub\./, conflict: /choose between two copies of a file/, sentRun: /Waiting for GitHub to start the publication/, pagesOffButton: "Turn GitHub Pages off", pagesOffConfirm: "Turn Pages off", pagesOffDone: /GitHub Pages is off: the old reader is no longer published/, currentUnchecked: /GitHub could not be checked just now/, noCredentialSync: /has no GitHub credential on this device, so nothing can be sent/, offlineSync: /You are offline, so nothing can be sent now/,
    autoFailed: /The last automatic sync could not send it: GitHub did not accept a change to a workflow file/, autoDiverged: /GitHub has newer changes than this device/,
    budgetTitle: "GitHub Actions cannot run: the budget or billing blocks it", budgetBody: /GitHub did not start the publication: “The job was not started because an Actions budget is preventing further use\.”/, billingLink: "Open GitHub billing", publicWarning: /do not do it only for this/, unreadableTitle: "The last publication failed, and the reason could not be read", disabledTitle: "GitHub Actions is disabled",
    noticeTitle: "The reader of this book is out of date", noticePassword: /published with a password but an old reader/, noticeGo: "Open the Online reader tab", files: "Show the files", paused: /The publishing workflow is paused on GitHub/,
  },
  it: {
    title: "Aggiorna il lettore", exposure: "Il tuo libro pubblicato è meno riservato di quanto sembra", exposureBody: /pubblica ancora l'EPUB \(downloads\/book\.epub\) e i titoli dei capitoli in chiaro/, what: "Cosa cambia l'aggiornamento",
    workflow: /Aggiorna il workflow perché il lettore possa avere più password/, legacy: /La password che usi oggi \(il segreto NARRARIUM_READER_PASSWORD\) resta valida/, folder: /Sostituisce 1 file della cartella reader\/ e ne aggiunge 1, alla versione 0\.1\.61/, untouched: /I file del tuo libro/,
    now: /Narrarium fa un solo commit sul ramo “main”/, noCredential: /Questo libro non ha una credenziale GitHub su questo dispositivo/, offline: /Sei offline/, otherBranch: /“draft” non è il ramo da cui il lettore è pubblicato \(lo è “main”\)/, update: "Aggiorna il lettore",
    customized: "Questo workflow ha modifiche tue", replace: "Sostituisci le mie modifiche con il workflow standard", needed: /Spunta “Sostituisci le mie modifiche” per aggiornare/, published: /L'aggiornamento è salvato su “main” e pubblicato \(commit abc1234\)/, local: /salvato su questo dispositivo\. Viene pubblicato alla prossima sincronizzazione/,
    waiting: /In attesa che GitHub avvii la pubblicazione/, current: /Il lettore di questo libro è aggiornato: il suo workflow e la sua cartella reader\/ sono quelli della versione 0\.1\.61/, check: "Controlla ora", protectedResult: /Protetto: l'EPUB risponde 404/, exposed: /L'EPUB è ancora pubblicato in chiaro \(ha risposto 200\)/, unreachable: /Il browser non riesce a leggere la risposta/, copy: "Copia la riga",
    refused: /“Sostituisci le mie modifiche” non era spuntato: non è stato salvato nulla/, changed: /Un file è cambiato dopo il controllo/, permission: /non ha il permesso “Workflows”/, onDeviceTitle: "Aggiornato su questo dispositivo, non ancora su GitHub", remoteOld: /Su GitHub il workflow è quello vecchio/, localCommits: /3 file\) che GitHub non ha ancora/, filesSummary: "Mostra i 3 file non ancora su GitHub", syncNow: "Sincronizza ora", notSent: /Non inviato a GitHub\./, conflict: /scelga tra due copie di un file/, sentRun: /In attesa che GitHub avvii la pubblicazione/, pagesOffButton: "Spegni GitHub Pages", pagesOffConfirm: "Spegni Pages", pagesOffDone: /GitHub Pages è spento: il vecchio lettore non è più pubblicato/, currentUnchecked: /controllare GitHub in questo momento/, noCredentialSync: /non ha una credenziale GitHub su questo dispositivo, quindi non si può inviare nulla/, offlineSync: /Sei offline, quindi ora non si può inviare nulla/,
    autoFailed: /L'ultima sincronizzazione automatica non è riuscita a inviarle: GitHub non ha accettato la modifica di un file di workflow/, autoDiverged: /GitHub modifiche più recenti|su GitHub modifiche più recenti/,
    budgetTitle: "GitHub Actions non può girare: lo blocca il budget o la fatturazione", budgetBody: /GitHub non ha avviato la pubblicazione: “The job was not started because an Actions budget is preventing further use\.”/, billingLink: "Apri la fatturazione di GitHub", publicWarning: /non farlo solo per questo/, unreadableTitle: "L'ultima pubblicazione è fallita, e il motivo non si è potuto leggere", disabledTitle: "GitHub Actions è disattivato",
    noticeTitle: "Il lettore di questo libro è vecchio", noticePassword: /pubblicato con una password ma con un lettore vecchio/, noticeGo: "Apri la scheda Lettore online", files: "Mostra i file", paused: /Il workflow di pubblicazione è in pausa su GitHub/,
  },
} as const;

beforeEach(() => {
  localStorage.clear();
  usePublicationStore.setState({ entries: {}, live: {} });
  counter += 1;
  book = { id: `reader-update-${counter}`, owner: "me", repo: "book", name: "Book", tokenIndex: null, activeBranch: "main", addedAt: "2026-11-01T00:00:00.000Z" };
  github = createFakeReaderGitHub();
  github.pages.enabled = true;
  env.octokit = github.octokit;
  env.save.mockClear();
  env.inspect.mockReset().mockImplementation(async () => found());
  env.apply.mockReset();
  env.openPr.mockReset();
  env.sync.mockReset();
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
    env.inspect.mockImplementation(async () => found({ branch: "draft", publishingBranch: "main" }));
    book = { ...book, id: `reader-update-draft-${counter}`, activeBranch: "draft" };
    await open(language);
    expect(await within(card()).findByText(text.otherBranch)).toBeInTheDocument();
  });

  it("commits once on the button, says it was published, and follows the publication of that commit until its run is there", async () => {
    env.apply.mockResolvedValue({ commitSha: "abc1234def", published: true, paths: ["x"], publishedBranch: "main", branches: [{ branch: "main", role: "current", status: "published", commitSha: "abc1234def" }] });
    await open(language);
    await screen.findByTestId("reader-update-exposure");
    fireEvent.click(within(card()).getByRole("button", { name: text.update }));
    expect(await screen.findByText(text.published)).toBeInTheDocument();
    expect(env.apply).toHaveBeenCalledTimes(1);
    expect(env.apply.mock.calls[0][0]).toMatchObject({ branch: "main", replaceEdits: false, workflowHash: "wf" });
    // Its run is looked for by the commit that was pushed, and followed live under the result until it ends.
    const publication = await screen.findByTestId("reader-publication");
    expect(publication).toHaveAttribute("data-phase", "waiting");
  });

  it("shows the run of the commit that was published, and offers the outside check once that run has succeeded", async () => {
    env.apply.mockImplementation(async () => {
      github.runs.unshift({ id: 9, status: "completed", conclusion: "success", html_url: "https://github.com/me/book/actions/runs/9", created_at: "2026-11-25T10:00:00Z", head_branch: "main", head_sha: "abc1234def", event: "push" });
      return { commitSha: "abc1234def", published: true, paths: ["x"], publishedBranch: "main", branches: [{ branch: "main", role: "current", status: "published", commitSha: "abc1234def" }] };
    });
    await open(language);
    await screen.findByTestId("reader-update-exposure");
    fireEvent.click(within(card()).getByRole("button", { name: text.update }));
    const publication = await screen.findByTestId("reader-publication");
    await waitFor(() => expect(publication).toHaveAttribute("data-phase", "succeeded"));
    expect(within(publication).getByRole("link", { name: /GitHub/ })).toHaveAttribute("href", "https://github.com/me/book/actions/runs/9");
    expect(await screen.findByTestId("reader-outside-check")).toBeInTheDocument();
  });

  it("says that the update waits on this device when it could not be published", async () => {
    env.apply.mockResolvedValue({ commitSha: "local-1", published: false, paths: ["x"], publishedBranch: null, branches: [{ branch: "main", role: "current", status: "local", commitSha: "local-1" }] });
    await open(language);
    await screen.findByTestId("reader-update-exposure");
    fireEvent.click(within(card()).getByRole("button", { name: text.update }));
    expect(await screen.findByText(text.local)).toBeInTheDocument();
  });

  it("does not let a workflow with edits be replaced without the owner's tick, shows the differing lines, and then passes the tick on", async () => {
    env.inspect.mockImplementation(async () => found({ workflowText: `${current}\n  notify:\n    runs-on: ubuntu-latest\n` }));
    env.apply.mockResolvedValue({ commitSha: "abc1234def", published: false, paths: ["x"], publishedBranch: null, branches: [{ branch: "main", role: "current", status: "local", commitSha: "abc1234def" }] });
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

  describe("on a branch that is not the one the reader is published from", () => {
    const publishingRead = (workflowText: string | null = legacy) => ({ branch: "main", source: "github" as const, headSha: "head-1", workflowText, workflowHash: null, folder: folder() });
    const onFeature = (overrides: Partial<ReaderUpdateInputs> = {}) => found({ branch: "feature/x", publishingBranch: "main", publishing: publishingRead(), ...overrides });
    const branchText = language === "en"
      ? { states: "Branches", publishing: "“main” (publishes the reader)", current: "“feature/x” (this branch)", old: "old reader: it needs the update", updated: "reader up to date", both: /one commit on “main”, the branch the reader is published from, directly on GitHub, and one on “feature\/x”/, later: /“main”, the branch the reader is published from, cannot be reached now \(you are offline\)/, same: /Both branches get the same files/, published: /“main”: updated on GitHub \(commit abc1234\)/, protectedLine: /“main” is protected.*GitHub said: “Changes must be made through a pull request\.”/, openPr: "Open a pull request", prLink: "Open pull request #7 on GitHub", pending: /not updated yet, it could not be reached now/, changed: /“main” changed after the check/ }
      : { states: "Rami", publishing: "“main” (pubblica il lettore)", current: "“feature/x” (questo ramo)", old: "lettore vecchio: serve l'aggiornamento", updated: "lettore aggiornato", both: /un commit su “main”, il ramo da cui il lettore è pubblicato, direttamente su GitHub, e uno su “feature\/x”/, later: /“main”, il ramo da cui il lettore è pubblicato, non è raggiungibile ora \(sei offline\)/, same: /I due rami ricevono gli stessi file/, published: /“main”: aggiornato su GitHub \(commit abc1234\)/, protectedLine: /“main” è protetto.*GitHub ha detto: «Changes must be made through a pull request\.»/, openPr: "Apri una pull request", prLink: "Apri la pull request #7 su GitHub", pending: /non ancora aggiornato, non era raggiungibile ora/, changed: /“main” è cambiato dopo il controllo/ };

    beforeEach(() => { book = { ...book, id: `reader-update-feature-${counter}`, activeBranch: "feature/x" }; });

    it("names the branches and what each one has, and says the update is made on both with the same files", async () => {
      env.inspect.mockImplementation(async () => onFeature());
      await open(language);
      const branches = await screen.findByTestId("reader-branches");
      expect(within(branches).getByText(branchText.states)).toBeInTheDocument();
      const items = within(branches).getAllByRole("listitem");
      expect(items[0]).toHaveTextContent(branchText.publishing);
      expect(items[0]).toHaveTextContent(branchText.old);
      expect(items[1]).toHaveTextContent(branchText.current);
      expect(within(card()).getByText(branchText.both)).toBeInTheDocument();
      expect(within(card()).getByText(branchText.same)).toBeInTheDocument();
      expect(within(card()).getAllByTestId("reader-update-plan")).toHaveLength(1);
    });

    it("says that only the publishing branch is old when this branch is already updated", async () => {
      env.inspect.mockImplementation(async () => onFeature({ workflowText: current, folder: folder({ writes: [] }) }));
      await open(language);
      const branches = await screen.findByTestId("reader-branches");
      expect(within(branches).getAllByRole("listitem")[0]).toHaveTextContent(branchText.old);
      expect(within(branches).getAllByRole("listitem")[1]).toHaveTextContent(branchText.updated);
    });

    it("says that it stays on this device, not yet on main, when main cannot be reached", async () => {
      env.inspect.mockImplementation(async () => found({ branch: "feature/x", publishingBranch: "main", online: false }));
      await open(language);
      expect(await within(card()).findByText(branchText.later)).toBeInTheDocument();
    });

    it("reports each branch after the update, and the one that was not reached", async () => {
      env.inspect.mockImplementation(async () => onFeature());
      env.apply.mockResolvedValue({ commitSha: "abc1234def", published: true, paths: ["x"], publishedBranch: "main", branches: [{ branch: "main", role: "publishing", status: "published", commitSha: "abc1234def" }, { branch: "feature/x", role: "current", status: "local", commitSha: "l1" }] });
      await open(language);
      await screen.findByTestId("reader-branches");
      fireEvent.click(within(card()).getByRole("button", { name: text.update }));
      const outcome = await screen.findByTestId("reader-update-outcome");
      expect(within(outcome).getByText(branchText.published)).toBeInTheDocument();
      expect(within(outcome).getAllByRole("listitem")).toHaveLength(2);
      expect(env.apply.mock.calls[0][0]).toMatchObject({ branch: "feature/x" });
    });

    it("says a branch that moved was left alone, and one that was not reached is not yet updated", async () => {
      env.inspect.mockImplementation(async () => onFeature());
      env.apply.mockResolvedValue({ commitSha: "l1", published: false, paths: ["x"], publishedBranch: null, branches: [{ branch: "main", role: "publishing", status: "changed" }, { branch: "feature/x", role: "current", status: "local", commitSha: "l1" }] });
      await open(language);
      await screen.findByTestId("reader-branches");
      fireEvent.click(within(card()).getByRole("button", { name: text.update }));
      expect(await within(await screen.findByTestId("reader-update-outcome")).findByText(branchText.changed)).toBeInTheDocument();
      cleanup();
      env.apply.mockResolvedValue({ commitSha: "l1", published: false, paths: ["x"], publishedBranch: null, branches: [{ branch: "main", role: "publishing", status: "pending" }, { branch: "feature/x", role: "current", status: "local", commitSha: "l1" }] });
      book = { ...book, id: `reader-update-feature-b-${counter}` };
      await open(language);
      await screen.findByTestId("reader-branches");
      fireEvent.click(within(card()).getByRole("button", { name: text.update }));
      expect(await within(await screen.findByTestId("reader-update-outcome")).findByText(branchText.pending)).toBeInTheDocument();
    });

    it("says that main is protected with GitHub's own words and offers the pull request, which opens in a new tab once made", async () => {
      env.inspect.mockImplementation(async () => onFeature());
      const offer = { base: "main", baseHeadSha: "head-1", title: "Update the reader", message: "Update the reader\n", mutations: [] };
      env.apply.mockResolvedValue({ commitSha: "l1", published: false, paths: ["x"], publishedBranch: null, pullRequestOffer: offer, branches: [{ branch: "main", role: "publishing", status: "protected", githubMessage: "Changes must be made through a pull request." }, { branch: "feature/x", role: "current", status: "published", commitSha: "l1" }] });
      env.openPr.mockResolvedValue({ url: "https://github.com/me/book/pull/7", number: 7, branch: "narrarium/update-reader-20261127" });
      await open(language);
      await screen.findByTestId("reader-branches");
      fireEvent.click(within(card()).getByRole("button", { name: text.update }));
      const outcome = await screen.findByTestId("reader-update-outcome");
      expect(within(outcome).getByText(branchText.protectedLine)).toBeInTheDocument();
      fireEvent.click(within(outcome).getByRole("button", { name: branchText.openPr }));
      const link = await within(outcome).findByRole("link", { name: new RegExp(branchText.prLink.replace(/[#]/g, "\\#")) });
      expect(link).toHaveAttribute("href", "https://github.com/me/book/pull/7");
      expect(link).toHaveAttribute("target", "_blank");
      expect(env.openPr).toHaveBeenCalledTimes(1);
      expect(env.openPr.mock.calls[0][0]).toMatchObject({ offer });
      expect(within(outcome).queryByRole("button", { name: branchText.openPr })).toBeNull();
    });
  });

  it("says when the publishing workflow is paused, because Pages was turned off", async () => {
    github.workflowState.value = "disabled_manually";
    await open(language);
    await screen.findByTestId("reader-update-exposure");
    expect(await within(card()).findByText(text.paused)).toBeInTheDocument();
  });

  describe("when the reader is current", () => {
    beforeEach(() => { env.inspect.mockImplementation(async () => found({ workflowText: current, folder: folder({ writes: [] }), remote: remoteOk })); });

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

  describe("a failed publication", () => {
    const failedRun = (sha = "abc") => ({ id: 31, status: "completed", conclusion: "failure", html_url: "https://github.com/me/book/actions/runs/31", created_at: "2026-11-26T21:53:00Z", head_branch: "main", head_sha: sha });

    it("names the Actions budget from the annotation of the job that never started, in the update card and in Reader access, with the way to GitHub billing", async () => {
      github.runs.unshift(failedRun());
      github.jobs.push({ id: 41, name: "build", conclusion: "failure", steps: [] });
      github.annotations[41] = [{ message: "The job was not started because an Actions budget is preventing further use." }];
      await open(language);
      const full = await screen.findByTestId("reader-run-failure");
      expect(full).toHaveAttribute("data-cause", "budget");
      expect(within(full).getByText(text.budgetTitle)).toBeInTheDocument();
      expect(within(full).getByText(text.budgetBody)).toBeInTheDocument();
      expect(within(full).getByText(text.publicWarning)).toBeInTheDocument();
      const link = within(full).getByRole("link", { name: new RegExp(text.billingLink) });
      expect(link).toHaveAttribute("href", "https://github.com/settings/billing");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
      expect(card()).toContainElement(full);
      const compact = screen.getByTestId("reader-run-failure-compact");
      expect(within(compact).getByText(text.budgetTitle)).toBeInTheDocument();
      expect(within(compact).getByRole("link", { name: new RegExp(text.billingLink) })).toHaveAttribute("href", "https://github.com/settings/billing");
      expect(card()).not.toContainElement(compact);
    });

    it("points an organization's repository at the billing of the organization", async () => {
      Object.assign(github.owner, { login: "acme", type: "Organization" });
      github.runs.unshift(failedRun());
      github.jobs.push({ id: 41, name: "build", conclusion: "failure", steps: [] });
      github.annotations[41] = [{ message: "The job was not started because recent account payments have failed or your spending limit needs to be increased." }];
      await open(language);
      const full = await screen.findByTestId("reader-run-failure");
      expect(within(full).getByRole("link", { name: new RegExp(text.billingLink) })).toHaveAttribute("href", "https://github.com/organizations/acme/settings/billing");
    });

    it("says when Actions is disabled, with the link to its settings, and when the reason could not be read", async () => {
      github.runs.unshift(failedRun());
      github.jobs.push({ id: 41, name: "build", conclusion: "failure", steps: [] });
      github.annotations[41] = [{ message: "GitHub Actions is disabled for this repository." }];
      await open(language);
      const full = await screen.findByTestId("reader-run-failure");
      expect(within(full).getByText(text.disabledTitle)).toBeInTheDocument();
      expect(within(full).getByRole("link")).toHaveAttribute("href", "https://github.com/me/book/settings/actions");
      cleanup();
      counter += 1;
      book = { ...book, id: `reader-update-unread-${counter}` };
      github.annotations = {};
      github.fail("listAnnotations", { status: 403 });
      await open(language);
      expect(await within(await screen.findByTestId("reader-run-failure")).findByText(text.unreadableTitle)).toBeInTheDocument();
    });

    it("shows nothing when the latest run succeeded", async () => {
      github.runs.unshift({ ...failedRun(), conclusion: "success" });
      await open(language);
      await screen.findByTestId("reader-update-exposure");
      expect(screen.queryByTestId("reader-run-failure")).toBeNull();
    });
  });

  describe("a reader updated on this device and not on GitHub", () => {
    const unpublished = ["reader/src/lib/book.ts", "reader/package.json", ".github/workflows/deploy-reader-pages.yml"];
    const onDevice = (overrides: Partial<ReaderUpdateInputs> = {}) => found({ workflowText: current, folder: folder({ writes: [] }), unpublished, remote: { pagesOn: true, passwordsSet: true, workflowText: v1 }, ...overrides });
    beforeEach(() => { env.inspect.mockImplementation(async () => onDevice()); });

    it("never says «up to date» while GitHub has the old workflow: it says so, with the files that are not on GitHub and the exposure", async () => {
      await open(language);
      const box = await screen.findByTestId("reader-on-device");
      expect(within(box).getByText(text.onDeviceTitle)).toBeInTheDocument();
      expect(within(box).getByText(text.remoteOld)).toBeInTheDocument();
      expect(within(card()).getByText(text.filesSummary)).toBeInTheDocument();
      expect(within(card()).queryByText(text.current)).toBeNull();
      expect(within(card()).getByTestId("reader-update-exposure")).toBeInTheDocument();
      expect(within(card()).getByRole("button", { name: text.syncNow })).toBeEnabled();
      expect(within(card()).queryByRole("button", { name: text.update })).toBeNull();
    });

    it("keeps the newest check: a slow one made before GitHub was read never replaces what the one made after it found", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      env.inspect.mockImplementationOnce(async () => { await gate; return found({ workflowText: current, folder: folder({ writes: [] }) }); });
      await open(language);
      // The second check (made once GitHub has been read) answers first; the first one answers last and is dropped.
      expect(await screen.findByTestId("reader-on-device")).toBeInTheDocument();
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.getByTestId("reader-on-device")).toBeInTheDocument();
      expect(within(card()).queryByText(text.currentUnchecked)).toBeNull();
    });

    it("says only what this device has when GitHub could not be read, and never claims the published side", async () => {
      env.inspect.mockImplementation(async () => found({ workflowText: current, folder: folder({ writes: [] }) }));
      await open(language);
      expect(await within(card()).findByText(text.currentUnchecked)).toBeInTheDocument();
    });

    it("says the changes are in local commits when GitHub could not be read but this device still has them to send", async () => {
      env.inspect.mockImplementation(async () => found({ workflowText: current, folder: folder({ writes: [] }), unpublished }));
      await open(language);
      expect(await within(card()).findByText(text.localCommits)).toBeInTheDocument();
    });

    it("says what the last automatic sync did with it: a refused workflow, or GitHub having moved", async () => {
      useBranchSyncStore.getState().replaceBook(book.id, { ...emptyBookSyncState(), branches: { main: { outcome: "failed", at: 1, errorKind: "workflow-permission" } } });
      await open(language);
      expect(await screen.findByTestId("reader-last-auto-sync")).toHaveTextContent(text.autoFailed);
      cleanup();
      useBranchSyncStore.getState().replaceBook(book.id, { ...emptyBookSyncState(), branches: { main: { outcome: "diverged", at: 1 } } });
      await open(language);
      expect(await screen.findByTestId("reader-last-auto-sync")).toHaveTextContent(text.autoDiverged);
    });

    it("sends the changes on «Sync now», and follows the publication of what GitHub now has", async () => {
      env.sync.mockResolvedValue({ pulled: 0, keptLocal: 0, committed: 0, pushed: 3 });
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.syncNow }));
      await waitFor(() => expect(env.sync).toHaveBeenCalledTimes(1));
      expect(env.sync.mock.calls[0][0]).toMatchObject({ owner: "me", repo: "book", branch: "main", bookId: book.id });
    });

    it("keeps the reason when the sync is refused, as an alert, and says the book was not sent", async () => {
      env.sync.mockRejectedValue(Object.assign(new Error("refusing to allow a GitHub App to create or update workflow `.github/workflows/deploy-reader-pages.yml` without `workflows` permission"), { status: 404 }));
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.syncNow }));
      const alert = await screen.findByTestId("reader-sync-failure");
      expect(alert).toHaveAttribute("role", "alert");
      expect(alert).toHaveTextContent(text.notSent);
      expect(alert).toHaveTextContent(text.permission);
    });

    it("sends the person to the sync dialog when two copies of a file have to be chosen between", async () => {
      const { RepositorySyncConflictError } = await import("@/repository/repositoryService");
      env.sync.mockRejectedValue(new RepositorySyncConflictError([]));
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.syncNow }));
      expect(await screen.findByTestId("reader-sync-failure")).toHaveTextContent(text.conflict);
    });

    it("cannot be sent without a credential or offline: the button is disabled and says why", async () => {
      env.inspect.mockImplementation(async () => onDevice({ credential: false }));
      await open(language);
      const button = await screen.findByRole("button", { name: text.syncNow });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription();
      expect(within(card()).getByText(text.noCredentialSync)).toBeInTheDocument();
      cleanup();
      counter += 1;
      book = { ...book, id: `reader-update-off-${counter}` };
      env.inspect.mockImplementation(async () => onDevice({ online: false }));
      await open(language);
      expect(await screen.findByRole("button", { name: text.syncNow })).toBeDisabled();
      expect(within(card()).getByText(text.offlineSync)).toBeInTheDocument();
    });

    it("offers to turn Pages off at once when the published reader is the old one, asks first, and does it with the passwords kept", async () => {
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.pagesOffButton }));
      const dialog = await screen.findByRole("dialog");
      expect(github.pages.enabled).toBe(true);
      fireEvent.click(within(dialog).getByRole("button", { name: text.pagesOffConfirm }));
      await waitFor(() => expect(github.pages.enabled).toBe(false));
      expect(await screen.findByTestId("reader-pages-off-result")).toHaveTextContent(text.pagesOffDone);
      expect(github.variable.value).toBeNull();
      expect(github.order()).toEqual(["disableWorkflow", "deletePagesSite"]);
    });

    it("offers the outside check in this state too, so the exposure can be seen", async () => {
      await open(language);
      expect(await screen.findByTestId("reader-outside-check")).toBeInTheDocument();
    });

    it("does not offer to turn Pages off when it is already off or the book is public anyway", async () => {
      env.inspect.mockImplementation(async () => onDevice({ remote: { pagesOn: false, passwordsSet: true, workflowText: v1 } }));
      github.pages.enabled = false;
      await open(language);
      await screen.findByTestId("reader-on-device");
      expect(screen.queryByRole("button", { name: text.pagesOffButton })).toBeNull();
    });

    it("is also said in the GitHub tab", async () => {
      await i18n.changeLanguage(language);
      render(<ReaderUpdateNotice book={book} onOpen={() => undefined} />);
      const notice = await screen.findByTestId("reader-update-notice");
      expect(within(notice).getByText(text.onDeviceTitle)).toBeInTheDocument();
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

    it("asks GitHub for its workflow on the working branch once the tab is open, and not before", async () => {
      await i18n.changeLanguage(language);
      const { rerender } = render(<ReaderUpdateNotice book={book} opened={false} onOpen={() => undefined} />);
      await waitFor(() => expect(env.inspect).toHaveBeenCalled());
      expect(github.calls.some((call) => call.method === "getContent")).toBe(false);
      rerender(<ReaderUpdateNotice book={book} opened onOpen={() => undefined} />);
      await waitFor(() => expect(github.calls.find((call) => call.method === "getContent")?.args).toMatchObject({ ref: "main" }));
      await waitFor(() => expect(env.inspect.mock.calls.some(([input]) => typeof input.remote?.workflowText === "string")).toBe(true));
    });

    it("shows nothing when the reader is current or there is no reader", async () => {
      await i18n.changeLanguage(language);
      env.inspect.mockImplementation(async () => found({ workflowText: current, folder: folder({ writes: [] }), remote: remoteOk }));
      render(<ReaderUpdateNotice book={book} onOpen={() => undefined} />);
      await waitFor(() => expect(env.inspect).toHaveBeenCalled());
      expect(screen.queryByTestId("reader-update-notice")).toBeNull();
    });
  });
});

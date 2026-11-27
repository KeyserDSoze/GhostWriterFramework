import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";

const env = vi.hoisted(() => ({ octokit: null as unknown as Octokit, save: vi.fn(async () => true) }));
vi.mock("@/repository/githubRequest", () => ({ createTrackedGitHubClient: () => env.octokit }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: env.save }) }));
vi.mock("@/readerAccess/sealedBox", () => ({ sealSecret: (value: string, key: string) => `sealed:${key.length}:${value.length}` }));

import i18n from "@/i18n";
import { ReaderAccessCard } from "@/components/book/readerAccess/ReaderAccessCard";
import { REVEAL_MS } from "@/components/book/readerAccess/PasswordRow";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry, type ReaderPasswordRecord } from "@/types/settings";
import { LEGACY_READER_SECRET } from "@/readerAccess/contract";
import { usePublicationStore } from "@/readerRun/store";
import { useOutsideStore } from "@/readerRun/outsideStore";
import { createFakeReaderGitHub, type FakeReaderGitHub } from "./helpers/fakeReaderGitHub";

const PASSWORD = "Alpha-PASSWORD-canary-7731";
const book: BookEntry = { id: "b1", owner: "me", repo: "book", name: "Book", tokenIndex: null, addedAt: "2026-11-01T00:00:00.000Z" };
const name = (number: number) => `READER_PASSWORD_${String(number).padStart(3, "0")}`;
const record = (number: number, patch: Partial<ReaderPasswordRecord> = {}): ReaderPasswordRecord => ({ id: `r${number}`, label: `Reader ${number}`, value: `${PASSWORD}-${number}`, createdAt: "2026-11-20T10:00:00.000Z", secretName: name(number), status: "active", ...patch });

const TEXTS = {
  en: {
    title: "Reader access", pagesOn: /Pages is on\. The reader is at/, pagesOff: "Pages is off: the reader is not published.", turnOn: "Turn on Pages", turnOff: "Turn off Pages…", publishNow: "Publish again",
    protected: "The published reader asks for a password.", public: "The published reader is public: it does not ask for a password.", none: /No password yet: anyone with the address can read the book/,
    reveal: (label: string) => `Show password «${label}»`, hide: (label: string) => `Hide password «${label}»`, copy: (label: string) => `Copy password «${label}»`, remove: (label: string) => `Remove password «${label}»`,
    generate: "Generate a strong password", passwordField: "Password", labelField: "Label (who it is for)", add: "Add password", strong: "strong", removeConfirm: "Remove password", last: /This is the last password/,
    offTitle: "Turn off GitHub Pages?", offKeep: /Keep the workflow and the passwords/, offDelete: /Also delete the password secrets and the variable/, offForget: /Also forget the passwords kept in Narrarium/, offConfirm: "Turn off Pages", cancel: "Cancel",
    publishing: /The reader is being published/, permission: /does not have the permission «Secrets» \(read and write\)/, pending: "Not on GitHub yet", retry: "Try again", used: "In use", legacy: "Older single password", unknownValue: "Value not kept here",
    effectUnchanged: /nothing on GitHub lists this password yet/, runQueued: "Queued: waiting for GitHub to give it a machine.", missing: /has no reader workflow/, offlineWarning: /anyone can download it and try passwords on their own computer/, copied: "Password «Reader 1» copied.",
  },
  it: {
    title: "Accesso al lettore", pagesOn: /Pages è attivo\. Il lettore è a/, pagesOff: "Pages è disattivato: il lettore non è pubblicato.", turnOn: "Attiva Pages", turnOff: "Disattiva Pages…", publishNow: "Pubblica di nuovo",
    protected: "Il lettore pubblicato chiede una password.", public: "Il lettore pubblicato è pubblico: non chiede nessuna password.", none: /Ancora nessuna password: chiunque abbia l'indirizzo può leggere il libro/,
    reveal: (label: string) => `Mostra la password «${label}»`, hide: (label: string) => `Nascondi la password «${label}»`, copy: (label: string) => `Copia la password «${label}»`, remove: (label: string) => `Rimuovi la password «${label}»`,
    generate: "Genera una password robusta", passwordField: "Password", labelField: "Etichetta (per chi è)", add: "Aggiungi password", strong: "robusta", removeConfirm: "Rimuovi la password", last: /È l'ultima password/,
    offTitle: "Disattivare GitHub Pages?", offKeep: /Mantieni il workflow e le password/, offDelete: /Elimina anche i secret delle password e la variabile/, offForget: /Dimentica anche le password conservate in Narrarium/, offConfirm: "Disattiva Pages", cancel: "Annulla",
    publishing: /Il lettore si sta pubblicando/, permission: /non ha il permesso «Secrets» \(lettura e scrittura\)/, pending: "Non ancora su GitHub", retry: "Riprova", used: "In uso", legacy: "Vecchia password singola", unknownValue: "Valore non conservato qui",
    effectUnchanged: /su GitHub ancora nulla elenca questa password/, runQueued: "In coda: aspetta che GitHub le dia una macchina.", missing: /non ha il workflow del lettore/, offlineWarning: /chiunque può scaricarlo e provare password sul proprio computer/, copied: "Password «Reader 1» copiata.",
  },
} as const;

let github: FakeReaderGitHub;

function reset(records: ReaderPasswordRecord[] = []) {
  localStorage.clear();
  usePublicationStore.setState({ entries: {}, live: {} });
  useOutsideStore.setState({ entries: {} });
  github = createFakeReaderGitHub();
  github.pages.enabled = true;
  env.octokit = github.octokit;
  env.save.mockClear();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "github_pat_default", books: [book], ...(records.length ? { readerAccess: { "me/book": records } } : {}) } });
}

/** A publication that succeeded and was built by a workflow that reads the passwords: the published reader is the one that asks for them. */
function publishedWithPasswords() {
  github.runs.push({ id: 3, status: "completed", conclusion: "success", html_url: "https://github.com/me/book/actions/runs/3", created_at: "2026-11-20T09:00:00Z", head_branch: "main", head_sha: "built", event: "push" });
}

async function open(language: "en" | "it") {
  await i18n.changeLanguage(language);
  render(<ReaderAccessCard book={book} />);
  await screen.findByText(language === "en" ? TEXTS.en.title : TEXTS.it.title);
}

const rowOf = (label: string) => screen.getByText(label).closest("li") as HTMLElement;
const kept = () => (useSettingsStore.getState().settings.readerAccess?.["me/book"] ?? []) as ReaderPasswordRecord[];

beforeEach(() => reset());
afterEach(async () => { cleanup(); vi.useRealTimers(); useSettingsStore.setState({ settings: DEFAULT_SETTINGS }); await i18n.changeLanguage("en"); });

describe.each(["en", "it"] as const)("Reader access in %s", (language) => {
  const text = TEXTS[language];

  describe("reading", () => {
    it("says that Pages is on with its address as a link that opens in a new tab", async () => {
      await open(language);
      expect(await screen.findByText(text.pagesOn)).toBeInTheDocument();
      const link = screen.getByRole("link", { name: /github\.io\/book/ });
      expect(link).toHaveAttribute("href", "https://me.github.io/book/");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
      expect(screen.getByRole("button", { name: text.turnOff })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: text.publishNow })).toBeInTheDocument();
    });

    it("says that Pages is off, and offers to turn it on", async () => {
      reset();
      github.pages.enabled = false;
      await open(language);
      expect(await screen.findByText(text.pagesOff)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: text.turnOn })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: text.turnOff })).toBeNull();
    });

    it("says the reader is public when no password exists, and does not claim it when GitHub could not be read", async () => {
      await open(language);
      expect(await screen.findByText(text.public)).toBeInTheDocument();
      expect(screen.getByText(text.none)).toBeInTheDocument();
      cleanup();
      reset();
      github.fail("listRepoSecrets", { status: 403 });
      await open(language);
      await waitFor(() => expect(screen.getByTestId("reader-read-failures")).toBeInTheDocument());
      expect(screen.queryByText(text.public)).toBeNull();
      expect(within(screen.getByTestId("reader-read-failures")).getByText(text.permission)).toBeInTheDocument();
    });

    it("lists a stored password masked, and its value only on request, with the buttons named after it", async () => {
      reset([record(1)]);
      github.variable.value = name(1);
      github.secrets.set(name(1), "x");
      publishedWithPasswords();
      await open(language);
      const row = within(await waitFor(() => rowOf("Reader 1")));
      expect(await screen.findByText(text.protected)).toBeInTheDocument();
      expect(row.getByText(text.used)).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(PASSWORD);
      const reveal = row.getByRole("button", { name: text.reveal("Reader 1") });
      expect(reveal).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(reveal);
      expect(row.getByText(`${PASSWORD}-1`)).toBeInTheDocument();
      expect(row.getByRole("button", { name: text.hide("Reader 1") })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(row.getByRole("button", { name: text.hide("Reader 1") }));
      expect(document.body.textContent).not.toContain(PASSWORD);
    });

    it("copies a password and says so in a status line, never in the page's text", async () => {
      reset([record(1)]);
      github.variable.value = name(1);
      github.secrets.set(name(1), "x");
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      await open(language);
      const row = within(await waitFor(() => rowOf("Reader 1")));
      fireEvent.click(row.getByRole("button", { name: text.copy("Reader 1") }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${PASSWORD}-1`));
      expect(await row.findByText(text.copied)).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(PASSWORD);
    });

    it("shows the older single secret and a password made elsewhere as removable only: there is no value to show", async () => {
      github.secrets.set(LEGACY_READER_SECRET, "x");
      github.secrets.set(name(3), "x");
      github.variable.value = name(3);
      publishedWithPasswords();
      await open(language);
      const legacy = within(await waitFor(() => rowOf(text.legacy)));
      expect(legacy.queryByRole("button", { name: /Show|Mostra/ })).toBeNull();
      expect(legacy.getByRole("button", { name: text.remove(text.legacy) })).toBeInTheDocument();
      const other = within(screen.getByText(name(3)).closest("li") as HTMLElement);
      expect(other.getByText(text.unknownValue)).toBeInTheDocument();
      expect(other.queryByRole("button", { name: /Show|Mostra|Copy|Copia/ })).toBeNull();
      expect(screen.getByText(text.protected)).toBeInTheDocument();
    });

    it("says when the repository has no reader workflow", async () => {
      github.workflowPresent.value = false;
      await open(language);
      expect(await screen.findByTestId("reader-workflow-missing")).toHaveTextContent(text.missing);
      expect(within(screen.getByTestId("reader-workflow-missing")).queryByRole("button")).toBeNull();
    });

    it("shows the last publication with a link to the run", async () => {
      github.runs.unshift({ id: 9, status: "completed", conclusion: "success", html_url: "https://github.com/me/book/actions/runs/9", created_at: "2026-11-25T09:00:00Z", head_branch: "main" });
      await open(language);
      const run = await screen.findByTestId("reader-run");
      expect(within(run).getByRole("link")).toHaveAttribute("href", "https://github.com/me/book/actions/runs/9");
      expect(run.querySelector("time")).toHaveAttribute("datetime", "2026-11-25T09:00:00Z");
    });
  });

  describe("adding a password", () => {
    it("generates one, shows it, reads its strength, then keeps it, writes the secret and the variable, and starts publishing", async () => {
      await open(language);
      await screen.findByText(text.none);
      fireEvent.click(screen.getByRole("button", { name: text.generate }));
      const field = screen.getByLabelText(text.passwordField) as HTMLInputElement;
      expect(field).toHaveAttribute("type", "text");
      expect(field.value).toMatch(/^(?:[A-HJ-NP-Za-km-z2-9]{5}-){4}[A-HJ-NP-Za-km-z2-9]{5}$/);
      expect(screen.getByText(text.strong)).toBeInTheDocument();
      expect(screen.getByText(text.offlineWarning)).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText(text.labelField), { target: { value: "Beta readers" } });
      fireEvent.click(screen.getByRole("button", { name: text.add }));

      expect(await screen.findByText(text.publishing)).toBeInTheDocument();
      expect(github.order()).toEqual([`createOrUpdateRepoSecret:${name(1)}`, "updateRepoVariable", "createRepoVariable", "createWorkflowDispatch"]);
      expect(kept()).toEqual([expect.objectContaining({ label: "Beta readers", value: field.value === "" ? expect.anything() : expect.stringMatching(/-/), secretName: name(1), status: "active" })]);
      expect(env.save).toHaveBeenCalled();
      expect(JSON.stringify(github.calls)).not.toContain(kept()[0].value);
      // The publication of the new password is going: it is not called «in use» before the published reader is known to ask for it.
      await waitFor(() => expect(within(rowOf("Beta readers")).getByText(language === "en" ? "Being published" : "In pubblicazione")).toBeInTheDocument());
      expect(screen.getByText(text.runQueued)).toBeInTheDocument();
      expect((screen.getByLabelText(text.passwordField) as HTMLInputElement).value).toBe("");
    });

    it("keeps the password masked while typed, with a button that shows it, and refuses a short one with a reason", async () => {
      await open(language);
      const field = screen.getByLabelText(text.passwordField) as HTMLInputElement;
      expect(field).toHaveAttribute("type", "password");
      fireEvent.change(field, { target: { value: "short" } });
      expect(screen.getByRole("button", { name: text.add })).toBeDisabled();
      fireEvent.change(field, { target: { value: "a-long-enough-pass" } });
      expect(screen.getByRole("button", { name: text.add })).toBeEnabled();
    });

    it("when the secret cannot be written: names the missing permission, says nothing published changed, keeps the password as not on GitHub, and a retry finishes it", async () => {
      github.fail("createOrUpdateRepoSecret", { status: 403, headers: { "x-accepted-github-permissions": "secrets=write" } }, 1);
      await open(language);
      await screen.findByText(text.none);
      fireEvent.change(screen.getByLabelText(text.passwordField), { target: { value: PASSWORD } });
      fireEvent.change(screen.getByLabelText(text.labelField), { target: { value: "Friends" } });
      fireEvent.click(screen.getByRole("button", { name: text.add }));

      const notice = await screen.findByTestId("reader-result");
      expect(notice).toHaveAttribute("role", "alert");
      expect(within(notice).getByText(text.permission)).toBeInTheDocument();
      expect(within(notice).getByText(text.effectUnchanged)).toBeInTheDocument();
      expect(kept()).toHaveLength(1);
      expect(kept()[0].status).toBe("pending");
      const row = within(rowOf("Friends"));
      expect(row.getByText(text.pending)).toBeInTheDocument();
      fireEvent.click(row.getByRole("button", { name: new RegExp(text.retry) }));
      expect(await screen.findByText(text.publishing)).toBeInTheDocument();
      await waitFor(() => expect(kept()[0].status).toBe("active"));
      expect(github.variable.value).toBe(name(1));
    });
  });

  describe("removing a password", () => {
    beforeEach(() => {
      reset([record(1), record(2)]);
      github.variable.value = `${name(1)},${name(2)}`;
      github.secrets.set(name(1), "x");
      github.secrets.set(name(2), "x");
    });

    it("asks first, then takes it off the variable, deletes the secret, forgets it and starts publishing; cancelling changes nothing", async () => {
      await open(language);
      const row = within(await waitFor(() => rowOf("Reader 1")));
      fireEvent.click(row.getByRole("button", { name: text.remove("Reader 1") }));
      let dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByText(text.last)).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: text.cancel }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(github.order()).toEqual([]);

      fireEvent.click(row.getByRole("button", { name: text.remove("Reader 1") }));
      dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: text.removeConfirm }));
      expect(await screen.findByText(text.publishing)).toBeInTheDocument();
      expect(github.order()).toEqual(["updateRepoVariable", `deleteRepoSecret:${name(1)}`, "createWorkflowDispatch"]);
      expect(kept().map((entry) => entry.secretName)).toEqual([name(2)]);
      await waitFor(() => expect(screen.queryByText("Reader 1")).toBeNull());
    });

    it("warns when it is the last password, because the reader becomes public", async () => {
      reset([record(1)]);
      github.variable.value = name(1);
      github.secrets.set(name(1), "x");
      await open(language);
      const row = within(await waitFor(() => rowOf("Reader 1")));
      fireEvent.click(row.getByRole("button", { name: text.remove("Reader 1") }));
      expect(within(await screen.findByRole("dialog")).getByText(text.last)).toBeInTheDocument();
    });
  });

  describe("turning Pages off", () => {
    beforeEach(() => {
      reset([record(1)]);
      github.variable.value = name(1);
      github.secrets.set(name(1), "x");
    });

    it("keeps the workflow and the passwords by default, and deletes nothing", async () => {
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.turnOff }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(text.offTitle)).toBeInTheDocument();
      expect(within(dialog).getByRole("radio", { name: new RegExp(text.offKeep.source) })).toBeChecked();
      expect(within(dialog).queryByRole("checkbox")).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: text.offConfirm }));
      await waitFor(() => expect(github.pages.enabled).toBe(false));
      expect(github.order()).toEqual(["disableWorkflow", "deletePagesSite"]);
      expect(github.secrets.has(name(1))).toBe(true);
      expect(kept()).toHaveLength(1);
    });

    it("asks separately before deleting the secrets, and again before forgetting the stored passwords", async () => {
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.turnOff }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("radio", { name: new RegExp(text.offDelete.source) }));
      const forget = within(dialog).getByRole("checkbox", { name: new RegExp(text.offForget.source) });
      expect(forget).not.toBeChecked();
      fireEvent.click(within(dialog).getByRole("button", { name: text.offConfirm }));
      await waitFor(() => expect(github.pages.enabled).toBe(false));
      await waitFor(() => expect(github.secrets.has(name(1))).toBe(false));
      expect(github.variable.value).toBeNull();
      expect(kept()).toHaveLength(1);
    });

    it("forgets the stored passwords only when that box is ticked", async () => {
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.turnOff }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("radio", { name: new RegExp(text.offDelete.source) }));
      fireEvent.click(within(dialog).getByRole("checkbox", { name: new RegExp(text.offForget.source) }));
      fireEvent.click(within(dialog).getByRole("button", { name: text.offConfirm }));
      await waitFor(() => expect(kept()).toHaveLength(0));
    });

    it("turns Pages on again for the same book and publishes", async () => {
      github.pages.enabled = false;
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.turnOn }));
      await waitFor(() => expect(github.pages.enabled).toBe(true));
      expect(github.order()).toEqual(["createPagesSite", "createWorkflowDispatch"]);
    });
  });
});

describe.each(["en", "it"] as const)("passwords can always be prepared, in %s", (language) => {
  const text = language === "en"
    ? { outdated: /On “main”, the branch the reader is published from, the reader workflow does not read passwords yet\. You can add them anyway: they are saved and prepared on GitHub/, missing: /“main”, the branch the reader is published from, has no reader workflow/, preparedTitle: "Prepared, not protecting yet", preparedLine: "Passwords are prepared, but the published reader does not ask for a password yet: it is public.", used: "In use", result: /Done\. The password is prepared: it is saved and on GitHub, but the reader that is published now does not read passwords/, update: "Update the reader", publishAgain: "Publish again", exposed: /the EPUB answered 200\. It is still public/, activated: /Your prepared passwords are now active/, protectedLine: "The published reader asks for a password.", password: "Password", add: "Add password", publishing: "Being published" }
    : { outdated: /Su “main”, il ramo da cui il lettore è pubblicato, il workflow del lettore non legge ancora le password\. Puoi aggiungerle lo stesso: vengono salvate e preparate su GitHub/, missing: /“main”, il ramo da cui il lettore è pubblicato, non ha il workflow del lettore/, preparedTitle: "Preparate, non ancora protettive", preparedLine: "Le password sono preparate, ma il lettore pubblicato non chiede ancora una password: è pubblico.", used: "In uso", result: /Fatto\. La password è preparata: è salvata e su GitHub, ma il lettore pubblicato ora non legge le password/, update: "Aggiorna il lettore", publishAgain: "Pubblica di nuovo", exposed: /l'EPUB ha risposto 200\. È ancora pubblico/, activated: /Le tue password preparate ora sono attive/, protectedLine: "Il lettore pubblicato chiede una password.", password: "Password", add: "Aggiungi password", publishing: "In pubblicazione" };
  const prepared = language === "en" ? "Prepared, not protecting yet" : "Preparata, non ancora protettiva";
  const OLD_WORKFLOW = "name: Deploy reader\nenv:\n  P: ${{ secrets.NARRARIUM_READER_PASSWORD_OLD }}\n";

  async function addOne() {
    await screen.findByText(language === "en" ? /No password yet/ : /Ancora nessuna password/);
    fireEvent.change(screen.getByLabelText(text.password), { target: { value: `${PASSWORD}-new` } });
    fireEvent.click(screen.getByRole("button", { name: text.add }));
  }

  it("lets a password be added while the workflow does not read passwords: the secret and the variable are written, nothing is published for it, and it is only prepared", async () => {
    github.workflowText.value = OLD_WORKFLOW;
    await open(language);
    expect(await screen.findByTestId("reader-workflow-outdated")).toHaveTextContent(text.outdated);
    expect(screen.getByTestId("reader-add-note")).toHaveTextContent(text.outdated);
    expect(screen.getByLabelText(text.password)).toBeEnabled();
    await addOne();
    expect(await screen.findByText(text.result)).toBeInTheDocument();
    // Written on GitHub at once (an old workflow never reads them), and the old workflow is not started for it.
    expect(github.order()).toEqual([`createOrUpdateRepoSecret:${name(1)}`, "updateRepoVariable", "createRepoVariable"]);
    expect(github.calls.some((call) => call.method === "createWorkflowDispatch")).toBe(false);
    expect(screen.queryByTestId("reader-publication")).toBeNull();
    expect(kept()).toEqual([expect.objectContaining({ secretName: name(1), status: "active" })]);
    // …and it is never called «in use» or «protected» while the published reader is public.
    const row = within(await waitFor(() => screen.getAllByTestId("reader-password")[0]));
    expect(row.getByText(prepared)).toBeInTheDocument();
    expect(row.queryByText(text.used)).toBeNull();
    expect(screen.getByTestId("reader-protection")).toHaveTextContent(text.preparedLine);
    expect(screen.queryByText(text.protectedLine)).toBeNull();
    const notice = screen.getByTestId("reader-prepared");
    expect(within(notice).getByRole("heading", { name: text.preparedTitle })).toBeInTheDocument();
    expect(within(notice).getByRole("button", { name: text.update })).toBeInTheDocument();
    expect(screen.queryByTestId("reader-activated")).toBeNull();
  });

  it("prepares them as well when there is no workflow, and when the workflow could not be read, and says what is missing", async () => {
    github.workflowPresent.value = false;
    await open(language);
    expect(await screen.findByTestId("reader-add-note")).toHaveTextContent(text.missing);
    await addOne();
    expect(await screen.findByText(text.result)).toBeInTheDocument();
    expect(github.calls.some((call) => call.method === "createWorkflowDispatch")).toBe(false);
    cleanup();
    reset();
    github.fail("getContent", { status: 403 });
    await open(language);
    await waitFor(() => expect(screen.getByTestId("reader-read-failures")).toBeInTheDocument());
    expect(screen.getByLabelText(text.password)).toBeEnabled();
  });

  it("makes the prepared passwords active, without typing them again, once a publication built by a workflow that reads them has succeeded and the outside check passes", async () => {
    reset([record(1)]);
    github.variable.value = name(1);
    github.secrets.set(name(1), "x");
    // Before: the published reader is the old one.
    github.runs.unshift({ id: 5, status: "completed", conclusion: "success", html_url: "x", created_at: "2026-11-24T09:00:00Z", head_branch: "main", head_sha: "oldsha", event: "push" });
    github.workflowTextAt.oldsha = OLD_WORKFLOW;
    await open(language);
    const row = within(await waitFor(() => rowOf("Reader 1")));
    await waitFor(() => expect(row.getByText(prepared)).toBeInTheDocument());
    expect(screen.getByTestId("reader-protection")).toHaveTextContent(text.preparedLine);
    // The workflow is updated and published: a newer run, built by a workflow that reads the passwords, has succeeded.
    github.runs.unshift({ id: 6, status: "completed", conclusion: "success", html_url: "x", created_at: "2026-11-27T09:00:00Z", head_branch: "main", head_sha: "newsha", event: "push" });
    github.workflowTextAt.newsha = "name: Deploy reader\nenv:\n  PASSWORDS: ${{ vars.READER_PASSWORD_SECRETS }}\n";
    fireEvent.click(screen.getByRole("button", { name: language === "en" ? "Check again" : "Ricontrolla" }));
    await waitFor(() => expect(row.getByText(text.used)).toBeInTheDocument());
    expect(screen.getByTestId("reader-protection")).toHaveTextContent(text.protectedLine);
    expect(screen.queryByTestId("reader-prepared")).toBeNull();
    expect(kept()[0].value).toBe(`${PASSWORD}-1`);
  });

  it("does not call them active while the outside check says the book is still public, whatever the workflow says", async () => {
    reset([record(1)]);
    github.variable.value = name(1);
    github.secrets.set(name(1), "x");
    github.runs.unshift({ id: 6, status: "completed", conclusion: "success", html_url: "x", created_at: "2026-11-27T09:00:00Z", head_branch: "main", head_sha: "newsha", event: "push" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}) })));
    await open(language);
    const row = within(await waitFor(() => rowOf("Reader 1")));
    await waitFor(() => expect(row.getByText(text.used)).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId("reader-protection").parentElement!).queryByRole("button", { name: language === "en" ? "Check from outside" : "Controlla da fuori" }) ?? document.createElement("button"));
    const { useOutsideStore } = await import("@/readerRun/outsideStore");
    await act(async () => { await useOutsideStore.getState().check("https://me.github.io/book/"); });
    await waitFor(() => expect(row.getByText(prepared)).toBeInTheDocument());
    expect(screen.getByTestId("reader-prepared")).toHaveTextContent(text.exposed);
    expect(row.queryByText(text.used)).toBeNull();
  });

  it("offers «Publish again» instead of the update when the workflow already reads them but the published reader does not use them yet", async () => {
    reset([record(1)]);
    github.variable.value = name(1);
    github.secrets.set(name(1), "x");
    github.runs.unshift({ id: 5, status: "completed", conclusion: "success", html_url: "x", created_at: "2026-11-24T09:00:00Z", head_branch: "main", head_sha: "oldsha", event: "push" });
    github.workflowTextAt.oldsha = OLD_WORKFLOW;
    await open(language);
    const notice = await screen.findByTestId("reader-prepared");
    expect(within(notice).getByRole("button", { name: text.publishAgain })).toBeInTheDocument();
    expect(within(notice).queryByRole("button", { name: text.update })).toBeNull();
  });

  it("still lets a stored password be removed while the workflow does not read them", async () => {
    reset([record(1)]);
    github.variable.value = name(1);
    github.secrets.set(name(1), "x");
    github.workflowText.value = "name: old\n";
    await open(language);
    const row = within(await waitFor(() => rowOf("Reader 1")));
    expect(row.getByRole("button", { name: language === "en" ? "Remove password «Reader 1»" : "Rimuovi la password «Reader 1»" })).toBeEnabled();
  });
});

describe("the status of a publication", () => {
  it("says when the last run failed, with the link to see why", async () => {
    github.runs.unshift({ id: 4, status: "completed", conclusion: "failure", html_url: "https://github.com/me/book/actions/runs/4", created_at: "2026-11-25T09:00:00Z", head_branch: "main" });
    await open("en");
    const run = await screen.findByTestId("reader-run");
    expect(within(run).getByText("failed")).toBeInTheDocument();
    expect(within(run).getByRole("link")).toHaveAttribute("href", "https://github.com/me/book/actions/runs/4");
  });
});

describe("a revealed password", () => {
  it("hides itself again after a minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    reset([record(1)]);
    github.variable.value = name(1);
    github.secrets.set(name(1), "x");
    await open("en");
    const row = within(await waitFor(() => rowOf("Reader 1")));
    fireEvent.click(row.getByRole("button", { name: "Show password «Reader 1»" }));
    expect(row.getByText(`${PASSWORD}-1`)).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(REVEAL_MS + 100);
    await waitFor(() => expect(document.body.textContent).not.toContain(PASSWORD));
  });
});

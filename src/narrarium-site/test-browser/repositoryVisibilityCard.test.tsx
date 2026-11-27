import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";

const env = vi.hoisted(() => ({
  octokit: null as unknown as Octokit,
  kept: vi.fn(),
  installs: { status: "idle" } as unknown,
}));
vi.mock("@/repository/githubRequest", () => ({ createTrackedGitHubClient: () => env.octokit }));
vi.mock("@/repoVisibility/contents", () => ({ readKeptItems: env.kept }));
vi.mock("@/github/useAppInstallations", () => ({ useAppInstallations: () => ({ ...(env.installs as object), reload: () => undefined }) }));

import i18n from "@/i18n";
import { RepositoryVisibilityCard } from "@/components/book/settings/RepositoryVisibilityCard";
import { REPOSITORY_VISIBILITY_EVENT } from "@/repoVisibility/model";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry, type ReaderPasswordRecord } from "@/types/settings";
import { createFakeReaderGitHub, type FakeReaderGitHub } from "./helpers/fakeReaderGitHub";

const book: BookEntry = { id: "vis-1", owner: "me", repo: "book", name: "Book", tokenIndex: null, addedAt: "2026-11-01T00:00:00.000Z" };
let github: FakeReaderGitHub;

const TEXTS = {
  en: {
    title: "Repository visibility", isPrivate: /^Private: only you and the people you invited/, isPublic: /^Public: anyone on the internet/, makePublic: "Make public…", makePrivate: "Make private…",
    publicTitle: "Make book public?", type: /To confirm, type the name of the repository: book/, confirmPublic: "Make public", privateTitle: "Make book private?", confirmPrivate: "Make private",
    nowPublic: "The repository is now public.", nowPrivate: "The repository is now private.", pagesOff: /GitHub Pages is off now/, pagesOn: /GitHub Pages is still on, at https:\/\/me\.github\.io\/book\//,
    keptFolder: "secrets/ — 2 files", keptFile: "director.md", readerNote: /This book has passwords for its online reader/, undo: /cannot be undone for what is copied meanwhile/,
    appMissing: /installed without the «Administration» permission/, noAdmin: /you are not an administrator of this repository/, failureTitle: "The visibility was not changed.",
    permission: /GitHub refused \(error 404\): this credential cannot change the visibility/, permissionApp: /The GitHub app needs the «Administration» permission \(Read and write\)/, permissionToken: /A classic token needs the «repo» scope/,
    policy: /GitHub did not allow it: “Visibility change is not allowed because of an organization policy\.”/, offline: /You are offline\. Changing the visibility is an action on GitHub: it is never queued/, openApp: /Open the app on GitHub/, keptUnknown: /This device has no copy of the book/,
  },
  it: {
    title: "Visibilità del repository", isPrivate: /^Privato: solo tu e le persone che hai invitato/, isPublic: /^Pubblico: chiunque su internet/, makePublic: "Rendi pubblico…", makePrivate: "Rendi privato…",
    publicTitle: "Rendere pubblico book?", type: /Per confermare, scrivi il nome del repository: book/, confirmPublic: "Rendi pubblico", privateTitle: "Rendere privato book?", confirmPrivate: "Rendi privato",
    nowPublic: "Il repository ora è pubblico.", nowPrivate: "Il repository ora è privato.", pagesOff: /GitHub Pages ora è spento/, pagesOn: /GitHub Pages è ancora attivo, a https:\/\/me\.github\.io\/book\//,
    keptFolder: "secrets/ — 2 file", keptFile: "director.md", readerNote: /Questo libro ha password per il suo lettore online/, undo: /Non si può annullare per ciò che nel frattempo viene copiato/,
    appMissing: /installata senza il permesso «Administration»/, noAdmin: /non sei amministratore di questo repository/, failureTitle: "La visibilità non è stata cambiata.",
    permission: /GitHub ha rifiutato \(errore 404\): questa credenziale non può cambiare la visibilità/, permissionApp: /La GitHub App ha bisogno del permesso «Administration»/, permissionToken: /Un token classico ha bisogno dello scope «repo»/,
    policy: /GitHub non lo ha consentito: «Visibility change is not allowed because of an organization policy\.»/, offline: /Sei offline\. Cambiare la visibilità è un'azione su GitHub: non viene mai messa in coda/, openApp: /Apri l'app su GitHub/, keptUnknown: /Questo dispositivo non ha una copia del libro/,
  },
} as const;

function reset(token = "ghp_classic", records: ReaderPasswordRecord[] = []) {
  github = createFakeReaderGitHub();
  github.pages.enabled = true;
  env.octokit = github.octokit;
  env.kept.mockReset().mockResolvedValue([{ path: "secrets/", kind: "folder", count: 2 }, { path: "director.md", kind: "file", count: 1 }]);
  env.installs = { status: "idle" };
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: token, books: [book], ...(records.length ? { readerAccess: { "me/book": records } } : {}) } });
}
beforeEach(() => reset());
afterEach(async () => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useSettingsStore.setState({ settings: DEFAULT_SETTINGS }); await i18n.changeLanguage("en"); });

async function open(language: "en" | "it") {
  await i18n.changeLanguage(language);
  render(<RepositoryVisibilityCard book={book} branch="main" />);
  await screen.findByText(TEXTS[language].title);
}
const state = () => screen.findByTestId("repository-visibility-state");

describe.each(["en", "it"] as const)("Repository visibility in %s", (language) => {
  const text = TEXTS[language];

  it("reads the visibility from the repository and shows it in words", async () => {
    await open(language);
    expect(await state()).toHaveTextContent(text.isPrivate);
    expect(github.calls.map((call) => call.method)).toContain("get");
    cleanup();
    reset();
    github.repository.private = false;
    await open(language);
    expect(await state()).toHaveTextContent(text.isPublic);
    expect(screen.getByRole("button", { name: text.makePrivate })).toBeInTheDocument();
  });

  describe("making a repository public", () => {
    it("asks first, lists what the repository holds and that it cannot be undone, and does nothing until the name is typed exactly", async () => {
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.makePublic }));
      const dialog = await screen.findByRole("dialog", { name: text.publicTitle });
      expect(within(dialog).getByText(text.undo)).toBeInTheDocument();
      const kept = await within(dialog).findByTestId("repository-visibility-kept");
      expect(await within(kept).findByText(text.keptFolder)).toBeInTheDocument();
      expect(within(kept).getByText(text.keptFile)).toBeInTheDocument();
      const confirm = within(dialog).getByRole("button", { name: text.confirmPublic });
      expect(confirm).toBeDisabled();
      const input = within(dialog).getByLabelText(text.type);
      fireEvent.change(input, { target: { value: "boo" } });
      expect(confirm).toBeDisabled();
      fireEvent.change(input, { target: { value: "Book" } });
      expect(confirm).toBeDisabled();
      expect(github.repository.private).toBe(true);
      expect(github.calls.some((call) => call.method === "update")).toBe(false);
      fireEvent.change(input, { target: { value: "book" } });
      expect(confirm).toBeEnabled();
      fireEvent.click(confirm);
      expect(await screen.findByTestId("repository-visibility-result")).toHaveTextContent(text.nowPublic);
      expect(github.repository.private).toBe(false);
      expect(github.calls.find((call) => call.method === "update")?.args).toMatchObject({ owner: "me", repo: "book", private: false });
      expect(await state()).toHaveTextContent(text.isPublic);
    });

    it("says, when the book has passwords for its online reader, that they do not protect the repository, with the way to look at it first", async () => {
      reset("ghp_classic", [{ id: "r1", label: "R", value: "value-123456", createdAt: "", secretName: "READER_PASSWORD_001", status: "active" }]);
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.makePublic }));
      const note = await screen.findByTestId("repository-visibility-reader-note");
      expect(note).toHaveTextContent(text.readerNote);
      expect(within(note).getByRole("link")).toHaveAttribute("href", "https://github.com/me/book");
    });

    it("says it could not look at what this device holds when there is no working copy, and still asks for the name", async () => {
      env.kept.mockResolvedValue(null);
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.makePublic }));
      expect(await screen.findByText(text.keptUnknown)).toBeInTheDocument();
    });

    it("changes nothing when the dialog is cancelled", async () => {
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.makePublic }));
      fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(github.calls.some((call) => call.method === "update")).toBe(false);
    });
  });

  describe("making a repository private", () => {
    beforeEach(() => { github.repository.private = false; });

    it("says what happens to Pages and Actions, then reads the repository and Pages again: Pages stopped", async () => {
      github.repository.unpublishOnPrivate = true;
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.makePrivate }));
      const dialog = await screen.findByRole("dialog", { name: text.privateTitle });
      expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
      const before = github.calls.length;
      fireEvent.click(within(dialog).getByRole("button", { name: text.confirmPrivate }));
      const result = await screen.findByTestId("repository-visibility-result");
      expect(result).toHaveTextContent(text.nowPrivate);
      expect(result).toHaveTextContent(text.pagesOff);
      expect(github.calls.find((call) => call.method === "update")?.args).toMatchObject({ private: true });
      // The repository and Pages were read again after the change.
      const after = github.calls.slice(before).map((call) => call.method);
      expect(after).toEqual(["update", "get", "getPages"]);
      expect(await state()).toHaveTextContent(text.isPrivate);
    });

    it("says Pages is still on when GitHub still serves it", async () => {
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.makePrivate }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: text.confirmPrivate }));
      expect(await screen.findByTestId("repository-visibility-result")).toHaveTextContent(text.pagesOn);
    });

    it("tells the rest of the page to read the published side again", async () => {
      const heard = vi.fn();
      window.addEventListener(REPOSITORY_VISIBILITY_EVENT, heard);
      await open(language);
      fireEvent.click(await screen.findByRole("button", { name: text.makePrivate }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: text.confirmPrivate }));
      await screen.findByTestId("repository-visibility-result");
      expect(heard).toHaveBeenCalledTimes(1);
      window.removeEventListener(REPOSITORY_VISIBILITY_EVENT, heard);
    });
  });

  describe("when GitHub refuses", () => {
    async function publish() {
      fireEvent.click(await screen.findByRole("button", { name: text.makePublic }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText(text.type), { target: { value: "book" } });
      fireEvent.click(within(dialog).getByRole("button", { name: text.confirmPublic }));
    }

    it("explains the missing Administration permission of the app, as an alert, and leaves the repository as it was", async () => {
      reset("ghu_app");
      env.installs = { status: "ready", installations: [] };
      github.fail("update", { status: 404, message: "Not Found" });
      await open(language);
      await state();
      await publish();
      const alert = await screen.findByTestId("repository-visibility-failure");
      expect(alert).toHaveAttribute("role", "alert");
      expect(alert).toHaveTextContent(text.failureTitle);
      expect(alert).toHaveTextContent(text.permission);
      expect(alert).toHaveTextContent(text.permissionApp);
      expect(github.repository.private).toBe(true);
      expect(screen.queryByTestId("repository-visibility-result")).toBeNull();
    });

    it("explains the scope and the administrator right for a token", async () => {
      github.fail("update", { status: 403, message: "Resource not accessible by personal access token" });
      await open(language);
      await state();
      await publish();
      const alert = await screen.findByTestId("repository-visibility-failure");
      expect(alert).toHaveTextContent(/error 403|errore 403/);
      expect(alert).toHaveTextContent(text.permissionToken);
    });

    it("shows GitHub's own words for a policy of the organization", async () => {
      github.fail("update", { status: 422, message: "Visibility change is not allowed because of an organization policy." });
      await open(language);
      await state();
      await publish();
      expect(await screen.findByTestId("repository-visibility-failure")).toHaveTextContent(text.policy);
    });
  });

  describe("what the credential can do, said before it is tried", () => {
    it("says the GitHub app has no Administration permission, with the way to give it, and does not offer the action", async () => {
      reset("ghu_app");
      env.installs = { status: "ready", installations: [{ id: 5, account: "me", accountType: "User", selection: "all", repositories: [], suspended: false, permissions: { contents: "write" }, settingsUrl: "https://github.com/settings/installations/5" }] };
      await open(language);
      await state();
      const note = await screen.findByTestId("repository-visibility-availability");
      expect(note).toHaveAttribute("data-state", "app-permission-missing");
      expect(note).toHaveTextContent(text.appMissing);
      expect(within(note).getByRole("link", { name: text.openApp })).toHaveAttribute("href", "https://github.com/settings/installations/5");
      expect(screen.getByRole("button", { name: text.makePublic })).toBeDisabled();
    });

    it("offers the action when the app was given Administration write", async () => {
      reset("ghu_app");
      env.installs = { status: "ready", installations: [{ id: 5, account: "me", accountType: "User", selection: "all", repositories: [], suspended: false, permissions: { administration: "write" }, settingsUrl: "https://github.com/settings/installations/5" }] };
      await open(language);
      await state();
      expect(screen.getByRole("button", { name: text.makePublic })).toBeEnabled();
      expect(screen.queryByTestId("repository-visibility-availability")).toBeNull();
    });

    it("says when GitHub says the person is no administrator", async () => {
      github.repository.admin = false;
      await open(language);
      await state();
      expect(await screen.findByTestId("repository-visibility-availability")).toHaveTextContent(text.noAdmin);
      expect(screen.getByRole("button", { name: text.makePublic })).toBeDisabled();
    });

    it("never queues the action offline: it is explained and the button is off", async () => {
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
      await open(language);
      expect(await screen.findByText(text.offline)).toBeInTheDocument();
      expect(github.calls).toEqual([]);
      expect(screen.queryByRole("button", { name: text.makePublic })).toBeNull();
    });
  });
});

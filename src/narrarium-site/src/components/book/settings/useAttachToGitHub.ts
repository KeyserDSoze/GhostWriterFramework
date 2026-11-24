import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useConnectionStore } from "@/account/connectionStore";
import { bookStorageMode, resolveGitHubCredential, resolveGitHubRemoteToken, type BookEntry } from "@/types/settings";
import { attachLocalBookToGitHub } from "@/repository/repositoryService";
import { BookRepositoryError, deleteEmptyBookRepository, isBookRepositoryError, type BookRepositoryProgress, type CreateCompleteBookRepositoryResult } from "@/github/bookRepository";
import { defaultGitHubRepositoryChoices, ownerOf, useGitHubPreflight, type GitHubRepositoryChoices } from "@/components/book/GitHubRepositoryPanel";
import { credentialCacheKey, type RepositoryDecision } from "@/github/repositoryPickerModel";
import { useProtectedReaderSetup } from "@/components/book/useProtectedReaderSetup";

/** Connecting a book that lives on this device to GitHub: what the repository picker decided, the progress, the failure or the result, and the two actions (connect, delete the empty repository that a failed attempt left). */
export function useAttachToGitHub(book: BookEntry) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { settings, patchSettings } = useSettingsStore();
  const { save } = useSettings();
  const { clearBook } = useBooksStore();
  const connection = useConnectionStore((state) => state.configuration.github);
  const [choices, setChoices] = useState<GitHubRepositoryChoices>(defaultGitHubRepositoryChoices);
  const [progress, setProgress] = useState<BookRepositoryProgress | null>(null);
  const [failure, setFailure] = useState<BookRepositoryError | null>(null);
  const [result, setResult] = useState<CreateCompleteBookRepositoryResult | null>(null);
  const [decision, setDecision] = useState<RepositoryDecision | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = resolveGitHubRemoteToken(book, settings);
  const preflight = useGitHubPreflight(bookStorageMode(book) === "local-only" ? token || undefined : undefined);
  const credential = resolveGitHubCredential(book, settings);
  const app = credential?.source === "app";
  const cacheKey = credentialCacheKey({ app, login: app ? connection?.identity?.username : undefined, token });
  const login = app ? connection?.identity?.username : undefined;
  const readerSetup = useProtectedReaderSetup(token);

  async function attach() {
    if (!token) { setError(t("bookSettings.connectGithub.noToken")); return; }
    if (!decision?.ready) return;
    setAttaching(true);
    setError(null);
    setFailure(null);
    setProgress({ step: "repository" });
    try {
      // A repository that is a Narrarium book already is added as a book of its own: the book of this device stays as it is, and nothing is written to it.
      if (decision.outcome?.kind === "connect-book" && decision.repository) {
        const repository = decision.repository;
        const entry: BookEntry = { id: crypto.randomUUID(), owner: repository.owner, repo: repository.name, name: repository.name, tokenIndex: book.tokenIndex ?? null, bookToken: book.bookToken, bookTokenLabel: book.bookTokenLabel, useGitHubConnection: book.useGitHubConnection, addedAt: new Date().toISOString() };
        patchSettings({ books: [...settings.books, entry] });
        await save();
        navigate(`/app/books/${entry.id}`);
        return;
      }
      const existing = decision.mode === "existing";
      const attached = await attachLocalBookToGitHub({ book, token, owner: decision.owner ?? ownerOf(choices) ?? "", repo: decision.name, createRepository: !existing, overwriteExisting: decision.outcome?.kind === "publish-overwrite", visibility: choices.visibility, pages: !existing && choices.pages ? "enable" : "skip", beforeWorkflow: !existing && choices.pages ? readerSetup.step(choices) : undefined, onProgress: setProgress });
      readerSetup.settle(attached.creation);
      const updated: BookEntry = { ...book, storageMode: "github", owner: attached.owner, repo: attached.repo, activeBranch: attached.branch };
      // The result stays on the screen (the card goes away once the book is on GitHub): the book is opened from its button.
      setResult(attached.creation);
      patchSettings({ books: settings.books.map((entry) => entry.id === book.id ? updated : entry) });
      await save();
      clearBook(book.id);
    } catch (cause) {
      if (isBookRepositoryError(cause)) setFailure(cause);
      else if (cause instanceof TypeError) setFailure(new BookRepositoryError("network", { cause }));
      else setError(String(cause));
    } finally { setAttaching(false); setProgress(null); }
  }

  async function deleteEmptyRepository() {
    const empty = failure?.repository;
    if (!empty || !token) return;
    await deleteEmptyBookRepository({ token, owner: empty.owner, repo: empty.repo, defaultBranch: empty.defaultBranch });
  }

  return { readerSetup, setResult, choices, setChoices, progress, failure, result, decision, setDecision, attaching, error, token, preflight, app, login, cacheKey, attach, deleteEmptyRepository, owner: decision?.owner ?? ownerOf(choices) ?? "", books: settings.books };
}

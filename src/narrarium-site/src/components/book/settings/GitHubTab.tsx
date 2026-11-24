import { Suspense, lazy } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GitHubCreateResult } from "@/components/book/GitHubRepositoryOutcome";
import { AttachToGitHubCard } from "@/components/book/settings/AttachToGitHubCard";
import { TokenSelectionCard } from "@/components/book/settings/TokenSelectionCard";
import { TokenStatusCard } from "@/components/book/settings/TokenStatusCard";
import { WorkingBranchCard } from "@/components/book/settings/WorkingBranchCard";
import { useAttachToGitHub } from "@/components/book/settings/useAttachToGitHub";
import { useNavigate } from "react-router-dom";
import { useSettingsStore } from "@/store/settingsStore";
import { bookStorageMode, resolveBookToken, type BookEntry } from "@/types/settings";
import type { BookSettingsDraft } from "@/bookSettings/draft";
import { AUTO_BRANCH } from "@/bookSettings/draft";
import { useBooksStore } from "@/store/booksStore";

// Which token the book uses, and whether the GitHub app reaches it, is a chunk of its own.
const BookGitHubAccess = lazy(() => import("@/components/book/BookGitHubAccess").then((module) => ({ default: module.BookGitHubAccess })));

interface Props {
  book: BookEntry;
  draft: BookSettingsDraft;
  patch: (change: Partial<BookSettingsDraft>) => void;
}

/**
 * Everything about the book and GitHub. A book on this device is offered the connection (choose a repository from the list, or name a new one), and its working
 * branch is shown as local. A book on GitHub shows its repository, which credential it uses and its state, the token's status and the working branch.
 */
export function GitHubTab({ book, draft, patch }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const settings = useSettingsStore((state) => state.settings);
  const attach = useAttachToGitHub(book);
  const { workingBranches, structures } = useBooksStore();
  const github = bookStorageMode(book) === "github";
  const autoBranch = workingBranches[book.id] ?? structures[book.id]?.defaultBranch ?? "main";
  const branch = draft.activeBranch === AUTO_BRANCH ? autoBranch : draft.activeBranch;
  const token = resolveBookToken(book, settings);

  // The result of connecting stays on the screen after the book has become a GitHub book (the card that made it goes away): the book is opened from its button.
  const result = attach.result ? <GitHubCreateResult result={attach.result} onOpenBook={() => navigate(`/app/books/${book.id}`)} /> : null;

  if (!github) {
    return (
      <>
        {result ?? <AttachToGitHubCard book={book} attach={attach} />}
        <WorkingBranchCard book={book} activeBranch={draft.activeBranch} onActiveBranch={(activeBranch) => patch({ activeBranch })} />
      </>
    );
  }

  return (
    <>
      {result}
      <Card>
        <CardHeader>
          <CardTitle>{t("bookSettings.tabs.repositoryTitle")}</CardTitle>
          <CardDescription>{t("bookSettings.tabs.repositoryDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <a className="inline-flex min-h-6 items-center gap-1 font-medium underline underline-offset-2" href={`https://github.com/${encodeURIComponent(book.owner)}/${encodeURIComponent(book.repo)}`} target="_blank" rel="noopener noreferrer">
            {book.owner}/{book.repo}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /><span className="sr-only"> {t("bookSettings.tabs.opensNewTab")}</span>
          </a>
        </CardContent>
      </Card>

      <TokenSelectionCard
        mode={draft.tokenMode}
        onMode={(tokenMode) => patch({ tokenMode })}
        customToken={draft.customToken}
        onCustomToken={(customToken) => patch({ customToken })}
        customTokenLabel={draft.customTokenLabel}
        onCustomTokenLabel={(customTokenLabel) => patch({ customTokenLabel })}
        hasToken={Boolean(token)}
      />
      <Suspense fallback={null}><BookGitHubAccess book={book} /></Suspense>
      <TokenStatusCard book={book} branch={branch} />
      <WorkingBranchCard book={book} activeBranch={draft.activeBranch} onActiveBranch={(activeBranch) => patch({ activeBranch })} />
    </>
  );
}

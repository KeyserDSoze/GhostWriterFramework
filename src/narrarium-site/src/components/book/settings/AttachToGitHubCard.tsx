import { Github, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GitHubRepositoryPicker } from "@/components/book/GitHubRepositoryPicker";
import { GitHubCreateFailure, GitHubCreateProgress } from "@/components/book/GitHubRepositoryOutcome";
import { defaultPublishRepositoryName } from "@/narrarium/bookScaffold";
import { decisionAction } from "@/github/repositoryPickerModel";
import type { BookEntry } from "@/types/settings";
import type { useAttachToGitHub } from "@/components/book/settings/useAttachToGitHub";

/** «Connect this book to GitHub»: pick a repository from the list or name a new one, and publish the book's working copy to it. */
export function AttachToGitHubCard({ book, attach }: { book: BookEntry; attach: ReturnType<typeof useAttachToGitHub> }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Github className="h-4 w-4" />{t("bookSettings.connectGithub.title")}</CardTitle>
        <CardDescription>{t("bookSettings.connectGithub.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <GitHubRepositoryPicker
          context="attach"
          token={attach.token}
          app={attach.app}
          login={attach.login}
          cacheKey={attach.cacheKey}
          defaultName={defaultPublishRepositoryName(book.name)}
          choices={attach.choices}
          onChoicesChange={attach.setChoices}
          preflight={attach.preflight}
          books={attach.books}
          disabled={attach.attaching}
          onDecision={attach.setDecision}
        />
        {attach.error && <Alert variant="destructive"><AlertDescription>{attach.error}</AlertDescription></Alert>}
        <GitHubCreateProgress progress={attach.progress} busy={attach.attaching} />
        {attach.failure && <GitHubCreateFailure error={attach.failure} owner={attach.owner} accountLogin={attach.accountLogin} repo={attach.decision?.name ?? ""} busy={attach.attaching} onRetry={() => void attach.attach()} onDelete={attach.deleteEmptyRepository} />}
        <Button className="h-auto min-h-10 whitespace-normal text-left [@media(pointer:coarse)]:min-h-11" onClick={() => void attach.attach()} disabled={attach.attaching || !attach.decision?.ready}>{attach.attaching ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Github className="mr-1 h-4 w-4" />}{attach.decision && decisionAction(attach.decision) !== "create" ? t(`github.picker.action.${decisionAction(attach.decision)}`) : t("bookSettings.connectGithub.submit")}</Button>
      </CardContent>
    </Card>
  );
}


import { Suspense, lazy } from "react";
import "@/i18n/readerAccess";
import { useTranslation } from "react-i18next";
import { Github, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { bookStorageMode, type BookEntry } from "@/types/settings";

// The passwords and GitHub Pages of the reader, and the sealed-box code they need, load only when this tab is first opened.
const ReaderAccessCard = lazy(() => import("@/components/book/readerAccess/ReaderAccessCard").then((module) => ({ default: module.ReaderAccessCard })));

interface Props {
  book: BookEntry;
  /** The tab has been shown at least once: only then is GitHub asked about the reader. */
  opened: boolean;
  onGoToGitHub: () => void;
}

/** The published reader: GitHub Pages and its passwords. A book that lives only on this device cannot have one yet, and the tab says why and where to go. */
export function OnlineReaderTab({ book, opened, onGoToGitHub }: Props) {
  const { t } = useTranslation();
  if (bookStorageMode(book) !== "github") {
    return (
      <Card data-testid="online-reader-unavailable">
        <CardHeader>
          <CardTitle>{t("readerAccess.title")}</CardTitle>
          <CardDescription>{t("bookSettings.tabs.readerNeedsGitHub")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" variant="outline" onClick={onGoToGitHub}><Github aria-hidden="true" className="mr-1 h-4 w-4" />{t("bookSettings.tabs.goToGitHub")}</Button>
        </CardContent>
      </Card>
    );
  }
  if (!opened) return null;
  return (
    <Suspense fallback={<p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("readerAccess.loading")}</p>}>
      <ReaderAccessCard book={book} />
    </Suspense>
  );
}

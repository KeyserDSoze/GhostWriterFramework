import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, XCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { bookFileRoute, filesInError, isProblemLine, problemLines, profilePageRoute, profilePagesFor, type ProfilePage } from "@/autopilot/stopReason";
import { cn } from "@/lib/utils";

const OPEN_KEY: Record<ProfilePage, string> = { director: "openDirector", ghostwriters: "openGhostwriters", readers: "openReaders" };

/**
 * A run that waits for the author without a question: the engine found a profile file (the director, a ghostwriter, a simulated
 * reader) that it cannot read as it is written, and stopped before spending anything. Says so, lists the problems one to a line, and
 * leads to the pages that correct those files. The text is one alert, so it is announced once; the button that resumes is the
 * page's own, and `hintId` ties it to what it does.
 */
export function ProfileProblemsNotice({ bookId, message, compact = false, hintId }: { bookId: string; message: string | null | undefined; compact?: boolean; hintId?: string }) {
  const { t } = useTranslation();
  const lines = useMemo(() => problemLines(message), [message]);
  const pages = useMemo(() => profilePagesFor(lines), [lines]);
  const Heading = compact ? "p" : "h2";
  return (
    <section className={cn("space-y-3 border border-amber-500/40 bg-amber-500/5", compact ? "rounded-xl p-3" : "rounded-2xl p-4 sm:p-5")}>
      <div role="alert" className="space-y-2">
        <Heading className={cn("flex items-start gap-2 font-semibold", compact ? "text-xs" : "text-base")}>
          <AlertTriangle className={cn("shrink-0 text-amber-800 dark:text-amber-300", compact ? "mt-0.5 h-3.5 w-3.5" : "mt-1 h-4 w-4")} aria-hidden />
          <span>{t("autopilot.profileProblems.title")}</span>
        </Heading>
        {!compact && <p className="text-sm">{t("autopilot.profileProblems.explain")}</p>}
        {lines.length > 0 && (
          <ul aria-label={t("autopilot.profileProblems.listLabel")} className={cn("list-disc space-y-1 break-words pl-5", compact ? "text-xs" : "text-sm")}>
            {lines.map((line, index) => <li key={index} lang={isProblemLine(line) ? "en" : undefined}>{line}</li>)}
          </ul>
        )}
      </div>
      <nav aria-label={t("autopilot.profileProblems.linksLabel")} className="flex flex-wrap gap-2">
        {pages.map((page) => (
          <Button key={page} asChild size="sm" variant="outline">
            <Link to={profilePageRoute(bookId, page)}>{t(`autopilot.profileProblems.${OPEN_KEY[page]}`)}</Link>
          </Button>
        ))}
      </nav>
      {hintId && <p id={hintId} className="text-xs text-muted-foreground">{t("autopilot.profileProblems.resumeHint", { action: t("autopilot.actions.resume") })}</p>}
    </section>
  );
}

/**
 * A run that ended with an error: the whole message, in an alert, and for each file of the book it names a way to open it when the
 * site has a page for it (the path as text when it has not). When the engine refused to rewrite a file whose front matter it cannot
 * read, says what to do: correct the line and resume.
 */
export function RunErrorNotice({ bookId, message, compact = false }: { bookId: string; message: string; compact?: boolean }) {
  const { t } = useTranslation();
  const files = useMemo(() => filesInError(message).map((file) => ({ ...file, href: bookFileRoute(bookId, file.path) })), [bookId, message]);
  const refusal = files.some((file) => file.frontmatter);
  const detail = files.length > 0 && (
    <ul className="space-y-1 text-xs">
      {files.map((file) => (
        <li key={file.path} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <code className="break-all">{file.path}</code>
          {file.href && <Link to={file.href} className="inline-flex min-h-6 items-center font-medium underline underline-offset-4" aria-label={t("autopilot.fileError.openFileNamed", { path: file.path })}>{t("autopilot.fileError.openFile")}</Link>}
        </li>
      ))}
    </ul>
  );
  const hint = refusal && <p className="text-xs">{t("autopilot.fileError.hint")}</p>;
  if (compact) {
    return (
      <div role="alert" className="space-y-1.5 rounded-md bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">
        <p className="flex items-start gap-1.5"><XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /><span className="min-w-0 break-words"><span className="font-medium">{t("autopilot.lastError")}:</span> {message}</span></p>
        {detail}
        {hint}
      </div>
    );
  }
  return (
    <Alert className="border-red-500/50 bg-red-500/5 text-red-700 dark:border-red-400/50 dark:text-red-300 [&>svg]:text-red-700 dark:[&>svg]:text-red-300">
      <XCircle className="h-4 w-4" aria-hidden />
      <AlertDescription className="space-y-2">
        <p className="break-words"><span className="font-medium">{t("autopilot.lastError")}:</span> {message}</p>
        {detail}
        {hint}
      </AlertDescription>
    </Alert>
  );
}

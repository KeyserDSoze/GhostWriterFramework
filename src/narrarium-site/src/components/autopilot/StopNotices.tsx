import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, XCircle } from "lucide-react";
import type { AutopilotErrorKind } from "narrarium-engine";
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
 * The files of the book that an error names, each with the way to open it when the site has a page for it (the path as text when it has not), and, when the engine
 * refused to rewrite a file whose front matter it cannot read (or when the caller knows that is the problem: `hint`), what to do: correct the line and resume.
 * Shown by the panel of an error and by the short notice of the dock and of the list of books: one place that says it.
 */
export function ErrorFiles({ bookId, message, hint = false }: { bookId: string; message: string; hint?: boolean }) {
  const { t } = useTranslation();
  const files = useMemo(() => filesInError(message).map((file) => ({ ...file, href: bookFileRoute(bookId, file.path) })), [bookId, message]);
  const refusal = hint || files.some((file) => file.frontmatter);
  return (
    <>
      {files.length > 0 && (
        <ul className="space-y-1 text-xs">
          {files.map((file) => (
            <li key={file.path} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <code className="break-all">{file.path}</code>
              {file.href && <Link to={file.href} className="inline-flex min-h-6 items-center font-medium underline underline-offset-4" aria-label={t("autopilot.fileError.openFileNamed", { path: file.path })}>{t("autopilot.fileError.openFile")}</Link>}
            </li>
          ))}
        </ul>
      )}
      {refusal && <p className="text-xs">{t("autopilot.fileError.hint")}</p>}
    </>
  );
}

/**
 * A run that ended with an error, in short, for the places that have no room for the whole panel (the live panel, the list of books): what kind of failure it was when
 * the engine said, the words of the failure cut to a few lines, the files it names with the way to open them, and, when `pageHref` is given, the way to the page that has
 * the whole panel. One alert, so it is announced once.
 */
export function RunErrorNotice({ bookId, message, kind, pageHref }: { bookId: string; message: string; kind?: AutopilotErrorKind; pageHref?: string }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="space-y-1.5 rounded-md bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">
      <p className="flex items-start gap-1.5">
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="line-clamp-4 min-w-0 break-words">
          {kind && <span className="font-semibold">{t(`autopilot.failure.kind.${kind}.title`)}. </span>}
          <span className="font-medium">{t("autopilot.lastError")}:</span> {message}
        </span>
      </p>
      <ErrorFiles bookId={bookId} message={message} />
      {pageHref && <Link to={pageHref} className="inline-flex min-h-6 items-center font-medium underline underline-offset-4">{t("autopilot.failure.seeDetails")}</Link>}
    </div>
  );
}

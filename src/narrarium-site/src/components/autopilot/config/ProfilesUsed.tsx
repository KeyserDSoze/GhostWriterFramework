import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CircleCheck, CircleDashed, TriangleAlert, UserCog } from "lucide-react";
import { parseDirector, parseGhostwriter, parseReaderPersona, type AutopilotStateSummary, type BookFileContent } from "narrarium-engine";
import { Card } from "@/components/autopilot/Card";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import { isProblemLine, isProfileProblemStop, problemLines } from "@/autopilot/stopReason";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";
import { cn } from "@/lib/utils";

/** In the book (its file is there and can be read), the defaults (no file: the autopilot uses its own), or with problems (a file it cannot read as written). */
export type ProfileStatus = "present" | "default" | "problems";

type ProfileKey = "director" | "ghostwriters" | "evaluationStyle" | "readers";

const PROFILES: Array<{ key: ProfileKey; titleKey: string; path: string; files?: RegExp }> = [
  { key: "director", titleKey: "director.title", path: "director", files: /^director\.md\b/ },
  { key: "ghostwriters", titleKey: "ghostwriters.title", path: "ghostwriters", files: /^ghostwriters\// },
  { key: "evaluationStyle", titleKey: "evaluationStyle.title", path: "evaluation-style" },
  { key: "readers", titleKey: "readerPersonas.title", path: "simulated-readers", files: /^personas\// },
];

const STATUS_ICON = { present: CircleCheck, default: CircleDashed, problems: TriangleAlert } as const;
const STATUS_TONE = {
  present: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  default: "bg-muted text-muted-foreground",
  problems: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
} as const;

/** Which profiles have files that the engine cannot read as they are written: the warnings of its own parsers, read from the working copy of the book. */
function useProfileWarnings(book: BookEntry, branch: string, structure: BookStructure | undefined): ReadonlySet<ProfileKey> {
  const [warned, setWarned] = useState<ReadonlySet<ProfileKey>>(() => new Set());
  const hasDirector = Boolean(structure?.rootFiles?.some((file) => file.path === "director.md"));
  const paths = useMemo(() => [
    ...(hasDirector ? ["director.md"] : []),
    ...(structure?.ghostwriters ?? []).map((entry) => entry.path),
    ...(structure?.readerPersonas ?? []).map((entry) => entry.path),
  ], [hasDirector, structure?.ghostwriters, structure?.readerPersonas]);
  const pathsKey = paths.join("\n");
  const language = structure?.language;
  // The settings are replaced whenever they reload, so the `book` object is new each time: the files are read again only for another book or branch.
  const latestBook = useRef(book);
  latestBook.current = book;
  const { id, owner, repo } = book;
  useEffect(() => {
    if (!pathsKey) {
      setWarned(new Set());
      return undefined;
    }
    let cancelled = false;
    const store = createBrowserBookStore(latestBook.current, branch);
    const wanted = pathsKey.split("\n");
    const reading = store.readMany ? store.readMany(wanted) : Promise.all(wanted.map((path) => store.read(path))).then((files) => files.filter((file): file is BookFileContent => Boolean(file)));
    reading
      .then((files) => {
        if (cancelled) return;
        const next = new Set<ProfileKey>();
        for (const file of files) {
          const ghostwriter = /^ghostwriters\/(.+)\.md$/.exec(file.path);
          const persona = /^personas\/(.+)\.md$/.exec(file.path);
          if (file.path === "director.md" && parseDirector(file.content, language).warnings?.length) next.add("director");
          if (ghostwriter && parseGhostwriter(ghostwriter[1], file.content).warnings?.length) next.add("ghostwriters");
          if (persona && parseReaderPersona(persona[1], file.content).warnings?.length) next.add("readers");
        }
        setWarned(next);
      })
      // A book whose working copy is not ready yet says what its structure says: present or defaults.
      .catch(() => { if (!cancelled) setWarned(new Set()); });
    return () => { cancelled = true; };
  }, [id, owner, repo, branch, pathsKey, language]);
  return warned;
}

/**
 * The profiles the autopilot follows, each with the way to the page that edits it and its state: in the book, the defaults, or with problems
 * (a file the engine cannot read as written, or one that the autopilot stopped for). The director is one of them: it stays with the profiles
 * of the menu, and this is the way to it from the configuration.
 */
export function ProfilesUsed({ book, branch, structure, summary }: { book: BookEntry; branch: string; structure: BookStructure | undefined; summary: AutopilotStateSummary | null }) {
  const { t } = useTranslation();
  const warned = useProfileWarnings(book, branch, structure);
  const stopped = useMemo(() => (isProfileProblemStop(summary) ? problemLines(summary?.message).filter(isProblemLine) : []), [summary]);
  const root = `/app/books/${encodeURIComponent(book.id)}`;
  const present: Record<ProfileKey, boolean> = {
    director: Boolean(structure?.rootFiles?.some((file) => file.path === "director.md")),
    ghostwriters: Boolean(structure?.ghostwriters.length),
    evaluationStyle: Boolean((structure?.firstClassFiles ?? structure?.rootFiles ?? []).some((file) => file.path === "evaluation-guidelines.md")),
    readers: Boolean(structure?.readerPersonas.length),
  };
  const statusOf = (key: ProfileKey, files?: RegExp): ProfileStatus | null => {
    if (!structure) return null;
    if (warned.has(key) || (files && stopped.some((line) => files.test(line)))) return "problems";
    return present[key] ? "present" : "default";
  };

  return (
    <Card id="autopilot-profiles" title={t("autopilot.config.sections.profiles")} icon={<UserCog className="h-4 w-4 text-primary" aria-hidden="true" />}>
      <p className="text-sm text-muted-foreground">{t("autopilot.config.profiles.description")}</p>
      <ul className="divide-y rounded-lg border">
        {PROFILES.map(({ key, titleKey, path, files }) => {
          const status = statusOf(key, files);
          const Icon = status ? STATUS_ICON[status] : null;
          return (
            <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <div className="min-w-0 flex-1">
                <Link to={`${root}/${path}`} className="inline-flex min-h-6 items-center rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t(titleKey)}</Link>
                <p className="text-xs text-muted-foreground">{t(`autopilot.config.profiles.about.${key}`)}</p>
              </div>
              {status && Icon && (
                <span data-profile-status={status} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[status])}>
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t(`autopilot.config.profiles.status.${status}`)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

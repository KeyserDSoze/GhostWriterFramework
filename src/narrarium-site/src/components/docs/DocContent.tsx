import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import "@/i18n/docsContent";
import { Button } from "@/components/ui/button";
import { localizedDoc } from "@/lib/docs";
import { loadDocMarkdown } from "@/lib/docContent";
import type { DocEntry, DocLang } from "@/lib/generated-docs";
import { cn } from "@/lib/utils";

// Only what the docs routes already load: no icon or component of its own, whose chunks would lengthen the preload lists of the app entry.
const HEADINGS = "h1, h2, h3, h4, h5, h6";
/** Where reading happens, from the top of the window: below the sticky header of the public pages. */
const READING_LINE = 96;

/** The id of a heading as GitHub makes it, so that the links of the repository's documents (`#mcp-for-each-book`) reach their sections here too. */
export function headingId(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

/** Every heading of the text gets its id (the second one with the same words `-1`, and so on), never one that the page already has. */
function identifyHeadings(container: HTMLElement): void {
  const seen = new Map<string, number>();
  for (const heading of container.querySelectorAll<HTMLElement>(HEADINGS)) {
    const base = headingId(heading.textContent ?? "") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    let id = count ? `${base}-${count}` : base;
    while (document.getElementById(id) && !container.contains(document.getElementById(id))) id = `${id}-doc`;
    heading.id = id;
  }
}

type ReadingPlace = { index: number; top: number };

/** The section being read: the last heading above the reading line, and where it is on the screen. */
function readingPlace(container: HTMLElement | null): ReadingPlace | null {
  let place: ReadingPlace | null = null;
  container?.querySelectorAll<HTMLElement>(HEADINGS).forEach((heading, index) => {
    const { top } = heading.getBoundingClientRect();
    if (top <= READING_LINE) place = { index, top };
  });
  return place;
}

/** What scrolls the text: the nearest scrolling box around it, or the window. */
function scrollerOf(element: HTMLElement): { scrollBy(x: number, y: number): void } {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return window;
}

/** The same section of the translation goes back where the reader had it: the translations of a document have the same headings, in order. */
function keepReadingPlace(container: HTMLElement, place: ReadingPlace): void {
  const heading = container.querySelectorAll<HTMLElement>(HEADINGS)[place.index];
  if (!heading) return;
  const shift = heading.getBoundingClientRect().top - place.top;
  if (shift) scrollerOf(container).scrollBy(0, shift);
}

/**
 * The page of a document: `document.title` names it while it is open (the previous title comes back when it closes), and the focus moves to its title
 * when another document opens, so that a screen reader says which one; not when only the language changes, and not when the address points to a section.
 */
export function useDocumentPage(slug: string, title: string, heading: RefObject<HTMLElement>): void {
  const { hash } = useLocation();
  const hashAtOpen = useRef(hash);
  hashAtOpen.current = hash;
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · Narrarium`;
    return () => {
      document.title = previous;
    };
  }, [title]);
  useEffect(() => {
    if (!hashAtOpen.current) heading.current?.focus();
  }, [slug, heading]);
}

type Shown = { slug: string; sourcePath: string; html: string };

/**
 * The text of a document, loaded when it is shown (a chunk per file: see `loadDocMarkdown`). While it loads the title and the index stay and a status
 * says so; if it cannot be loaded, an error says what to do, with Retry. The section of the address is reached once the text is there, and a new
 * language replaces the text with its translation at the same place.
 */
export function DocContent({ entry, lang, render, className }: { entry: DocEntry; lang: DocLang; render: (markdown: string) => string; className?: string }) {
  const { t } = useTranslation();
  const { hash } = useLocation();
  const { sourcePath } = localizedDoc(entry, lang);
  const [shown, setShown] = useState<Shown | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const region = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const place = useRef<ReadingPlace | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    let current = true;
    const before = shownRef.current;
    // The same document in another language: its text stays on screen until the translation is there, and the place being read is kept.
    if (before?.slug === entry.slug) place.current = readingPlace(body.current);
    else {
      place.current = null;
      setShown(null);
    }
    setState("loading");
    loadDocMarkdown(entry, lang).then(
      (markdown) => {
        if (!current) return;
        setShown({ slug: entry.slug, sourcePath, html: render(markdown) });
        setState("ready");
      },
      () => {
        if (!current) return;
        setShown(null);
        setState("error");
      },
    );
    return () => {
      current = false;
    };
  }, [entry.slug, sourcePath, attempt]);

  useLayoutEffect(() => {
    if (!body.current || !shown) return;
    identifyHeadings(body.current);
    if (place.current) keepReadingPlace(body.current, place.current);
    place.current = null;
  }, [shown?.html]);

  const shownSlug = shown?.slug ?? null;
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ""));
    if (!id || !shownSlug || !body.current) return;
    const target = [...body.current.querySelectorAll<HTMLElement>(HEADINGS)].find((heading) => heading.id === id);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }, [hash, shownSlug]);

  const retry = () => {
    region.current?.focus();
    setAttempt((count) => count + 1);
  };

  const loading = state === "loading";
  return (
    <div ref={region} tabIndex={-1} aria-busy={loading} className={cn("outline-none", !shown && "min-h-64")}>
      <p role="status" className={loading ? "mb-6 flex items-center gap-2 text-sm text-muted-foreground" : "sr-only"}>
        {loading && <span className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
        {loading ? t("docsContent.loading") : ""}
      </p>
      {state === "error" && (
        <div role="alert" className="space-y-3 rounded-lg border border-destructive/50 p-4 dark:border-destructive">
          <p className="font-medium text-destructive">{t("docsContent.error.title")}</p>
          <p className="text-sm text-foreground">{t("docsContent.error.body")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={retry}>{t("docsContent.retry")}</Button>
            <Button type="button" variant="outline" onClick={() => window.location.reload()}>{t("docsContent.reload")}</Button>
          </div>
        </div>
      )}
      {shown && <div ref={body} className={className} dangerouslySetInnerHTML={{ __html: shown.html }} />}
    </div>
  );
}

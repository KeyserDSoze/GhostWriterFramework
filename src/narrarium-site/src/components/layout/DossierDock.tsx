import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { X, Search, ExternalLink, Anchor, PanelRightClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDossierStore, type DossierEntry } from "@/store/dossierStore";
import { useBooksStore } from "@/store/booksStore";
import { useUiStore } from "@/store/uiStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { parseAppRoute } from "@/assistant/context";
import { resolveBookToken } from "@/types/settings";
import { slugToTitle } from "@/github/githubClient";
import { openCanonDossier } from "@/narrarium/openDossier";
import { CANON_SECTION_ORDER, canonSectionMeta, type CanonSection } from "@/lib/canonSections";
import type { BookStructure } from "@/types/book";
import { useToast } from "@/components/ui/use-toast";

const DOSSIER_WIDTH_KEY = "narrarium-dossier-width";
const DOSSIER_MIN_WIDTH = 320;
const DOSSIER_MAX_WIDTH = 900;
const DOSSIER_DEFAULT_WIDTH = 384;

interface SearchHit {
  section: CanonSection;
  name: string;
  path: string;
  imagePath?: string;
}

function collectEntities(structure: BookStructure | undefined): SearchHit[] {
  if (!structure) return [];
  const hits: SearchHit[] = [];
  for (const section of CANON_SECTION_ORDER) {
    const files = (structure as unknown as Record<string, BookStructure["characters"]>)[section] ?? [];
    for (const f of files) {
      const slug = (f.path.split("/").pop() ?? "").replace(/\.md$/i, "");
      hits.push({ section, name: f.name ?? slugToTitle(slug), path: f.path, imagePath: f.imagePath });
    }
  }
  return hits;
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---[\s\S]*?---\s*/, "").trim();
}

export function DossierDock() {
  const { t } = useTranslation();
  const { docked, floating } = useDossierStore();
  const hidden = useUiStore((s) => s.dossierColumnHidden);
  const setHidden = useUiStore((s) => s.setDossierColumnHidden);

  // Search needs the current book context (matches FloatingActions/useContextualActions).
  const location = useLocation();
  const { structures } = useBooksStore();
  const route = parseAppRoute(location.pathname);
  const bookId = "bookId" in route ? route.bookId : undefined;
  const structure = bookId ? structures[bookId] : undefined;

  const columnAvailable = Boolean(docked) || Boolean(structure);

  // Persisted, resizable column width.
  const [width, setWidth] = useState<number>(() => {
    const raw = Number(localStorage.getItem(DOSSIER_WIDTH_KEY));
    return Number.isFinite(raw) && raw >= DOSSIER_MIN_WIDTH ? Math.min(raw, DOSSIER_MAX_WIDTH) : DOSSIER_DEFAULT_WIDTH;
  });
  const resizingRef = useRef(false);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!resizingRef.current) return;
      const next = Math.max(DOSSIER_MIN_WIDTH, Math.min(window.innerWidth - e.clientX, DOSSIER_MAX_WIDTH));
      setWidth(next);
    }
    function onUp() {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.userSelect = "";
      try { localStorage.setItem(DOSSIER_WIDTH_KEY, String(width)); } catch { /* ignore */ }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [width]);

  return (
    <>
      {columnAvailable && !hidden && (
        <aside className="relative hidden shrink-0 flex-col border-l bg-card/92 xl:flex" style={{ width }}>
          {/* Drag handle on the left edge to resize. */}
          <div
            onMouseDown={() => { resizingRef.current = true; document.body.style.userSelect = "none"; }}
            className="absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/40"
            title={t("dossier.resize")}
          />
          <div className="border-b p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.22em] text-primary">{t("dossier.title")}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t("dossier.stayOpen")}</p>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setHidden(true)} aria-label={t("dossier.hide")} title={t("dossier.hide")}>
                <PanelRightClose className="h-4 w-4" />
              </Button>
            </div>
            {structure && bookId && <DossierSearch structure={structure} bookId={bookId} />}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-3 p-4">
              {docked ? (
                <DossierCard entry={docked} variant="docked" />
              ) : (
                <p className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">{t("dossier.empty")}</p>
              )}
            </div>
          </div>
        </aside>
      )}

      {floating.map((entry) => (
        <FloatingDossier key={entry.id} entry={entry} />
      ))}
    </>
  );
}

function DossierSearch({ structure, bookId }: { structure: BookStructure; bookId: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const entities = useMemo(() => collectEntities(structure), [structure]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 3) return [];
    return entities
      .filter((e) => e.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q))
      .slice(0, 12);
  }, [entities, query]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  const book = settings.books.find((b) => b.id === bookId);
  const token = book ? resolveBookToken(book, settings) : "";

  async function pick(hit: { section: CanonSection; name: string; path: string; imagePath?: string }) {
    if (!book || !token) return;
    setOpen(false);
    setQuery("");
    try {
      await openCanonDossier({ token, owner: book.owner, repo: book.repo, branch, bookId, section: hit.section, file: { path: hit.path, name: hit.name, imagePath: hit.imagePath } });
    } catch (err) {
      toast({ title: t("dossier.openFailed"), description: String(err), variant: "destructive" });
    }
  }

  return (
    <div ref={boxRef} className="relative mt-3">
      <div className="flex items-center gap-2 rounded-lg border bg-background px-2">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={t("dossier.searchPlaceholder")}
          className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {open && query.trim().length >= 3 && (
        <div className="absolute left-0 right-0 top-11 z-20 max-h-72 overflow-auto rounded-xl border bg-popover p-1 shadow-2xl">
          {results.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">{t("dossier.noResults")}</p>
          ) : results.map((hit) => {
            const meta = canonSectionMeta(hit.section);
            const Icon = meta?.icon;
            return (
              <button
                key={hit.path}
                type="button"
                onClick={() => void pick(hit)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent"
              >
                {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                <span className="truncate">{hit.name}</span>
                <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{meta ? t(meta.labelKey) : hit.section}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DossierCard({ entry, variant }: { entry: DossierEntry; variant: "docked" | "floating" }) {
  const { t } = useTranslation();
  const { undock, closeDossier } = useDossierStore();
  const meta = canonSectionMeta(entry.section);
  const Icon = meta?.icon;
  const body = useMemo(() => stripFrontmatter(entry.content), [entry.content]);

  return (
    <article className="overflow-hidden rounded-2xl border bg-background/70 p-4 shadow-sm">
      <div className="mb-3 flex items-start gap-3">
        {entry.imageUrl && (
          <img src={entry.imageUrl} alt={entry.title} className="h-14 w-14 shrink-0 rounded-lg object-cover ring-1 ring-border" />
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {Icon && <Icon className="h-3 w-3" />}{meta ? t(meta.labelKey) : entry.section}
          </p>
          <h3 className="truncate font-serif text-xl font-semibold leading-tight">{entry.title}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {variant === "docked" && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => undock(entry.id)} aria-label={t("dossier.undock")} title={t("dossier.undock")}>
              <ExternalLink className="h-4 w-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => closeDossier(entry.id)} aria-label={t("dossier.close")}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <p className="mb-3 break-all rounded-lg bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">{entry.path}</p>
      <pre className="w-full max-w-full whitespace-pre-wrap break-words rounded-xl bg-muted/50 p-3 text-xs leading-6 text-foreground [overflow-wrap:anywhere]">{body || entry.content}</pre>
    </article>
  );
}

function FloatingDossier({ entry }: { entry: DossierEntry }) {
  const { t } = useTranslation();
  const { dock, closeDossier, moveFloating } = useDossierStore();
  const meta = canonSectionMeta(entry.section);
  const Icon = meta?.icon;
  const body = useMemo(() => stripFrontmatter(entry.content), [entry.content]);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { dx: e.clientX - (entry.x ?? 80), dy: e.clientY - (entry.y ?? 80) };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const x = Math.max(8, Math.min(e.clientX - dragRef.current.dx, window.innerWidth - 360));
    const y = Math.max(8, Math.min(e.clientY - dragRef.current.dy, window.innerHeight - 80));
    moveFloating(entry.id, x, y);
  }
  function onPointerUp() { dragRef.current = null; }

  return (
    <div
      data-no-context-menu
      className="fixed z-[60] flex h-[70vh] max-h-[70vh] w-[380px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl"
      style={{ left: entry.x ?? 80, top: entry.y ?? 80 }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="flex shrink-0 cursor-move items-center gap-2 border-b bg-muted/40 px-3 py-2"
      >
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
        <span className="truncate text-sm font-semibold">{entry.title}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => dock(entry.id)} aria-label={t("dossier.dock")} title={t("dossier.dock")}>
            <Anchor className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => closeDossier(entry.id)} aria-label={t("dossier.close")}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {entry.imageUrl && (
          <img src={entry.imageUrl} alt={entry.title} className="mb-3 h-24 w-24 rounded-lg object-cover ring-1 ring-border" />
        )}
        <p className="mb-2 break-all rounded-lg bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">{entry.path}</p>
        <pre className="w-full max-w-full whitespace-pre-wrap break-words rounded-xl bg-muted/50 p-3 text-xs leading-6 text-foreground [overflow-wrap:anywhere]">{body || entry.content}</pre>
      </div>
    </div>
  );
}

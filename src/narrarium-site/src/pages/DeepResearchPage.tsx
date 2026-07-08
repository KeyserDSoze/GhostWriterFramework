import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { parse as parseYaml } from "yaml";
import {
  AlertCircle, BookOpen, ChevronRight, FlaskConical,
  Loader2, Plus, Search, Trash2, Users, MapPin, Shield, Package, Clock, EyeOff,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { resolveBookToken } from "@/types/settings";
import { deleteFile, readFileWithSha } from "@/github/githubClient";
import { runDeepResearch } from "@/research/engine";
import { createEntityFromResearch, DEFAULT_CREATE_PROMPTS } from "@/research/createFromResearch";
import type { EntityKind } from "@/narrarium/canon";
import { ENTITY_LABEL } from "@/narrarium/canon";
import type { ResearchDepth, ResearchFrontmatter, ResearchSourceMode } from "@/research/types";
import type { ResearchFile } from "@/types/book";

const ENTITY_KINDS: EntityKind[] = ["character", "location", "faction", "item", "secret", "timeline-event"];
const ENTITY_ICONS: Record<EntityKind, React.ReactNode> = {
  character: <Users className="h-4 w-4" />,
  location: <MapPin className="h-4 w-4" />,
  faction: <Shield className="h-4 w-4" />,
  item: <Package className="h-4 w-4" />,
  secret: <EyeOff className="h-4 w-4" />,
  "timeline-event": <Clock className="h-4 w-4" />,
};

// ─── Research detail view ─────────────────────────────────────────────────────

function ResearchDetail({
  file,
  book,
  token,
  branch,
  onDelete,
  onEntityCreated,
}: {
  file: ResearchFile;
  book: import("@/types/settings").BookEntry;
  token: string;
  branch: string;
  onDelete: () => void;
  onEntityCreated: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const navigate = useNavigate();
  const [markdown, setMarkdown] = useState("");
  const [frontmatter, setFrontmatter] = useState<ResearchFrontmatter | null>(null);
  const [loadBusy, setLoadBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [sha, setSha] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createKind, setCreateKind] = useState<EntityKind>("character");
  const [customPrompt, setCustomPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setLoadBusy(true);
    readFileWithSha(token, book.owner, book.repo, branch, file.path)
      .then(({ content, sha: s }) => {
        setSha(s);
        setMarkdown(content);
        // Parse frontmatter
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          try { setFrontmatter(parseYaml(fmMatch[1]) as ResearchFrontmatter); } catch { /* ignore */ }
        }
      })
      .catch((err) => toast({ title: t("research.loadFailed"), description: String(err), variant: "destructive" }))
      .finally(() => setLoadBusy(false));
  }, [file.path, book.owner, book.repo, branch, token, t, toast]);

  async function handleDelete() {
    if (!window.confirm(t("research.deleteConfirm"))) return;
    setDeleteBusy(true);
    try {
      await deleteFile(token, book.owner, book.repo, branch, file.path, sha, `Remove research ${file.slug}`);
      toast({ title: t("research.deleted") });
      onDelete();
    } catch (err) {
      toast({ title: t("research.deleteFailed"), description: String(err), variant: "destructive" });
    } finally { setDeleteBusy(false); }
  }

  async function handleCreateEntity() {
    if (creating) { abortRef.current?.abort(); return; }
    abortRef.current = new AbortController();
    setCreating(true);
    try {
      const lang = i18n.resolvedLanguage?.split("-")[0] ?? settings.ui.language ?? "en";
      const result = await createEntityFromResearch({
        settings,
        book,
        branch,
        token,
        researchMarkdown: markdown,
        entityKind: createKind,
        customPrompt: customPrompt.trim() || undefined,
        language: lang,
        signal: abortRef.current.signal,
      });
      toast({ title: t("research.createSuccess"), description: result.suggestedName });
      onEntityCreated();
      navigate(`/app/books/${book.id}/canon/${createKind}s/${result.slug}`);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        toast({ title: t("research.createFailed"), description: String(err), variant: "destructive" });
      }
    } finally { setCreating(false); }
  }

  // Strip frontmatter from displayed body
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();

  if (loadBusy) return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-2xl font-semibold leading-tight">{file.title || file.slug}</h2>
          {frontmatter && (
            <p className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span>{t("research.date")}: {frontmatter.createdAt?.slice(0, 10)}</span>
              <span>{t("research.sourceMode")}: {frontmatter.sourceMode}</span>
              <span>{t("research.depth")}: {frontmatter.depth}</span>
              {frontmatter.relatedEntityId && <span>{t("research.relatedEntity")}: {frontmatter.relatedEntityId}</span>}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={deleteBusy} onClick={() => void handleDelete()}>
            {deleteBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}{t("common.delete")}
          </Button>
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            <FlaskConical className="mr-1 h-4 w-4" />{t("research.createFrom")}
          </Button>
        </div>
      </div>

      {showCreate && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t("research.createFrom")}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 sm:max-w-sm">
              <Label>{t("research.createEntityKindLabel")}</Label>
              <Select value={createKind} onValueChange={(v) => setCreateKind(v as EntityKind)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ENTITY_KINDS.map((k) => (
                    <SelectItem key={k} value={k}><span className="flex items-center gap-2">{ENTITY_ICONS[k]}{ENTITY_LABEL[k]}</span></SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t("research.createEntityCustomPromptLabel")}</Label>
              <AutoTextarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder={t("research.createEntityCustomPromptPlaceholder")}
                className="min-h-[80px] text-sm"
              />
              <p className="text-xs text-muted-foreground">{DEFAULT_CREATE_PROMPTS[createKind].slice(0, 120)}…</p>
            </div>
            <Button onClick={() => void handleCreateEntity()} disabled={creating}>
              {creating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-1 h-4 w-4" />}
              {creating ? t("research.creating") : t("research.createFrom")}
            </Button>
          </CardContent>
        </Card>
      )}

      <Separator />
      <div className="prose prose-sm max-w-none dark:prose-invert doc-prose" dangerouslySetInnerHTML={{ __html: "" }} />
      <pre className="whitespace-pre-wrap text-sm leading-7">{body}</pre>
    </div>
  );
}

// ─── New research form ────────────────────────────────────────────────────────

function NewResearchForm({
  book,
  token,
  branch,
  onDone,
}: {
  book: import("@/types/settings").BookEntry;
  token: string;
  branch: string;
  onDone: (slug: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { structure } = useBookStructure(book.id);
  const [query, setQuery] = useState("");
  const [sourceMode, setSourceMode] = useState<ResearchSourceMode>("wikipedia");
  const [depth, setDepth] = useState<ResearchDepth>("medium");
  const [relatedEntityId, setRelatedEntityId] = useState("");
  const [relatedEntityType, setRelatedEntityType] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Collect all canon entities for the "related entity" selector
  const allEntities = useMemo(() => {
    if (!structure) return [];
    const out: Array<{ id: string; label: string; kind: string }> = [];
    const add = (kind: string, files: import("@/types/book").BookFile[]) =>
      files.forEach((f) => out.push({ id: f.name ?? f.path, label: f.name ?? f.path, kind }));
    add("characters", structure.characters);
    add("locations", structure.locations);
    add("factions", structure.factions);
    add("items", structure.items);
    return out;
  }, [structure]);

  async function handleRun() {
    const q = query.trim();
    if (!q) return;
    if (busy) { abortRef.current?.abort(); return; }
    abortRef.current = new AbortController();
    setBusy(true);
    setProgress("");
    try {
      const lang = i18n.resolvedLanguage?.split("-")[0] ?? settings.ui.language ?? "en";
      const result = await runDeepResearch({
        settings,
        book,
        branch,
        token,
        query: q,
        sourceMode,
        depth,
        language: lang,
        relatedEntityId: relatedEntityId || undefined,
        relatedEntityType: relatedEntityType || undefined,
        signal: abortRef.current.signal,
        onProgress: setProgress,
      });
      toast({ title: result.title });
      onDone(result.slug);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        toast({ title: t("research.saveFailed"), description: String(err), variant: "destructive" });
      }
    } finally { setBusy(false); setProgress(""); }
  }

  return (
    <div className="space-y-5">
      <h2 className="font-serif text-xl font-semibold">{t("research.newTitle")}</h2>

      <div className="grid gap-2">
        <Label>{t("research.queryLabel")}</Label>
        <AutoTextarea
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("research.queryPlaceholder")}
          className="min-h-[80px]"
          disabled={busy}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-2">
          <Label>{t("research.sourceModeLabel")}</Label>
          <Select value={sourceMode} onValueChange={(v) => setSourceMode(v as ResearchSourceMode)} disabled={busy}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="wikipedia">{t("research.sourceWikipedia")}</SelectItem>
              <SelectItem value="internet">{t("research.sourceInternet")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>{t("research.depthLabel")}</Label>
          <Select value={depth} onValueChange={(v) => setDepth(v as ResearchDepth)} disabled={busy}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="low">{t("research.depthLow")}</SelectItem>
              <SelectItem value="medium">{t("research.depthMedium")}</SelectItem>
              <SelectItem value="high">{t("research.depthHigh")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>{t("research.relatedEntityLabel")}</Label>
          <Select
            value={relatedEntityId || "__none__"}
            onValueChange={(v) => {
              if (v === "__none__") { setRelatedEntityId(""); setRelatedEntityType(""); return; }
              const found = allEntities.find((e) => e.id === v);
              setRelatedEntityId(found?.id ?? "");
              setRelatedEntityType(found?.kind ?? "");
            }}
            disabled={busy}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("research.relatedEntityNone")}</SelectItem>
              {allEntities.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {busy && progress && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />{progress}
        </p>
      )}

      <div className="flex gap-2">
        <Button onClick={() => void handleRun()} disabled={!query.trim()}>
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}
          {busy ? t("research.running") : t("research.runResearch")}
        </Button>
        {busy && (
          <Button variant="outline" onClick={() => abortRef.current?.abort()}>
            {t("common.cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export function DeepResearchPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, loading, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";

  const [selected, setSelected] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const list: ResearchFile[] = useMemo(() => structure?.researchFiles ?? [], [structure]);
  const selectedFile = useMemo(() => list.find((f) => f.slug === selected) ?? null, [list, selected]);

  // Auto-select first on load
  useEffect(() => {
    if (!selected && list.length > 0) setSelected(list[0].slug);
  }, [list, selected]);

  function handleNewDone(slug: string) {
    setShowNew(false);
    void reload();
    setTimeout(() => setSelected(slug), 300);
  }

  function handleDeleted() {
    void reload();
    setSelected(null);
  }

  if (!book) return <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      {/* ── Left column: list + new button ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold">
            <Search className="h-5 w-5" />{t("research.title")}
          </h1>
          <Button size="sm" variant="outline" onClick={() => { setShowNew(true); setSelected(null); }}>
            <Plus className="mr-1 h-4 w-4" />{t("research.new")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("research.description")}</p>
        {loading && !structure ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {list.length === 0 && !showNew && (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("research.noResearch")}</p>
        )}
        <div className="space-y-1">
          {list.map((f) => (
            <button
              key={f.slug}
              type="button"
              onClick={() => { setSelected(f.slug); setShowNew(false); }}
              className={
                selected === f.slug && !showNew
                  ? "flex w-full items-center gap-2 rounded-lg border bg-primary/5 px-3 py-2 text-left text-sm"
                  : "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted/40"
              }
            >
              <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{f.title || f.slug}</span>
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      </div>

      {/* ── Right column: detail / new form ── */}
      <div>
        {showNew ? (
          <NewResearchForm
            book={book}
            token={token}
            branch={branch}
            onDone={handleNewDone}
          />
        ) : selectedFile && token ? (
          <ResearchDetail
            key={selectedFile.slug}
            file={selectedFile}
            book={book}
            token={token}
            branch={branch}
            onDelete={handleDeleted}
          onEntityCreated={() => {
            void reload();
          }}
          />
        ) : (
          <div className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">
            {t("research.noResearch")}
          </div>
        )}
      </div>
    </div>
  );
}

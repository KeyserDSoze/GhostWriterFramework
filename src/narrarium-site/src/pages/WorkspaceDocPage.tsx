import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, FileEdit, FileText, Loader2, Lock, Network, Plus, Save, Wand2, X } from "lucide-react";
import { parseDocument, stringify } from "yaml";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { useToast } from "@/components/ui/use-toast";
import { createOrUpdateTextFile, loadFileContent, readFileWithSha, updateFile } from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useSettingsStore } from "@/store/settingsStore";
import { resolveBookToken } from "@/types/settings";
import { useBookStructure } from "@/hooks/useBookStructure";
import { GeneratePreviewDialog } from "@/components/book/GeneratePreviewDialog";
import { GhostwriterField } from "@/components/book/GhostwriterField";
import { ScriptEditor } from "@/components/script/ScriptEditor";
import { parseScript, serializeScript, type ScriptDoc } from "@/narrarium/script/model";
import { proseToScript, refineProse, scriptToProse, stripFrontmatter, type PipelineSource } from "@/narrarium/pipeline";

interface MetaEntry {
  key: string;
  value: string | string[];
}

const READONLY_KEYS = new Set(["type", "id", "chapter", "paragraph"]);

function parseFrontmatter(raw: string): { entries: MetaEntry[]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { entries: [], body: raw };

  const doc = parseDocument(match[1]);
  const parsed = doc.toJSON() as Record<string, unknown> | null;
  const entries = Object.entries(parsed ?? {}).map(([key, value]) => ({
    key,
    value: normalizeMetaValue(value),
  }));
  return { entries, body: match[2] };
}

function buildFrontmatter(entries: MetaEntry[], body: string): string {
  const record: Record<string, unknown> = {};
  for (const entry of entries) {
    record[entry.key] = Array.isArray(entry.value)
      ? entry.value
      : parseScalarMetaValue(entry.value);
  }
  return `---\n${stringify(record).trim()}\n---\n\n${body}`;
}

function normalizeMetaValue(value: unknown): string | string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parseScalarMetaValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function paragraphSlug(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

export function WorkspaceDocPage() {
  const { bookId, chapterId, paragraphNum, workspaceKind } = useParams<{
    bookId: string;
    chapterId: string;
    paragraphNum?: string;
    workspaceKind: string;
  }>();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { t } = useTranslation();

  const { book, structure, loading: structureLoading, error: structureError, reload } = useBookStructure(bookId);
  const chapter = structure?.chapters.find((entry) => entry.slug === chapterId);
  const paragraph = chapter?.paragraphs.find((entry) => entry.number === paragraphNum);
  const token = book ? resolveBookToken(book, settings) : "";

  const [entries, setEntries] = useState<MetaEntry[]>([]);
  const [body, setBody] = useState("");
  const [sha, setSha] = useState("");
  const [savedEntries, setSavedEntries] = useState<MetaEntry[]>([]);
  const [savedBody, setSavedBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showAddMeta, setShowAddMeta] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const loadedTargetRef = useRef<string | null>(null);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [pipelineMode, setPipelineMode] = useState<"toDraft" | "toFinal">("toDraft");
  const [pipelineText, setPipelineText] = useState("");
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineGw, setPipelineGw] = useState("");
  const [scriptDoc, setScriptDoc] = useState<ScriptDoc>({ nodes: [] });
  const [scriptGenLoading, setScriptGenLoading] = useState(false);

  const resolved = resolveWorkspacePath(chapter, paragraph, workspaceKind, !!paragraphNum);
  const path = resolved?.path ?? null;
  const title = resolved
    ? t(resolved.titleKey, resolved.titleParams)
    : t("workspace.document");
  const backHref = paragraph
    ? `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraph.number}`
    : `/app/books/${bookId}/chapters/${chapterId}`;

  const isDirty = body !== savedBody || JSON.stringify(entries) !== JSON.stringify(savedEntries);

  useEffect(() => {
    const targetKey = book && path ? `${branch}:${path}` : null;
    if (!book || !token || !path || !targetKey || loadedTargetRef.current === targetKey) return;
    loadedTargetRef.current = targetKey;
    setLoading(true);
    readFileWithSha(token, book.owner, book.repo, branch, path)
      .then(({ content, sha: fileSha }) => {
        const parsed = parseFrontmatter(content);
        setEntries(parsed.entries);
        setSavedEntries(parsed.entries);
        setBody(parsed.body);
        setSavedBody(parsed.body);
        setSha(fileSha);
        if (workspaceKind === "script") setScriptDoc(parseScript(parsed.body));
      })
      .catch((err) => {
        loadedTargetRef.current = null;
        toast({ title: t("workspace.loadFailed"), description: String(err), variant: "destructive" });
      })
      .finally(() => setLoading(false));
  }, [book, token, branch, path, t, toast]);

  if (!book) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("bookPage.notFound")}</AlertDescription>
      </Alert>
    );
  }
  if (structureLoading && !structure) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
    );
  }
  if (structureError && !structure) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{structureError}</span>
          <Button size="sm" variant="outline" onClick={() => reload()}>{t("common.reloadBook")}</Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!chapter || !path) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {t("workspace.notFound")} <Link to={`/app/books/${bookId}`} className="underline">{t("workspace.backToBook")}</Link>
        </AlertDescription>
      </Alert>
    );
  }

  function setEntryValue(key: string, value: string | string[]) {
    setEntries((prev) => prev.map((entry) => (entry.key === key ? { ...entry, value } : entry)));
  }

  function removeEntry(key: string) {
    setEntries((prev) => prev.filter((entry) => entry.key !== key));
  }

  function addEntry() {
    const key = newKey.trim().toLowerCase().replace(/\s+/g, "-");
    if (!key || entries.some((entry) => entry.key === key)) return;
    const raw = newVal.trim();
    const value = raw.startsWith("[") || raw.includes(",")
      ? raw.replace(/^\[|\]$/g, "").split(",").map((part) => part.trim()).filter(Boolean)
      : raw;
    setEntries((prev) => [...prev, { key, value }]);
    setNewKey("");
    setNewVal("");
    setShowAddMeta(false);
  }

  async function handleSave() {
    if (!isDirty || !path) return;
    setSaving(true);
    try {
      const nextContent = buildFrontmatter(entries, body);
      const newSha = await updateFile(
        token,
        book!.owner,
        book!.repo,
        branch,
        path,
        sha,
        nextContent,
        `Update ${title}`,
      );
      setSha(newSha);
      setSavedEntries(entries);
      setSavedBody(body);
      toast({ title: t("common.saved") });
    } catch (err) {
      toast({ title: t("common.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const readonlyEntries = entries.filter((entry) => READONLY_KEYS.has(entry.key));
  const editableEntries = entries.filter((entry) => !READONLY_KEYS.has(entry.key) && entry.key !== "ghostwriter");

  function setGhostwriter(slug: string) {
    setEntries((prev) => {
      const without = prev.filter((e) => e.key !== "ghostwriter");
      return slug ? [...without, { key: "ghostwriter", value: slug }] : without;
    });
  }

  const currentGhostwriter = (() => {
    const value = entries.find((entry) => entry.key === "ghostwriter")?.value;
    return typeof value === "string" ? value : "";
  })();
  const paraSlug = paragraph ? paragraphSlug(paragraph.path) : null;

  async function generateScriptFromProse() {
    if (!book || !token || !structure || !chapter || !paragraph) return;
    setScriptGenLoading(true);
    try {
      const src: PipelineSource = { token, owner: book.owner, repo: book.repo, branch, settings, structure, chapter };
      const load = (p?: string) => p ? loadFileContent(token, book.owner, book.repo, p, branch).then(stripFrontmatter).catch(() => "") : Promise.resolve("");
      const prose = (await load(paragraph.draftPath)) || (await load(paragraph.path));
      if (!prose.trim()) { toast({ title: t("script.noProse") }); return; }
      const scriptText = await proseToScript(src, prose, currentGhostwriter);
      const doc = parseScript(scriptText);
      setScriptDoc(doc);
      setBody(serializeScript(doc));
      toast({ title: t("script.generated") });
    } catch (err) {
      toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
    } finally {
      setScriptGenLoading(false);
    }
  }

  async function startPipeline(mode: "toDraft" | "toFinal") {
    if (!book || !token || !structure || !chapter || !paraSlug) return;
    setPipelineMode(mode);
    setPipelineGw(currentGhostwriter);
    setPipelineOpen(true);
    await runPipeline(mode, currentGhostwriter);
  }

  async function runPipeline(mode: "toDraft" | "toFinal", gw: string) {
    if (!book || !structure || !chapter) return;
    setPipelineLoading(true);
    try {
      const src: PipelineSource = { token, owner: book.owner, repo: book.repo, branch, settings, structure, chapter };
      const text = mode === "toDraft" ? await scriptToProse(src, body, gw) : await refineProse(src, body, gw);
      setPipelineText(text);
    } catch (err) {
      toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
    } finally {
      setPipelineLoading(false);
    }
  }

  async function applyPipeline() {
    if (!book || !chapter || !paraSlug) return;
    const targetPath = pipelineMode === "toDraft"
      ? `${chapter.path}/drafts/${paraSlug}.md`
      : `${chapter.path}/${paraSlug}.md`;
    const number = Number(paraSlug.match(/^(\d{3})/)?.[1] ?? "1");
    const titleText = (entries.find((e) => e.key === "title")?.value as string) || paraSlug;
    const fm: Record<string, unknown> = pipelineMode === "toDraft"
      ? { type: "paragraph-draft", id: `draft:paragraph:${chapter.slug}:${paraSlug}`, paragraph: `paragraph:${chapter.slug}:${paraSlug}`, chapter: `chapter:${chapter.slug}`, number, title: titleText, canon: "draft" }
      : { type: "paragraph", id: `paragraph:${chapter.slug}:${paraSlug}`, chapter: `chapter:${chapter.slug}`, number, title: titleText };
    if (pipelineGw) fm.ghostwriter = pipelineGw;
    const content = `---\n${stringify(fm).trim()}\n---\n\n${pipelineText.trim()}\n`;
    try {
      await createOrUpdateTextFile(token, book.owner, book.repo, branch, targetPath, content, `Generate ${targetPath}`);
      toast({ title: t("pipeline.created", { path: targetPath }) });
      setPipelineOpen(false);
      reload();
    } catch (err) {
      toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to={backHref}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("common.back")}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">{branch}</Badge>
          {paragraph && (
            <>
              <Button asChild size="sm" variant="ghost">
                <Link to={`/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraph.number}`}><FileText className="mr-1 h-4 w-4" />{t("stageIndex.final")}</Link>
              </Button>
              {workspaceKind === "script" && (
                <Button asChild size="sm" variant="ghost">
                  <Link to={`/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraph.number}/workspace/draft`}><FileEdit className="mr-1 h-4 w-4" />{t("chapter.draft")}</Link>
                </Button>
              )}
              {workspaceKind === "draft" && (
                <Button asChild size="sm" variant="ghost">
                  <Link to={`/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraph.number}/workspace/script`}><Network className="mr-1 h-4 w-4" />{t("chapter.script")}</Link>
                </Button>
              )}
            </>
          )}
          {paraSlug && workspaceKind === "script" && (
            <Button size="sm" variant="outline" onClick={() => void startPipeline("toDraft")}><Wand2 className="mr-1 h-4 w-4" />{t("pipeline.scriptToDraft")}</Button>
          )}
          {paraSlug && workspaceKind === "draft" && (
            <>
              <Button size="sm" variant="outline" onClick={() => void startPipeline("toFinal")}><Wand2 className="mr-1 h-4 w-4" />{t("pipeline.draftToFinal")}</Button>
            </>
          )}
          {isDirty && !saving && <span className="text-xs text-muted-foreground">{t("common.unsaved")}</span>}
          <Button size="sm" onClick={() => void handleSave()} disabled={!isDirty || saving}>
            <Save className="mr-1 h-4 w-4" />
            {t("common.save")}
          </Button>
        </div>
      </div>

      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-xs text-muted-foreground">{path}</p>
      </div>

      <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-2 text-sm">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{t("common.metadata")}</p>
        {loading ? (
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <>
            {readonlyEntries.map((entry) => (
              <div key={entry.key} className="flex items-start gap-3">
                <span className="mt-0.5 w-24 shrink-0 font-mono text-[11px] text-muted-foreground flex items-center gap-1">
                  <Lock className="h-2.5 w-2.5" />
                  {entry.key}
                </span>
                <span className="font-mono text-xs text-muted-foreground break-all">
                  {Array.isArray(entry.value) ? entry.value.join(", ") || "[]" : entry.value}
                </span>
              </div>
            ))}

            {paraSlug && (workspaceKind === "script" || workspaceKind === "draft") && (
              <GhostwriterField ghostwriters={structure?.ghostwriters ?? []} value={currentGhostwriter} onChange={setGhostwriter} />
            )}

            {editableEntries.map((entry) => (
              <div key={entry.key} className="flex items-center gap-3">
                <span className="w-24 shrink-0 font-mono text-[11px]">{entry.key}</span>
                <Input
                  value={Array.isArray(entry.value) ? entry.value.join(", ") : entry.value}
                  onChange={(event) => {
                    const raw = event.target.value;
                    const isArray = Array.isArray(entry.value);
                    setEntryValue(
                      entry.key,
                      isArray ? raw.split(",").map((part) => part.trim()).filter(Boolean) : raw,
                    );
                  }}
                  className="h-8 flex-1 text-xs font-mono"
                />
                <button
                  onClick={() => removeEntry(entry.key)}
                  className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  aria-label={t("canon.removeAria", { key: entry.key })}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}

            {showAddMeta ? (
              <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center">
                <Input
                  autoFocus
                  placeholder={t("common.keyPlaceholder")}
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  className="h-8 w-full text-xs font-mono sm:w-32"
                />
                <Input
                  placeholder={t("common.valuePlaceholder")}
                  value={newVal}
                  onChange={(e) => setNewVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addEntry();
                    if (e.key === "Escape") {
                      setShowAddMeta(false);
                      setNewKey("");
                      setNewVal("");
                    }
                  }}
                  className="h-8 flex-1 text-xs font-mono"
                />
                <Button size="sm" className="h-8" onClick={addEntry} disabled={!newKey.trim()}>
                  {t("common.add")}
                </Button>
              </div>
            ) : (
              <button
                onClick={() => setShowAddMeta(true)}
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Plus className="h-3 w-3" />
                {t("common.addField")}
              </button>
            )}
          </>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-4" style={{ width: `${70 + (i % 3) * 10}%` }} />
          ))}
        </div>
      ) : workspaceKind === "script" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void generateScriptFromProse()} disabled={scriptGenLoading}>
              {scriptGenLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1 h-4 w-4" />}
              {t("script.generateFromProse")}
            </Button>
            <span className="text-xs text-muted-foreground">{t("script.generateHint")}</span>
          </div>
          <ScriptEditor doc={scriptDoc} structure={structure ?? undefined} bookId={bookId} onChange={(next) => { setScriptDoc(next); setBody(serializeScript(next)); }} />
        </div>
      ) : (
        <AutoTextarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[55vh] font-mono text-sm leading-7"
          placeholder={t("workspace.writeBodyPlaceholder")}
          spellCheck={false}
        />
      )}
      <GeneratePreviewDialog
        open={pipelineOpen}
        title={pipelineMode === "toDraft" ? t("pipeline.scriptToDraft") : t("pipeline.draftToFinal")}
        description={pipelineMode === "toDraft" ? t("pipeline.scriptToDraftDesc") : t("pipeline.draftToFinalDesc")}
        text={pipelineText}
        loading={pipelineLoading}
        ghostwriters={structure?.ghostwriters ?? []}
        ghostwriter={pipelineGw}
        onGhostwriter={(slug) => { setPipelineGw(slug); }}
        onRegenerate={() => void runPipeline(pipelineMode, pipelineGw)}
        onChange={setPipelineText}
        onConfirm={() => void applyPipeline()}
        onCancel={() => setPipelineOpen(false)}
      />
    </div>
  );
}

function resolveWorkspacePath(
  chapter: { slug: string; draftPath?: string } | undefined,
  paragraph:
    | {
        path: string;
        draftPath?: string;
      }
    | undefined,
  kind: string | undefined,
  expectsParagraph: boolean,
): { path: string; titleKey: string; titleParams: Record<string, string> } | null {
  if (!chapter || !kind) return null;
  if (expectsParagraph && !paragraph) return null;
  if (!paragraph) {
    if (kind === "draft" && chapter.draftPath) {
      return { path: chapter.draftPath, titleKey: "workspace.chapterDraft", titleParams: { slug: chapter.slug } };
    }
    if (kind === "resume") {
      return { path: `resumes/chapters/${chapter.slug}.md`, titleKey: "workspace.chapterResume", titleParams: { slug: chapter.slug } };
    }
    if (kind === "evaluation") {
      return { path: `evaluations/chapters/${chapter.slug}.md`, titleKey: "workspace.chapterEvaluation", titleParams: { slug: chapter.slug } };
    }
    return null;
  }

  const slug = paragraphSlug(paragraph.path);
  if (kind === "draft" && paragraph.draftPath) {
    return { path: paragraph.draftPath, titleKey: "workspace.paragraphDraft", titleParams: { slug } };
  }
  if (kind === "script") {
    return { path: `scripts/${chapter.slug}/${slug}.md`, titleKey: "workspace.script", titleParams: { slug } };
  }
  if (kind === "evaluation") {
    return { path: `evaluations/paragraphs/${chapter.slug}/${slug}.md`, titleKey: "workspace.paragraphEvaluation", titleParams: { slug } };
  }
  return null;
}

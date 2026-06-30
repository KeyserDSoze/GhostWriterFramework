import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { parseDocument, stringify } from "yaml";
import { ArrowLeft, Save, Loader2, Plus, X, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { FileDiff } from "@/components/diff/DiffView";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useToast } from "@/components/ui/use-toast";
import {
  readFileWithSha,
  updateFile,
  renameAndUpdateFile,
  slugToTitle,
} from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { resolveBookToken } from "@/types/settings";
import { useBookStructure } from "@/hooks/useBookStructure";
import { GhostwriterField } from "@/components/book/GhostwriterField";
import { improveProse, synonymsFor, type PipelineSource } from "@/narrarium/pipeline";
import { useRegisterProseEditor } from "@/components/editor/useRegisterProseEditor";
import { useRegisterPageSave } from "@/store/saveStore";

// ─── Frontmatter parsing ──────────────────────────────────────────────────────

interface MetaEntry {
  key: string;
  value: string | string[];
}

const READONLY_KEYS = new Set(["type", "id", "number"]);

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

/** Title string → URL-safe slug (strips non-ASCII, collapses spaces/hyphens). */
function titleToSlug(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents
    .toLowerCase()
    .replace(/['']/g, "")            // remove apostrophes
    .replace(/[^a-z0-9]+/g, "-")    // non-alphanumeric → hyphen
    .replace(/^-|-$/g, "");          // trim
}

/** Split selection into leading whitespace, core, trailing whitespace so a replacement keeps surrounding spaces. */
function splitEdges(text: string): { lead: string; core: string; trail: string } {
  const lead = text.match(/^\s*/)?.[0] ?? "";
  const trail = text.match(/\s*$/)?.[0] ?? "";
  const core = text.slice(lead.length, text.length - trail.length);
  return { lead, core, trail };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ParagraphPage() {
  const { bookId, chapterId, paragraphNum } = useParams<{
    bookId: string;
    chapterId: string;
    paragraphNum: string;
  }>();
  const { toast } = useToast();
  const { t } = useTranslation();

  const { settings } = useSettingsStore();
  const { updateChapterParagraphs } = useBooksStore();
  const { book, structure, loading: structureLoading, error: structureError, reload } = useBookStructure(bookId);
  const { branch } = useWorkingBranch(bookId);

  const chapter = structure?.chapters.find((c) => c.slug === chapterId);
  const paragraph = chapter?.paragraphs.find((p) => p.number === paragraphNum);

  const token = book ? resolveBookToken(book, settings) : "";

  // ── Content state ─────────────────────────────────────────────────────────
  const [entries, setEntries] = useState<MetaEntry[]>([]);
  const [body, setBody] = useState("");
  const [sha, setSha] = useState("");

  // Snapshots for dirty detection
  const [savedEntries, setSavedEntries] = useState<MetaEntry[]>([]);
  const [savedBody, setSavedBody] = useState("");

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadedTargetRef = useRef<string | null>(null);

  // Add-field form
  const [showAddMeta, setShowAddMeta] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");

  // Improve
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const [improveOpen, setImproveOpen] = useState(false);
  const [improveLoading, setImproveLoading] = useState(false);
  const [improveNew, setImproveNew] = useState("");
  const [improveSelection, setImproveSelection] = useState<string | null>(null);

  // Synonyms
  const [synonymOpen, setSynonymOpen] = useState(false);
  const [synonymLoading, setSynonymLoading] = useState(false);
  const [synonymWord, setSynonymWord] = useState("");
  const [synonymOptions, setSynonymOptions] = useState<string[]>([]);
  const [synonymSeen, setSynonymSeen] = useState<string[]>([]);

  const proseHandlersRef = useRef<{ improve: (s: string | null) => void; synonym: (s: string) => void }>({ improve: () => undefined, synonym: () => undefined });
  useRegisterProseEditor(bodyRef, {
    improve: (s) => proseHandlersRef.current.improve(s),
    synonym: (s) => proseHandlersRef.current.synonym(s),
  });

  const isDirty =
    body !== savedBody ||
    JSON.stringify(entries) !== JSON.stringify(savedEntries);

  useRegisterPageSave({ dirty: isDirty, enabled: Boolean(paragraph && book), onSave: () => handleSave() });

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const targetKey = paragraph && book ? `${branch}:${paragraph.path}` : null;
    if (!paragraph || !book || !targetKey || loadedTargetRef.current === targetKey) return;
    loadedTargetRef.current = targetKey;
    setLoading(true);

    readFileWithSha(token, book.owner, book.repo, branch, paragraph.path)
      .then(({ content: text, sha: fileSha }) => {
        const { entries: e, body: b } = parseFrontmatter(text);
        setEntries(e);
        setBody(b);
        setSavedEntries(e);
        setSavedBody(b);
        setSha(fileSha);
      })
      .catch((err) => {
        loadedTargetRef.current = null;
        toast({ title: t("paragraph.loadFailed"), description: String(err), variant: "destructive" });
      })
      .finally(() => setLoading(false));
  }, [paragraph, book, token, branch, toast, t]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const titleEntry = entries.find((e) => e.key === "title");
  const titleValue = typeof titleEntry?.value === "string" ? titleEntry.value : "";

  function setEntryValue(key: string, value: string | string[]) {
    setEntries((prev) =>
      prev.map((e) => (e.key === key ? { ...e, value } : e)),
    );
  }

  function removeEntry(key: string) {
    setEntries((prev) => prev.filter((e) => e.key !== key));
  }

  function setGhostwriter(slug: string) {
    setEntries((prev) => {
      const without = prev.filter((e) => e.key !== "ghostwriter");
      return slug ? [...without, { key: "ghostwriter", value: slug }] : without;
    });
  }

  function addEntry() {
    const k = newKey.trim().toLowerCase().replace(/\s+/g, "-");
    if (!k || entries.some((e) => e.key === k)) return;
    const v = newVal.trim();
    // Detect array syntax: comma-separated or starts with [
    const isArray = v.startsWith("[") || v.includes(",");
    const value: string | string[] = isArray
      ? v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean)
      : v;
    setEntries((prev) => [...prev, { key: k, value }]);
    setNewKey("");
    setNewVal("");
    setShowAddMeta(false);
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!paragraph || !book || !isDirty) return;
    setSaving(true);
    try {
      const currentTitle = titleValue;
      const newSlug = titleToSlug(currentTitle);
      const oldFilename = paragraph.path.split("/").pop()!;
      const oldSlug = oldFilename.match(/^\d{3}-(.+)\.md$/)?.[1] ?? "";
      const slotNum = paragraph.number;

      const needsRename = newSlug && oldSlug && newSlug !== oldSlug;
      const newFilename = `${slotNum}-${newSlug}.md`;
      const newPath = needsRename
        ? `${paragraph.path.replace(/[^/]+$/, "")}${newFilename}`
        : paragraph.path;

      // Auto-update id if slug changes
      let finalEntries = entries;
      if (needsRename) {
        const chapterSlug = chapterId ?? "";
        const newId = `paragraph:${chapterSlug}:${slotNum}-${newSlug}`;
        finalEntries = entries.map((e) =>
          e.key === "id" ? { ...e, value: newId } : e,
        );
        setEntries(finalEntries);
      }

      const rawContent = buildFrontmatter(finalEntries, body);

      let newSha: string;
      if (needsRename) {
        const result = await renameAndUpdateFile(
          token,
          book.owner,
          book.repo,
          branch,
          paragraph.path,
          newPath,
          rawContent,
          `Rename paragraph ${slotNum}: ${currentTitle}`,
        );
        newSha = result.sha;

        // Update chapter paragraphs in store
        const updatedParagraphs =
          chapter!.paragraphs.map((p) =>
            p.number === slotNum
              ? {
                  ...p,
                  path: newPath,
                  title: slugToTitle(`${slotNum}-${newSlug}`),
                  draftPath: p.draftPath?.replace(oldFilename, newFilename),
                }
              : p,
          );
        updateChapterParagraphs(bookId!, chapterId!, updatedParagraphs);
      } else {
        newSha = await updateFile(
          token,
          book.owner,
          book.repo,
          branch,
          paragraph.path,
          sha,
          rawContent,
          `Update paragraph ${slotNum}: ${currentTitle}`,
        );
      }

      setSha(newSha);
      setSavedEntries(finalEntries);
      setSavedBody(body);
      toast({ title: t("common.saved") });
    } catch (err) {
      toast({ title: t("common.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── Guards ────────────────────────────────────────────────────────────────
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
        <Loader2 className="h-6 w-6 animate-spin" />
        <p className="text-sm">{t("common.loading")}</p>
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
  if (!chapter || !paragraph) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {t("paragraph.notFound")}{" "}
          <Link to={`/app/books/${bookId}/chapters/${chapterId}`} className="underline">
            {t("paragraph.backToChapter")}
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  // Separate entries by role
  const currentGhostwriter = (() => {
    const v = entries.find((e) => e.key === "ghostwriter")?.value;
    return typeof v === "string" ? v : "";
  })();

  async function startImprove() {
    if (!book || !token || !structure || !chapter) return;
    const node = bodyRef.current;
    let selection: string | null = null;
    if (node && node.selectionEnd > node.selectionStart) {
      selectionRef.current = { start: node.selectionStart, end: node.selectionEnd };
      selection = body.slice(node.selectionStart, node.selectionEnd);
    } else {
      selectionRef.current = null;
    }
    setImproveSelection(selection);
    setImproveNew("");
    setImproveOpen(true);
    setImproveLoading(true);
    try {
      const src: PipelineSource = { token, owner: book.owner, repo: book.repo, branch, settings, structure, chapter };
      setImproveNew(await improveProse(src, body, selection, currentGhostwriter));
    } catch (err) {
      toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
      setImproveOpen(false);
    } finally {
      setImproveLoading(false);
    }
  }

  function applyImprove() {
    if (improveSelection && selectionRef.current) {
      const { start, end } = selectionRef.current;
      const { lead, trail } = splitEdges(body.slice(start, end));
      setBody(body.slice(0, start) + lead + improveNew.trim() + trail + body.slice(end));
    } else {
      setBody(improveNew);
    }
    setImproveOpen(false);
  }

  async function regenerateImprove() {
    if (!book || !token || !structure || !chapter) return;
    setImproveNew("");
    setImproveLoading(true);
    try {
      const src: PipelineSource = { token, owner: book.owner, repo: book.repo, branch, settings, structure, chapter };
      setImproveNew(await improveProse(src, body, improveSelection, currentGhostwriter));
    } catch (err) {
      toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
    } finally {
      setImproveLoading(false);
    }
  }

  function captureSelectionRef() {
    const node = bodyRef.current;
    if (node && node.selectionEnd > node.selectionStart) {
      selectionRef.current = { start: node.selectionStart, end: node.selectionEnd };
      return body.slice(node.selectionStart, node.selectionEnd);
    }
    selectionRef.current = null;
    return null;
  }

  async function openSynonyms(selection: string) {
    if (!book || !token || !structure || !chapter || !selection.trim()) return;
    captureSelectionRef();
    const word = splitEdges(selection).core;
    setSynonymWord(word);
    setSynonymOptions([]);
    setSynonymSeen([]);
    setSynonymOpen(true);
    await loadSynonyms([], word);
  }

  async function loadSynonyms(exclude: string[], word?: string) {
    if (!book || !token || !structure || !chapter) return;
    const target = word ?? synonymWord;
    if (!target) return;
    setSynonymLoading(true);
    try {
      const src: PipelineSource = { token, owner: book.owner, repo: book.repo, branch, settings, structure, chapter };
      const options = await synonymsFor(src, body, target, { count: 3, exclude, ghostwriterSlug: currentGhostwriter });
      setSynonymOptions(options);
      setSynonymSeen((prev) => [...prev, ...options]);
    } catch (err) {
      toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
    } finally {
      setSynonymLoading(false);
    }
  }

  function applySynonym(word: string) {
    if (selectionRef.current) {
      const { start, end } = selectionRef.current;
      const { lead, trail } = splitEdges(body.slice(start, end));
      setBody(body.slice(0, start) + lead + word + trail + body.slice(end));
    }
    setSynonymOpen(false);
  }

  const readonlyEntries = entries.filter((e) => READONLY_KEYS.has(e.key));
  proseHandlersRef.current = { improve: () => void startImprove(), synonym: (s) => void openSynonyms(s) };
  const editableEntries = entries.filter(
    (e) => !READONLY_KEYS.has(e.key) && e.key !== "title" && e.key !== "ghostwriter",
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to={`/app/books/${bookId}/chapters/${chapterId}`}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            {chapter.title}
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            {branch}
          </Badge>
          {isDirty && !saving && (
            <span className="text-xs text-muted-foreground">{t("common.unsaved")}</span>
          )}
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={!isDirty || saving}
          >
            {saving ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-1 h-4 w-4" />
            )}
            {t("common.save")}
          </Button>
        </div>
      </div>

      {/* Metadata section */}
      <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-2 text-sm">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {t("common.metadata")}
        </p>

        {loading ? (
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <>
            {/* Read-only fields */}
            {readonlyEntries.map((e) => (
              <div key={e.key} className="flex items-start gap-3">
                <span className="mt-0.5 w-20 shrink-0 font-mono text-[11px] text-muted-foreground flex items-center gap-1">
                  <Lock className="h-2.5 w-2.5" />
                  {e.key}
                </span>
                <span className="font-mono text-xs text-muted-foreground break-all">
                  {Array.isArray(e.value) ? e.value.join(", ") || "[]" : e.value}
                </span>
              </div>
            ))}

            {/* Title (editable) */}
            <div className="flex items-center gap-3">
              <span className="w-20 shrink-0 font-mono text-[11px] font-medium">
                {t("paragraph.titleField")}
              </span>
              <Input
                value={titleValue}
                onChange={(ev) => setEntryValue("title", ev.target.value)}
                className="h-7 flex-1 text-sm font-medium"
              />
            </div>

            {/* Ghostwriter */}
            <GhostwriterField ghostwriters={structure?.ghostwriters ?? []} value={currentGhostwriter} onChange={setGhostwriter} />

            {/* Other editable fields */}
            {editableEntries.map((e) => (
              <div key={e.key} className="flex items-center gap-3">
                <span className="w-20 shrink-0 font-mono text-[11px]">{e.key}</span>
                <Input
                  value={
                    Array.isArray(e.value) ? e.value.join(", ") : e.value
                  }
                  onChange={(ev) => {
                    const raw = ev.target.value;
                    const isArray = Array.isArray(e.value);
                    setEntryValue(
                      e.key,
                      isArray
                        ? raw.split(",").map((s) => s.trim()).filter(Boolean)
                        : raw,
                    );
                  }}
                  className="h-7 flex-1 text-xs font-mono"
                />
                <button
                  onClick={() => removeEntry(e.key)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  aria-label={t("canon.removeAria", { key: e.key })}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}

            {/* Add field */}
            {showAddMeta ? (
              <div className="flex items-center gap-2 pt-1">
                <Input
                  autoFocus
                  placeholder={t("common.keyPlaceholder")}
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  className="h-7 w-28 text-xs font-mono"
                />
                <Input
                  placeholder={t("common.valuePlaceholder")}
                  value={newVal}
                  onChange={(e) => setNewVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addEntry();
                    if (e.key === "Escape") { setShowAddMeta(false); setNewKey(""); setNewVal(""); }
                  }}
                  className="h-7 flex-1 text-xs font-mono"
                />
                <Button size="sm" className="h-7" onClick={addEntry} disabled={!newKey.trim()}>
                  {t("common.add")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => { setShowAddMeta(false); setNewKey(""); setNewVal(""); }}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            ) : (
              <button
                onClick={() => setShowAddMeta(true)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus className="h-3 w-3" />
                {t("common.addField")}
              </button>
            )}
          </>
        )}
      </div>

      {/* Prose editor */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-4" style={{ width: `${70 + (i % 3) * 10}%` }} />
          ))}
        </div>
      ) : (
        <AutoTextarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[55vh] font-mono text-sm leading-7"
          placeholder={t("paragraph.writePlaceholder")}
          spellCheck={false}
        />
      )}

      <p className="text-[11px] text-muted-foreground truncate">{paragraph.path}</p>

      <Dialog open={improveOpen} onOpenChange={(next) => { if (!next) setImproveOpen(false); }}>
        <DialogContent className="left-1/2 top-1/2 flex h-[88dvh] max-h-[88dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 flex-col p-0 sm:w-[820px]">
          <div className="border-b px-4 py-3">
            <p className="font-semibold">{improveSelection ? t("paragraph.improveSelection") : t("paragraph.improveAll")}</p>
            <p className="text-xs text-muted-foreground">{currentGhostwriter ? t("paragraph.improveWith", { name: currentGhostwriter }) : t("pipeline.defaultStyle")}</p>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {improveLoading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("pipeline.generating")}</div>
            ) : (
              <FileDiff previous={improveSelection ?? body} next={improveNew} />
            )}
          </div>
          <div className="flex justify-end gap-2 border-t px-4 py-3">
            <Button variant="ghost" onClick={() => setImproveOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="outline" onClick={() => void regenerateImprove()} disabled={improveLoading}>{t("pipeline.regenerate")}</Button>
            <Button onClick={applyImprove} disabled={improveLoading || !improveNew.trim()}>{t("pipeline.apply")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={synonymOpen} onOpenChange={(next) => { if (!next) setSynonymOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <div className="space-y-3">
            <div>
              <p className="font-semibold">{t("ctx.synonym")}</p>
              <p className="text-xs text-muted-foreground">{t("ctx.synonymFor", { word: synonymWord })}</p>
            </div>
            {synonymLoading && synonymOptions.length === 0 ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("pipeline.generating")}</div>
            ) : (
              <div className="flex flex-col gap-2">
                {synonymOptions.map((option) => (
                  <button key={option} type="button" onClick={() => applySynonym(option)} className="rounded-lg border px-3 py-2 text-left text-sm hover:bg-accent">
                    {option}
                  </button>
                ))}
                {synonymOptions.length === 0 && <p className="text-sm text-muted-foreground">{t("ctx.noSynonyms")}</p>}
              </div>
            )}
            <div className="flex justify-between gap-2">
              <Button variant="outline" size="sm" onClick={() => void loadSynonyms(synonymSeen)} disabled={synonymLoading}>{synonymLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}{t("ctx.moreSynonyms")}</Button>
              <Button variant="ghost" size="sm" onClick={() => setSynonymOpen(false)}>{t("common.cancel")}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

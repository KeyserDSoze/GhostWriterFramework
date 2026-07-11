import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation, useNavigate, useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { parseDocument, stringify } from "yaml";
import { ArrowLeft, ArrowLeftRight, BookOpen, FileEdit, Save, Loader2, MoreHorizontal, Plus, ShieldAlert, X, Lock, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FileDiff } from "@/components/diff/DiffView";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useToast } from "@/components/ui/use-toast";
import {
  readFileWithSha,
  updateFile,
  renameParagraphWithCompanions,
  loadFileContent,
} from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { resolveBookExportSettings, resolveBookToken, type ReaderSettings } from "@/types/settings";
import { useBookStructure } from "@/hooks/useBookStructure";
import { GhostwriterField } from "@/components/book/GhostwriterField";
import { improveProse, synonymsFor, stripFrontmatter, type PipelineSource } from "@/narrarium/pipeline";
import { useRegisterProseEditor } from "@/components/editor/useRegisterProseEditor";
import { useMergeDraftFinal } from "@/components/editor/useMergeDraftFinal";
import { useRegisterPageSave } from "@/store/saveStore";
import { useRegisterPageActions } from "@/store/pageActionsStore";
import { switchDraftAndFinal } from "@/narrarium/switchDraftFinal";
import { presentMetadata } from "@/export/metadataPresentation";

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
  return { entries, body: match[2].replace(/^\s*\n/, "") };
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

function readerFontFamily(value: ReaderSettings["fontFamily"]): string {
  if (value === "sans") return "ui-sans-serif, system-ui, sans-serif";
  if (value === "mono") return "ui-monospace, SFMono-Regular, Menlo, monospace";
  return "Georgia, Cambria, Times New Roman, serif";
}

function normalizeReaderLineBreaks(markdown: string, mode: ReaderSettings["lineBreakMode"]): string {
  if (mode === "source") return markdown.trim();
  const blocks = markdown.replace(/\r\n/g, "\n").split(/\n\s*\n+/);
  const output: string[] = [];
  const prose: string[] = [];
  const flush = () => {
    const text = prose.join(" ").replace(/\s+/g, " ").trim();
    if (text) output.push(text);
    prose.length = 0;
  };
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (/^(#{1,6}\s+|```|~~~|>\s+|[-*+ ]\s+|\d+\.\s+|---+$|\*\*\*+$)/m.test(trimmed)) {
      flush();
      output.push(trimmed);
      continue;
    }
    const compact = trimmed.split("\n").map((line) => line.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (mode === "dialogue" && /^[«“"—–]/.test(compact)) {
      flush();
      output.push(compact);
    } else if (compact) prose.push(compact);
  }
  flush();
  return output.join("\n\n").trim();
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
  const navigate = useNavigate();
  const location = useLocation();

  const { settings } = useSettingsStore();
  const { updateChapterParagraphs } = useBooksStore();
  const { book, structure, loading: structureLoading, error: structureError, reload } = useBookStructure(bookId);
  const { branch } = useWorkingBranch(bookId);

  const chapter = structure?.chapters.find((c) => c.slug === chapterId);
  const paragraph = chapter?.paragraphs.find((p) => p.number === paragraphNum);

  const token = book ? resolveBookToken(book, settings) : "";
  const presentationSettings = useMemo(() => (book ? resolveBookExportSettings(book) : null), [book]);
  const auditHref = `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraphNum}/audit`;
  const auditActionHref = paragraph?.auditPath ? auditHref : `${auditHref}?action=run`;

  // ── Content state ─────────────────────────────────────────────────────────
  const [entries, setEntries] = useState<MetaEntry[]>([]);
  const [body, setBody] = useState("");
  const [sha, setSha] = useState("");

  // Snapshots for dirty detection
  const [savedEntries, setSavedEntries] = useState<MetaEntry[]>([]);
  const [savedBody, setSavedBody] = useState("");

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [switchingDraft, setSwitchingDraft] = useState(false);
  const [viewMode, setViewMode] = useState<"reader" | "edit">("reader");
  const [readerHtml, setReaderHtml] = useState("");
  const [readerLoading, setReaderLoading] = useState(false);
  const [switchConfirmOpen, setSwitchConfirmOpen] = useState(false);
  const loadedTargetRef = useRef<string | null>(null);
  const auditNavigationHandledRef = useRef("");

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

  const proseHandlersRef = useRef<{ improve: (s: string | null) => void; synonym: (s: string) => void; merge: () => void }>({ improve: () => undefined, synonym: () => undefined, merge: () => undefined });
  useRegisterProseEditor(bodyRef, {
    improve: (s) => proseHandlersRef.current.improve(s),
    synonym: (s) => proseHandlersRef.current.synonym(s),
    merge: () => proseHandlersRef.current.merge(),
  }, [viewMode]);

  // ── Merge draft + final (hooks must stay above the early returns) ────────────
  const currentGhostwriter = (() => {
    const v = entries.find((e) => e.key === "ghostwriter")?.value;
    return typeof v === "string" ? v : "";
  })();
  const draftBodyRef = useRef("");
  const draftPath = paragraph?.draftPath ?? (chapter && paragraph ? `${chapter.path}/drafts/${(paragraph.path.split("/").pop() ?? "").replace(/\.md$/i, "")}.md` : "");
  const merge = useMergeDraftFinal({
    buildSource: () => (book && structure && chapter ? { token, owner: book.owner, repo: book.repo, branch, settings, structure, chapter } : null),
    getDraftBody: () => draftBodyRef.current,
    getFinalBody: () => body,
    getFinalFrontmatter: () => buildFrontmatter(entries, "").replace(/\n*$/, "\n"),
    draftPath,
    finalPath: paragraph?.path ?? "",
    ghostwriterSlug: currentGhostwriter || undefined,
    onApplied: (side, mergedBody) => {
      if (side === "final") {
        setBody(mergedBody);
        setSavedBody(mergedBody);
        loadedTargetRef.current = null;
      }
      void reload();
    },
  });

  async function runMerge() {
    if (!book || !token) return;
    let draftBody = "";
    if (draftPath) {
      try {
        draftBody = stripFrontmatter(await loadFileContent(token, book.owner, book.repo, draftPath, branch));
      } catch {
        draftBody = "";
      }
    }
    draftBodyRef.current = draftBody;
    await merge.run();
  }

  const isDirty =
    body !== savedBody ||
    JSON.stringify(entries) !== JSON.stringify(savedEntries);

  useRegisterPageSave({ dirty: isDirty, enabled: Boolean(paragraph && book), onSave: async () => { await handleSave(); } });
  useRegisterPageActions([
    { id: "improve-paragraph", label: t("paragraph.improveAll"), icon: <Wand2 className="h-4 w-4" />, run: () => void startImprove() },
    { id: "merge-draft-final", label: t("merge.button"), icon: <Wand2 className="h-4 w-4" />, run: () => void runMerge(), disabled: merge.busy },
    { id: paragraph?.auditPath ? "open-audit" : "run-audit", label: t(paragraph?.auditPath ? "audit.actions.open" : "audit.actions.run"), icon: <ShieldAlert className="h-4 w-4" />, run: () => navigate(auditActionHref) },
  ], Boolean(paragraph && book && token));

  useEffect(() => {
    if (viewMode !== "reader") return;
    let active = true;
    setReaderLoading(true);
    void import("marked")
      .then(({ marked }) => {
        if (!active) return;
        const normalized = normalizeReaderLineBreaks(body, settings.reader.lineBreakMode);
        setReaderHtml(marked.parse(normalized, { async: false }) as string);
      })
      .finally(() => { if (active) setReaderLoading(false); });
    return () => { active = false; };
  }, [body, settings.reader.lineBreakMode, viewMode]);

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

  useEffect(() => {
    const navigationState = location.state as { auditTextOffset?: number; auditExcerpt?: string } | null;
    if (!navigationState || loading || !paragraph) return;
    const operationKey = `${location.key}:${paragraph.path}:${navigationState.auditTextOffset ?? ""}:${navigationState.auditExcerpt ?? ""}`;
    if (auditNavigationHandledRef.current === operationKey) return;
    auditNavigationHandledRef.current = operationKey;
    const excerpt = navigationState.auditExcerpt?.trim() ?? "";
    let start = typeof navigationState.auditTextOffset === "number"
      ? Math.max(0, Math.min(body.length, Math.floor(navigationState.auditTextOffset)))
      : -1;
    if (excerpt && (start < 0 || body.slice(start, start + excerpt.length) !== excerpt)) start = body.indexOf(excerpt);
    if (start < 0) start = 0;
    const end = excerpt ? Math.min(body.length, start + excerpt.length) : start;
    setViewMode("edit");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const node = bodyRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(start, end);
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      navigate(location.pathname, { replace: true, state: null });
    }));
  }, [body, loading, location.key, location.pathname, location.state, navigate, paragraph]);

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

  async function reloadCurrentParagraphFile() {
    if (!paragraph || !book) return;
    setLoading(true);
    try {
      const { content: text, sha: fileSha } = await readFileWithSha(token, book.owner, book.repo, branch, paragraph.path);
      const { entries: e, body: b } = parseFrontmatter(text);
      const targetKey = `${branch}:${paragraph.path}`;
      loadedTargetRef.current = targetKey;
      setEntries(e);
      setBody(b);
      setSavedEntries(e);
      setSavedBody(b);
      setSha(fileSha);
    } catch (err) {
      loadedTargetRef.current = null;
      toast({ title: t("paragraph.loadFailed"), description: String(err), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  function switchResultMessage(action: string, reason?: string) {
    if (action === "swapped") return t("paragraph.switchDoneSwapped");
    if (action === "promoted-to-draft") return t("paragraph.switchDoneToDraft");
    if (action === "promoted-to-final") return t("paragraph.switchDoneToFinal");
    if (reason === "source-empty") return t("paragraph.switchSourceEmpty");
    return t("paragraph.switchBothEmpty");
  }

  async function handleSwitchToDraft() {
    if (!book || !chapter || !paragraph) return;
    if (isDirty) {
      toast({ title: t("paragraph.saveBeforeSwitch") });
      return;
    }
    if (!window.confirm(t("paragraph.switchToDraftConfirm"))) return;
    setSwitchingDraft(true);
    try {
      const outcome = await switchDraftAndFinal({
        token,
        owner: book.owner,
        repo: book.repo,
        branch,
        chapterSlug: chapter.slug,
        chapterPath: chapter.path,
        paragraphNumber: Number(paragraph.number),
        finalPath: paragraph.path,
        draftPath: paragraph.draftPath,
        title: titleValue || paragraph.title,
      }, "toDraft");
      toast({ title: switchResultMessage(outcome.action, "reason" in outcome ? outcome.reason : undefined) });
      await reload();
      await reloadCurrentParagraphFile();
    } catch (err) {
      toast({ title: t("paragraph.switchFailed"), description: String(err), variant: "destructive" });
    } finally {
      setSwitchingDraft(false);
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function handleSave(): Promise<boolean> {
    if (!paragraph || !book || !isDirty) return true;
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
        const updatedParagraph = await renameParagraphWithCompanions(
          token,
          book.owner,
          book.repo,
          branch,
          chapter!.path,
          paragraph,
          newPath,
          rawContent,
          `Rename paragraph ${slotNum}: ${currentTitle}`,
        );
        newSha = (await readFileWithSha(token, book.owner, book.repo, branch, updatedParagraph.path)).sha;
        loadedTargetRef.current = `${branch}:${updatedParagraph.path}`;

        // Update chapter paragraphs in store
        const updatedParagraphs =
          chapter!.paragraphs.map((p) =>
            p.path === paragraph.path ? updatedParagraph : p,
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
      return true;
    } catch (err) {
      toast({ title: t("common.saveFailed"), description: String(err), variant: "destructive" });
      return false;
    } finally {
      setSaving(false);
    }
  }

  function requestReaderMode() {
    if (viewMode === "reader") {
      setViewMode("edit");
      return;
    }
    if (isDirty) {
      setSwitchConfirmOpen(true);
      return;
    }
    setViewMode("reader");
  }

  async function switchToReaderAndSave() {
    const saved = await handleSave();
    if (!saved) return;
    setSwitchConfirmOpen(false);
    setViewMode("reader");
  }

  function switchToReaderWithoutSaving() {
    setSwitchConfirmOpen(false);
    // Reload the server version before showing reader mode, so discarded edits are not read aloud.
    void reloadCurrentParagraphFile().then(() => setViewMode("reader"));
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
  proseHandlersRef.current = { improve: () => void startImprove(), synonym: (s) => void openSynonyms(s), merge: () => void runMerge() };
  const editableEntries = entries.filter(
    (e) => !READONLY_KEYS.has(e.key) && e.key !== "title" && e.key !== "ghostwriter",
  );
  const readerFrontmatter = (() => {
    const record: Record<string, unknown> = {};
    for (const entry of entries) record[entry.key] = Array.isArray(entry.value) ? entry.value : parseScalarMetaValue(entry.value);
    return stringify(record).trim();
  })();
  const readerMetadata = presentMetadata(
    Object.fromEntries(entries.map((entry) => [entry.key, Array.isArray(entry.value) ? entry.value : parseScalarMetaValue(entry.value)])),
    presentationSettings?.metadataVisibility.paragraph ?? [],
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 min-w-0 max-w-[52vw] justify-start sm:max-w-none">
          <Link to={`/app/books/${bookId}/chapters/${chapterId}`}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            <span className="truncate">{chapter.title}</span>
          </Link>
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="outline" className="max-w-[42vw] truncate font-mono text-xs sm:max-w-none">
            {branch}
          </Badge>
          {isDirty && !saving && (
            <span className="hidden text-xs text-muted-foreground sm:inline">{t("common.unsaved")}</span>
          )}
          <Button size="sm" variant="outline" onClick={requestReaderMode} disabled={saving || loading}>
            {viewMode === "reader" ? <FileEdit className="mr-1 h-4 w-4" /> : <BookOpen className="mr-1 h-4 w-4" />}
            {viewMode === "reader" ? t("paragraph.edit") : t("paragraph.reader")}
          </Button>
          <Button className="hidden sm:inline-flex" size="sm" variant="outline" onClick={() => void runMerge()} disabled={merge.busy || saving || loading}>
            <Wand2 className="mr-1 h-4 w-4" />
            {t("merge.button")}
          </Button>
          <Button asChild className="hidden sm:inline-flex" size="sm" variant="outline">
            <Link to={auditActionHref}><ShieldAlert className="mr-1 h-4 w-4" />{t(paragraph.auditPath ? "audit.actions.open" : "audit.actions.run")}</Link>
          </Button>
          <Button className="hidden sm:inline-flex" size="sm" variant="outline" onClick={() => void handleSwitchToDraft()} disabled={switchingDraft || saving}>
            {switchingDraft ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ArrowLeftRight className="mr-1 h-4 w-4" />}
            {t("paragraph.switchToDraft")}
          </Button>
          <Button
            className="hidden sm:inline-flex"
            size="sm"
            onClick={() => void handleSave()}
            disabled={viewMode !== "edit" || !isDirty || saving}
          >
            {saving ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-1 h-4 w-4" />
            )}
            {t("common.save")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="outline" className="h-9 w-9 sm:hidden" aria-label={t("assistant.quickActions")}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void runMerge()} disabled={merge.busy || saving || loading}>
                <Wand2 className="mr-2 h-4 w-4" />
                {t("merge.button")}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to={auditActionHref}><ShieldAlert className="mr-2 h-4 w-4" />{t(paragraph.auditPath ? "audit.actions.open" : "audit.actions.run")}</Link>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleSwitchToDraft()} disabled={switchingDraft || saving}>
                {switchingDraft ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowLeftRight className="mr-2 h-4 w-4" />}
                {t("paragraph.switchToDraft")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleSave()} disabled={viewMode !== "edit" || !isDirty || saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                {t("common.save")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={requestReaderMode} disabled={saving || loading}>
                {viewMode === "reader" ? <FileEdit className="mr-2 h-4 w-4" /> : <BookOpen className="mr-2 h-4 w-4" />}
                {viewMode === "reader" ? t("paragraph.edit") : t("paragraph.reader")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {viewMode === "edit" && <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-2 text-sm">
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
      </div>}

      {viewMode === "reader" ? (
        <article
          className="reader-prose rounded-2xl border bg-card px-6 py-8 shadow-sm sm:px-10 sm:py-12"
          style={{
            padding: `${settings.reader.pageMargin}px`,
            fontFamily: readerFontFamily(settings.reader.fontFamily),
            fontSize: `${settings.reader.fontSize}px`,
            lineHeight: settings.reader.lineHeight,
          }}
        >
          {settings.reader.showFrontmatter && readerFrontmatter && <pre className="mb-8 overflow-auto rounded-xl border bg-muted/30 p-4 text-xs leading-5">{readerFrontmatter}</pre>}
          {readerMetadata.length > 0 && <div className="mb-5 whitespace-pre-wrap text-sm leading-5 text-muted-foreground">{readerMetadata.map((entry) => entry.value).join("\n")}</div>}
          {readerLoading ? (
            <div className="flex min-h-[45vh] flex-col items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />{t("paragraph.loadingReader")}</div>
          ) : readerHtml ? (
            <div className="doc-prose reader-prose max-w-none" dangerouslySetInnerHTML={{ __html: readerHtml }} />
          ) : (
            <p className="min-h-[45vh] text-muted-foreground">{t("paragraph.empty")}</p>
          )}
        </article>
      ) : loading ? (
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

      <Dialog open={switchConfirmOpen} onOpenChange={setSwitchConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t("paragraph.switchToReaderTitle")}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t("paragraph.switchToReaderDescription")}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setSwitchConfirmOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="outline" onClick={switchToReaderWithoutSaving}>{t("paragraph.discardAndReader")}</Button>
            <Button onClick={() => void switchToReaderAndSave()} disabled={saving}>{saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}{t("paragraph.saveAndReader")}</Button>
          </div>
        </DialogContent>
      </Dialog>
      {merge.dialog}
    </div>
  );
}

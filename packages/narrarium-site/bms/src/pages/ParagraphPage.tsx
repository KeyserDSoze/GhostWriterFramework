import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Save, Loader2, Plus, X, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
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

// ─── Frontmatter parsing ──────────────────────────────────────────────────────

interface MetaEntry {
  key: string;
  value: string | string[];
}

const READONLY_KEYS = new Set(["type", "id", "number"]);

function parseFrontmatter(raw: string): { entries: MetaEntry[]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { entries: [], body: raw };

  const entries: MetaEntry[] = [];
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([\w][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, val] = m;
    const trimmed = val.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const inner = trimmed.slice(1, -1).trim();
      entries.push({
        key,
        value: inner
          ? inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
          : [],
      });
    } else {
      entries.push({ key, value: trimmed });
    }
  }
  return { entries, body: match[2] };
}

function buildFrontmatter(entries: MetaEntry[], body: string): string {
  const lines = entries.map(({ key, value }) => {
    if (Array.isArray(value)) {
      const items = value.map((v) => JSON.stringify(v)).join(", ");
      return `${key}: [${items}]`;
    }
    return `${key}: ${value}`;
  });
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
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

// ─── Component ────────────────────────────────────────────────────────────────

export function ParagraphPage() {
  const { bookId, chapterId, paragraphNum } = useParams<{
    bookId: string;
    chapterId: string;
    paragraphNum: string;
  }>();
  const { toast } = useToast();

  const { settings } = useSettingsStore();
  const { structures, updateChapterParagraphs } = useBooksStore();
  const { branch } = useWorkingBranch(bookId);

  const book = settings.books.find((b) => b.id === bookId);
  const structure = bookId ? structures[bookId] : undefined;
  const chapter = structure?.chapters.find((c) => c.slug === chapterId);
  const paragraph = chapter?.paragraphs.find((p) => p.number === paragraphNum);

  const token =
    book?.tokenIndex == null
      ? settings.defaultGitHubToken
      : (settings.extraGitHubTokens[book.tokenIndex]?.token ?? "");

  // ── Content state ─────────────────────────────────────────────────────────
  const [entries, setEntries] = useState<MetaEntry[]>([]);
  const [body, setBody] = useState("");
  const [sha, setSha] = useState("");

  // Snapshots for dirty detection
  const [savedEntries, setSavedEntries] = useState<MetaEntry[]>([]);
  const [savedBody, setSavedBody] = useState("");

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadedRef = useRef(false);

  // Add-field form
  const [showAddMeta, setShowAddMeta] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");

  const isDirty =
    body !== savedBody ||
    JSON.stringify(entries) !== JSON.stringify(savedEntries);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!paragraph || !book || loadedRef.current) return;
    loadedRef.current = true;
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
      .catch((err) =>
        toast({ title: "Failed to load", description: String(err), variant: "destructive" }),
      )
      .finally(() => setLoading(false));
  }, [paragraph, book, token, branch, toast]);

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
      toast({ title: "Saved" });
    } catch (err) {
      toast({ title: "Save failed", description: String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── Guards ────────────────────────────────────────────────────────────────
  if (!book || !structure) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Book not loaded.{" "}
          <Link to={`/books/${bookId}`} className="underline">
            Load the book first.
          </Link>
        </AlertDescription>
      </Alert>
    );
  }
  if (!chapter || !paragraph) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Paragraph not found.{" "}
          <Link to={`/books/${bookId}/chapters/${chapterId}`} className="underline">
            Back to chapter.
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  // Separate entries by role
  const readonlyEntries = entries.filter((e) => READONLY_KEYS.has(e.key));
  const editableEntries = entries.filter(
    (e) => !READONLY_KEYS.has(e.key) && e.key !== "title",
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to={`/books/${bookId}/chapters/${chapterId}`}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            {chapter.title}
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            {branch}
          </Badge>
          {isDirty && !saving && (
            <span className="text-xs text-muted-foreground">Unsaved</span>
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
            Save
          </Button>
        </div>
      </div>

      {/* Metadata section */}
      <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-2 text-sm">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Metadata
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
                title
              </span>
              <Input
                value={titleValue}
                onChange={(ev) => setEntryValue("title", ev.target.value)}
                className="h-7 flex-1 text-sm font-medium"
              />
            </div>

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
                  aria-label={`Remove ${e.key}`}
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
                  placeholder="key"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  className="h-7 w-28 text-xs font-mono"
                />
                <Input
                  placeholder="value (or val1, val2 for array)"
                  value={newVal}
                  onChange={(e) => setNewVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addEntry();
                    if (e.key === "Escape") { setShowAddMeta(false); setNewKey(""); setNewVal(""); }
                  }}
                  className="h-7 flex-1 text-xs font-mono"
                />
                <Button size="sm" className="h-7" onClick={addEntry} disabled={!newKey.trim()}>
                  Add
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => { setShowAddMeta(false); setNewKey(""); setNewVal(""); }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <button
                onClick={() => setShowAddMeta(true)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus className="h-3 w-3" />
                Add field
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
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[55vh] font-mono text-sm resize-none"
          placeholder="Start writing…"
          spellCheck={false}
        />
      )}

      <p className="text-[11px] text-muted-foreground truncate">{paragraph.path}</p>
    </div>
  );
}


export function ParagraphPage() {
  const { bookId, chapterId, paragraphNum } = useParams<{
    bookId: string;
    chapterId: string;
    paragraphNum: string;
  }>();
  const { toast } = useToast();

  const { settings } = useSettingsStore();
  const { structures } = useBooksStore();

  const book = settings.books.find((b) => b.id === bookId);
  const structure = bookId ? structures[bookId] : undefined;
  const chapter = structure?.chapters.find((c) => c.slug === chapterId);
  const paragraph = chapter?.paragraphs.find((p) => p.number === paragraphNum);

  const token =
    book?.tokenIndex == null
      ? settings.defaultGitHubToken
      : (settings.extraGitHubTokens[book.tokenIndex]?.token ?? "");

  // ── File content state ────────────────────────────────────────────────────
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [sha, setSha] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadedRef = useRef(false);

  const isDirty = content !== savedContent;

  useEffect(() => {
    if (!paragraph || !book || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);

    readFileWithSha(token, book.owner, book.repo, paragraph.path)
      .then(({ content: text, sha: fileSha }) => {
        setContent(text);
        setSavedContent(text);
        setSha(fileSha);
      })
      .catch((err) => {
        toast({
          title: "Failed to load paragraph",
          description: String(err),
          variant: "destructive",
        });
      })
      .finally(() => setLoading(false));
  }, [paragraph, book, token, toast]);

  async function handleSave() {
    if (!paragraph || !book || !isDirty) return;
    setSaving(true);
    try {
      const newSha = await updateFile(
        token,
        book.owner,
        book.repo,
        paragraph.path,
        sha,
        content,
        `Update paragraph ${paragraphNum}: ${paragraph.title}`,
      );
      setSavedContent(content);
      setSha(newSha);
      toast({ title: "Saved", description: "Paragraph updated on GitHub." });
    } catch (err) {
      toast({
        title: "Save failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  // ── Guards ────────────────────────────────────────────────────────────────
  if (!book || !structure) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Book not loaded.{" "}
          <Link to={`/books/${bookId}`} className="underline">
            Load the book first.
          </Link>
        </AlertDescription>
      </Alert>
    );
  }
  if (!chapter || !paragraph) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Paragraph not found.{" "}
          <Link
            to={`/books/${bookId}/chapters/${chapterId}`}
            className="underline"
          >
            Back to chapter.
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Back */}
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to={`/books/${bookId}/chapters/${chapterId}`}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            {chapter.title}
          </Link>
        </Button>

        <div className="flex items-center gap-2">
          {isDirty && !saving && (
            <span className="text-xs text-muted-foreground">Unsaved changes</span>
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
            Save
          </Button>
        </div>
      </div>

      {/* Title row */}
      <div className="flex items-baseline gap-2">
        <Badge variant="outline" className="font-mono text-xs shrink-0">
          {paragraph.number}
        </Badge>
        <h1 className="text-xl font-bold tracking-tight truncate">
          {paragraph.title}
        </h1>
        {paragraph.draftPath && (
          <Badge variant="secondary" className="text-[10px] shrink-0">
            draft available
          </Badge>
        )}
      </div>

      {/* Editor */}
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : (
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="flex-1 min-h-[60vh] font-mono text-sm resize-none"
          placeholder="Start writing…"
          spellCheck={false}
        />
      )}

      {/* File path hint */}
      <p className="text-[11px] text-muted-foreground truncate">
        {paragraph.path}
      </p>
    </div>
  );
}

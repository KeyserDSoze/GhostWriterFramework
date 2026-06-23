import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Lock, Plus, Save, X } from "lucide-react";
import { parseDocument, stringify } from "yaml";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { readFileWithSha, updateFile } from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { resolveBookToken } from "@/types/settings";

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
  const { structures } = useBooksStore();
  const { branch } = useWorkingBranch(bookId);
  const { t } = useTranslation();

  const book = settings.books.find((entry) => entry.id === bookId);
  const structure = bookId ? structures[bookId] : undefined;
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
  const loadedRef = useRef(false);

  const resolved = resolveWorkspacePath(chapter, paragraph, workspaceKind);
  const path = resolved?.path ?? null;
  const title = resolved
    ? t(resolved.titleKey, resolved.titleParams)
    : t("workspace.document");
  const backHref = paragraph
    ? `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraph.number}`
    : `/app/books/${bookId}/chapters/${chapterId}`;

  const isDirty = body !== savedBody || JSON.stringify(entries) !== JSON.stringify(savedEntries);

  useEffect(() => {
    if (!book || !token || !path || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    readFileWithSha(token, book.owner, book.repo, branch, path)
      .then(({ content, sha: fileSha }) => {
        const parsed = parseFrontmatter(content);
        setEntries(parsed.entries);
        setSavedEntries(parsed.entries);
        setBody(parsed.body);
        setSavedBody(parsed.body);
        setSha(fileSha);
      })
      .catch((err) =>
        toast({ title: t("workspace.loadFailed"), description: String(err), variant: "destructive" }),
      )
      .finally(() => setLoading(false));
  }, [book, token, branch, path, toast]);

  if (!book || !chapter || !path) {
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
  const editableEntries = entries.filter((entry) => !READONLY_KEYS.has(entry.key));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to={backHref}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("common.back")}
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">{branch}</Badge>
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
      ) : (
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[55vh] font-mono text-sm resize-none"
          placeholder={t("workspace.writeBodyPlaceholder")}
          spellCheck={false}
        />
      )}
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
): { path: string; titleKey: string; titleParams: Record<string, string> } | null {
  if (!chapter || !kind) return null;
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

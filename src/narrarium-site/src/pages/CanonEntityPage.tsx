import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Lock, Plus, RefreshCcw, Save, X } from "lucide-react";
import { parseDocument, stringify } from "yaml";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { useToast } from "@/components/ui/use-toast";
import { readFileWithSha, updateFile } from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useSettingsStore } from "@/store/settingsStore";
import { resolveBookToken } from "@/types/settings";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useRegisterProseEditor } from "@/components/editor/useRegisterProseEditor";
import { useRegisterPageSave } from "@/store/saveStore";
import { useProseAssist } from "@/components/editor/useProseAssist";
import { RegenerateEntityDialog } from "@/components/book/RegenerateEntityDialog";
import type { EntityKind } from "@/narrarium/canon";

interface MetaEntry {
  key: string;
  value: string | string[];
}

const READONLY_KEYS = new Set(["type", "id"]);

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


export function CanonEntityPage() {
  const { bookId, section, slug } = useParams<{
    bookId: string;
    section: string;
    slug: string;
  }>();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { t } = useTranslation();

  const { book, structure, loading: structureLoading, error: structureError, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const files = useMemo(() => {
    if (!bookId) return [] as Array<{ path: string }>;
    return [];
  }, [bookId]);
  void files;

  const [entries, setEntries] = useState<MetaEntry[]>([]);
  const [body, setBody] = useState("");
  const [sha, setSha] = useState("");
  const [savedEntries, setSavedEntries] = useState<MetaEntry[]>([]);
  const [savedBody, setSavedBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showRegen, setShowRegen] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const proseAssist = useProseAssist({
    textareaRef: bodyRef,
    getBody: () => body,
    setBody,
    buildSource: () => (book && structure && token ? { token, owner: book.owner, repo: book.repo, branch, settings, structure } : null),
  });
  useRegisterProseEditor(bodyRef, {
    improve: (s) => proseAssist.improve(s),
    synonym: (s) => proseAssist.synonym(s),
  });
  const [showAddMeta, setShowAddMeta] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const loadedTargetRef = useRef<string | null>(null);

  const path = useMemo(() => {
    if (!section || !slug) return null;
    const sectionPath =
      section === "characters"
        ? `characters/${slug}.md`
        : section === "locations"
          ? `locations/${slug}.md`
          : section === "factions"
            ? `factions/${slug}.md`
            : section === "items"
              ? `items/${slug}.md`
              : section === "secrets"
                ? `secrets/${slug}.md`
                : section === "timelines"
                  ? `timelines/events/${slug}.md`
                  : null;
    return sectionPath;
  }, [section, slug]);
  const sectionLabel = section ? t(`bookPage.${section}`, { defaultValue: section }) : t("bookPage.bookMetadata");
  const sectionHref = section ? `/app/books/${bookId}#${section}` : `/app/books/${bookId}`;

  const isDirty =
    body !== savedBody || JSON.stringify(entries) !== JSON.stringify(savedEntries);

  useRegisterPageSave({ dirty: isDirty, enabled: Boolean(book && path), onSave: () => handleSave() });

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
      })
      .catch((err) => {
        loadedTargetRef.current = null;
        toast({ title: t("canon.loadFailed"), description: String(err), variant: "destructive" });
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
  if (!path) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {t("canon.notFound")} <Link to={sectionHref} className="underline">{t("canon.backToSection", { section: sectionLabel })}</Link>
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
        `Update ${section?.slice(0, -1) ?? "canon"}: ${slug}`,
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

  function handleRegenerateAccept(proposedBody: string, patches: Record<string, unknown>) {
    setBody(proposedBody.trim());
    if (Object.keys(patches).length > 0) {
      setEntries((prev) => {
        let next = [...prev];
        for (const [key, value] of Object.entries(patches)) {
          if (READONLY_KEYS.has(key)) continue;
          const idx = next.findIndex((entry) => entry.key === key);
          const normalized = normalizeMetaValue(value);
          if (idx >= 0) next = next.map((e, i) => i === idx ? { ...e, value: normalized } : e);
          else next = [...next, { key, value: normalized }];
        }
        return next;
      });
    }
    toast({ title: t("canon.regenerateApplied") });
  }

  const readonlyEntries = entries.filter((entry) => READONLY_KEYS.has(entry.key));
  const editableEntries = entries.filter((entry) => !READONLY_KEYS.has(entry.key));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
            <Link to={sectionHref}>
              <ArrowLeft className="mr-1 h-4 w-4" />
              {t("canon.backToSection", { section: sectionLabel })}
            </Link>
        </Button>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">{branch}</Badge>
          {isDirty && !saving && <span className="text-xs text-muted-foreground">{t("common.unsaved")}</span>}
          {book && token && path && structure && (
            <Button size="sm" variant="outline" onClick={() => setShowRegen(true)}>
              <RefreshCcw className="mr-1 h-4 w-4" />{t("canon.regenerate")}
            </Button>
          )}
          <Button size="sm" onClick={() => void handleSave()} disabled={!isDirty || saving}>
            {saving ? <Save className="mr-1 h-4 w-4 animate-pulse" /> : <Save className="mr-1 h-4 w-4" />}
            {t("common.save")}
          </Button>
        </div>
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
        <AutoTextarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[55vh] font-mono text-sm leading-7"
          placeholder={t("canon.writeBodyPlaceholder")}
          spellCheck={false}
        />
      )}
      {proseAssist.dialogs}

      <p className="text-[11px] text-muted-foreground truncate">{path}</p>

      {book && token && path && structure && showRegen && (
        <RegenerateEntityDialog
          open={showRegen}
          onOpenChange={setShowRegen}
          book={book}
          token={token}
          branch={branch}
          entityKind={(section === "characters" ? "character" : section === "locations" ? "location" : section === "factions" ? "faction" : section === "items" ? "item" : section === "secrets" ? "secret" : "timeline-event") as EntityKind}
          entityPath={path}
          entityName={entries.find((e) => e.key === "name" || e.key === "title")?.value as string ?? slug ?? ""}
          currentContent={buildFrontmatter(entries, body)}
          researchFiles={structure.researchFiles}
          bookLanguage={structure.language}
          onAccept={handleRegenerateAccept}
        />
      )}
    </div>
  );
}

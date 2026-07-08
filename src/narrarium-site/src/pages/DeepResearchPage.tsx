import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { parse as parseYaml } from "yaml";
import {
  AlertCircle, BookOpen, ChevronRight, FlaskConical,
  Loader2, Plus, Save, Search, Trash2, Users, MapPin, Shield, Package, Clock, EyeOff, FileEdit, X, GitFork, Cpu,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { resolveBookToken } from "@/types/settings";
import { deleteFile, loadFileContent, readFileWithSha, updateFile } from "@/github/githubClient";
import { runDeepResearch } from "@/research/engine";
import { createEntityFromResearch, DEFAULT_CREATE_PROMPTS } from "@/research/createFromResearch";
import { useRegisterPageActions } from "@/store/pageActionsStore";
import { useRegisterPageSave } from "@/store/saveStore";
import type { EntityKind } from "@/narrarium/canon";
import { ENTITY_LABEL } from "@/narrarium/canon";
import type { ResearchDepth, ResearchFrontmatter, ResearchSourceMode } from "@/research/types";
import type { ResearchFile } from "@/types/book";
import { integrationChatModels } from "@/assistant/llm";

const ENTITY_KINDS: EntityKind[] = ["character", "location", "faction", "item", "secret", "timeline-event"];
const ENTITY_ROUTE_SECTION: Record<EntityKind, string> = {
  character: "characters",
  location: "locations",
  faction: "factions",
  item: "items",
  secret: "secrets",
  "timeline-event": "timelines",
};
const ENTITY_ICONS: Record<EntityKind, React.ReactNode> = {
  character: <Users className="h-4 w-4" />,
  location: <MapPin className="h-4 w-4" />,
  faction: <Shield className="h-4 w-4" />,
  item: <Package className="h-4 w-4" />,
  secret: <EyeOff className="h-4 w-4" />,
  "timeline-event": <Clock className="h-4 w-4" />,
};

function splitResearchMarkdown(markdown: string): { frontmatterRaw: string; body: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!match) return { frontmatterRaw: "", body: markdown };
  return { frontmatterRaw: match[1], body: markdown.slice(match[0].length) };
}

function renderResearchMarkdown(frontmatterRaw: string, body: string): string {
  return frontmatterRaw.trim() ? `---\n${frontmatterRaw.trim()}\n---\n\n${body.replace(/^\n+/, "")}` : body;
}

function updateFrontmatterField(frontmatterRaw: string, field: string, value: string): string {
  if (!frontmatterRaw.trim()) return frontmatterRaw;
  const regex = new RegExp(`^${field}:.*$`, "m");
  const escaped = JSON.stringify(value);
  if (regex.test(frontmatterRaw)) {
    return frontmatterRaw.replace(regex, `${field}: ${escaped}`);
  }
  return `${frontmatterRaw.trim()}\n${field}: ${escaped}`;
}

function updateFrontmatterTimestamp(frontmatterRaw: string): string {
  if (!frontmatterRaw.trim()) return frontmatterRaw;
  try {
    const data = parseYaml(frontmatterRaw) as Record<string, unknown>;
    data.updatedAt = new Date().toISOString();
    return Object.entries(data)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? JSON.stringify(value) : JSON.stringify(value ?? "")}`)
      .join("\n");
  } catch {
    return frontmatterRaw.replace(/^updatedAt:.*$/m, `updatedAt: ${JSON.stringify(new Date().toISOString())}`);
  }
}

function useMarkdownHtml(markdown: string): string {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let active = true;
    void import("marked").then(({ marked }) => {
      if (!active) return;
      setHtml(marked.parse(markdown, { async: false }) as string);
    });
    return () => { active = false; };
  }, [markdown]);

  return html;
}

/** Selector for an LLM integration + model override. Returns "" when no override. */
function LlmOverrideSelector({
  value,
  onChange,
  disabled,
}: {
  value: string; // "integrationId::modelName" or ""
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { settings } = useSettingsStore();

  const options: Array<{ value: string; label: string }> = [{ value: "", label: t("research.llmRouter") }];
  for (const integration of settings.aiIntegrations ?? []) {
    for (const model of integrationChatModels(integration)) {
      options.push({ value: `${integration.id}::${model.name}`, label: `${integration.name} / ${model.name}` });
    }
  }

  return (
    <div className="grid gap-2">
      <Label className="flex items-center gap-1"><Cpu className="h-3.5 w-3.5" />{t("research.llmLabel")}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ─── Research detail view ─────────────────────────────────────────────────────

function ResearchDetail({
  file,
  book,
  token,
  branch,
  bookLanguage,
  onDelete,
  onEntityCreated,
  onDeepen,
}: {
  file: ResearchFile;
  book: import("@/types/settings").BookEntry;
  token: string;
  branch: string;
  bookLanguage?: string;
  onDelete: () => void;
  onEntityCreated: () => void;
  onDeepen: (query: string, depth: ResearchDepth) => void;
}) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const navigate = useNavigate();
  const [markdown, setMarkdown] = useState("");
  const [frontmatterRaw, setFrontmatterRaw] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [frontmatter, setFrontmatter] = useState<ResearchFrontmatter | null>(null);
  const [loadBusy, setLoadBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [sha, setSha] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createKind, setCreateKind] = useState<EntityKind>("character");
  const [customPrompt, setCustomPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [llmOverride, setLlmOverride] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const currency = settings.costCurrency || "USD";

  useEffect(() => {
    setLoadBusy(true);
    readFileWithSha(token, book.owner, book.repo, branch, file.path)
      .then(({ content, sha: s }) => {
        setSha(s);
        setMarkdown(content);
        const parts = splitResearchMarkdown(content);
        setFrontmatterRaw(parts.frontmatterRaw);
        setDraftBody(parts.body.trim());
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          try {
            const fm = parseYaml(fmMatch[1]) as ResearchFrontmatter;
            setFrontmatter(fm);
            setDraftTitle(fm.title ?? file.slug);
          } catch { /* ignore */ }
        } else {
          setDraftTitle(file.title || file.slug);
        }
      })
      .catch((err) => toast({ title: t("research.loadFailed"), description: String(err), variant: "destructive" }))
      .finally(() => setLoadBusy(false));
  }, [file.path, book.owner, book.repo, branch, token, t, toast, file.title, file.slug]);

  const bodyDirty = draftBody.trim() !== splitResearchMarkdown(markdown).body.trim();
  const titleDirty = frontmatter ? draftTitle !== (frontmatter.title ?? "") : false;
  const dirty = bodyDirty || titleDirty;
  const previewHtml = useMarkdownHtml(splitResearchMarkdown(markdown).body.trim());

  async function handleSave() {
    if (!dirty || !sha) return;
    setSaveBusy(true);
    try {
      let nextFrontmatter = updateFrontmatterTimestamp(frontmatterRaw);
      if (titleDirty) nextFrontmatter = updateFrontmatterField(nextFrontmatter, "title", draftTitle);
      const nextMarkdown = renderResearchMarkdown(nextFrontmatter, draftBody.trim() + "\n");
      const nextSha = await updateFile(token, book.owner, book.repo, branch, file.path, sha, nextMarkdown, `Update research ${file.slug}`);
      setSha(nextSha);
      setFrontmatterRaw(nextFrontmatter);
      setMarkdown(nextMarkdown);
      setEditMode(false);
      toast({ title: t("common.saved") });
    } catch (err) {
      toast({ title: t("research.saveFailed"), description: String(err), variant: "destructive" });
    } finally { setSaveBusy(false); }
  }

  useRegisterPageSave({ dirty, enabled: Boolean(markdown && !loadBusy), onSave: () => handleSave() });
  useRegisterPageActions([
    editMode
      ? { id: "save-research", label: t("common.save"), icon: <Save className="h-4 w-4" />, shortcut: "Ctrl+S", disabled: !dirty || saveBusy, run: () => handleSave() }
      : { id: "edit-research", label: t("research.edit"), icon: <FileEdit className="h-4 w-4" />, run: () => setEditMode(true) },
  ], Boolean(markdown && !loadBusy));

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

  function handleDeepen() {
    const nextDepth: Record<ResearchDepth, ResearchDepth> = { low: "medium", medium: "high", high: "high" };
    const currentDepth = frontmatter?.depth ?? "medium";
    onDeepen(frontmatter?.query ?? draftTitle, nextDepth[currentDepth]);
  }

  async function handleCreateEntity() {
    if (creating) { abortRef.current?.abort(); return; }
    abortRef.current = new AbortController();
    setCreating(true);
    try {
      const lang = bookLanguage ?? i18n.resolvedLanguage?.split("-")[0] ?? settings.ui.language ?? "en";
      const [overrideIntegrationId, overrideModelName] = llmOverride ? llmOverride.split("::") : [undefined, undefined];
      const result = await createEntityFromResearch({
        settings,
        book,
        branch,
        token,
        researchMarkdown: markdown,
        entityKind: createKind,
        customPrompt: customPrompt.trim() || undefined,
        language: lang,
        overrideIntegrationId,
        overrideModelName,
        signal: abortRef.current.signal,
      });
      toast({ title: t("research.createSuccess"), description: result.suggestedName });
      onEntityCreated();
      navigate(`/app/books/${book.id}/canon/${ENTITY_ROUTE_SECTION[createKind]}/${result.slug}`);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        toast({ title: t("research.createFailed"), description: String(err), variant: "destructive" });
      }
    } finally { setCreating(false); }
  }

  if (loadBusy) return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  const costValue = frontmatter?.costEur;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {editMode ? (
            <Input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              className="text-xl font-semibold font-serif"
              placeholder={t("research.titlePlaceholder")}
            />
          ) : (
            <h2 className="font-serif text-2xl font-semibold leading-tight">{frontmatter?.title ?? draftTitle ?? file.slug}</h2>
          )}
          {frontmatter && (
            <p className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span>{t("research.date")}: {frontmatter.createdAt?.slice(0, 10)}</span>
              <span>{t("research.sourceMode")}: {frontmatter.sourceMode}</span>
              <span>{t("research.depth")}: {frontmatter.depth}</span>
              {frontmatter.relatedEntityId && <span>{t("research.relatedEntity")}: {frontmatter.relatedEntityId}</span>}
              <span className="font-medium text-foreground">
                {t("research.cost")}: {costValue !== undefined
                  ? new Intl.NumberFormat(undefined, { style: "currency", currency: currency.trim() || "USD", maximumFractionDigits: 4 }).format(costValue)
                  : new Intl.NumberFormat(undefined, { style: "currency", currency: currency.trim() || "USD", maximumFractionDigits: 4 }).format(0)}
              </span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {editMode ? (
            <>
              <Button variant="outline" size="sm" onClick={() => { setDraftBody(splitResearchMarkdown(markdown).body.trim()); setDraftTitle(frontmatter?.title ?? file.slug); setEditMode(false); }} disabled={saveBusy}>
                <X className="mr-1 h-4 w-4" />{t("common.cancel")}
              </Button>
              <Button size="sm" onClick={() => void handleSave()} disabled={!dirty || saveBusy}>
                {saveBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}{t("common.save")}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setEditMode(true)}>
              <FileEdit className="mr-1 h-4 w-4" />{t("research.edit")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleDeepen} title={t("research.deepenHint")}>
            <GitFork className="mr-1 h-4 w-4" />{t("research.deepen")}
          </Button>
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
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">{t("research.createFrom")}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)} disabled={creating}>
                <X className="mr-1 h-4 w-4" />{t("common.close")}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
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
              <LlmOverrideSelector value={llmOverride} onChange={setLlmOverride} disabled={creating} />
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
      {editMode ? (
        <div className="grid gap-2">
          <Label>{t("research.markdownBody")}</Label>
          <AutoTextarea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} className="min-h-[55vh] font-mono text-sm leading-6" />
        </div>
      ) : (
        <div className="doc-prose max-w-none" dangerouslySetInnerHTML={{ __html: previewHtml }} />
      )}
    </div>
  );
}

// ─── New research form ────────────────────────────────────────────────────────

function NewResearchForm({
  book,
  token,
  branch,
  bookLanguage,
  onDone,
  initialQuery,
  initialDepth,
}: {
  book: import("@/types/settings").BookEntry;
  token: string;
  branch: string;
  bookLanguage?: string;
  onDone: (slug: string, cost: number) => void;
  initialQuery?: string;
  initialDepth?: ResearchDepth;
}) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { structure } = useBookStructure(book.id);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [sourceMode, setSourceMode] = useState<ResearchSourceMode>("wikipedia");
  const [depth, setDepth] = useState<ResearchDepth>(initialDepth ?? "medium");
  const [relatedEntityId, setRelatedEntityId] = useState("");
  const [relatedEntityType, setRelatedEntityType] = useState("");
  const [llmOverride, setLlmOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const currency = settings.costCurrency || "USD";

  useEffect(() => {
    if (initialQuery) setQuery(initialQuery);
  }, [initialQuery]);
  useEffect(() => {
    if (initialDepth) setDepth(initialDepth);
  }, [initialDepth]);

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
      const lang = bookLanguage ?? i18n.resolvedLanguage?.split("-")[0] ?? settings.ui.language ?? "en";
      const [overrideIntegrationId, overrideModelName] = llmOverride ? llmOverride.split("::") : [undefined, undefined];
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
        overrideIntegrationId,
        overrideModelName,
        signal: abortRef.current.signal,
        onProgress: setProgress,
      });
      toast({
        title: result.title,
        description: `${t("research.cost")}: ${new Intl.NumberFormat(undefined, { style: "currency", currency: currency.trim() || "USD", maximumFractionDigits: 4 }).format(result.cost)}`,
      });
      onDone(result.slug, result.cost);
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
        <LlmOverrideSelector value={llmOverride} onChange={setLlmOverride} disabled={busy} />
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
  const location = useLocation();
  const { t } = useTranslation();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, loading, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const bookLanguage = structure?.language;

  const [selected, setSelected] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [prefillQuery, setPrefillQuery] = useState("");
  const [prefillDepth, setPrefillDepth] = useState<ResearchDepth>("medium");
  const [filter, setFilter] = useState("");
  const [searchIndex, setSearchIndex] = useState<Record<string, string>>({});
  const [lastRunCosts, setLastRunCosts] = useState<Record<string, number>>({});

  const list: ResearchFile[] = useMemo(() => structure?.researchFiles ?? [], [structure]);
  const filteredList = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((entry) => `${entry.title} ${entry.slug} ${searchIndex[entry.slug] ?? ""}`.toLowerCase().includes(needle));
  }, [filter, list, searchIndex]);
  const selectedFile = useMemo(() => filteredList.find((f) => f.slug === selected) ?? null, [filteredList, selected]);

  useEffect(() => {
    const state = location.state as { newResearchQuery?: unknown; researchFilter?: unknown } | null;
    if (typeof state?.newResearchQuery === "string" && state.newResearchQuery.trim()) {
      setPrefillQuery(state.newResearchQuery.trim());
      setShowNew(true);
      setSelected(null);
    }
    if (typeof state?.researchFilter === "string" && state.researchFilter.trim()) {
      setFilter(state.researchFilter.trim());
      setShowNew(false);
    }
  }, [location.state]);

  useEffect(() => {
    if (!book || !token || list.length === 0) return;
    let active = true;
    void Promise.all(list.map(async (entry) => {
      const content = await loadFileContent(token, book.owner, book.repo, entry.path, branch).catch(() => "");
      return [entry.slug, content] as const;
    })).then((pairs) => {
      if (!active) return;
      setSearchIndex(Object.fromEntries(pairs));
    });
    return () => { active = false; };
  }, [book, branch, list, token]);

  // Auto-select first on load
  useEffect(() => {
    if (!selected && filteredList.length > 0 && !showNew) setSelected(filteredList[0].slug);
  }, [filteredList, selected, showNew]);

  function handleNewDone(slug: string, cost: number) {
    setShowNew(false);
    setLastRunCosts((prev) => ({ ...prev, [slug]: cost }));
    void reload();
    setTimeout(() => setSelected(slug), 300);
  }

  function handleDeleted() {
    void reload();
    setSelected(null);
  }

  function handleDeepen(query: string, depth: ResearchDepth) {
    setPrefillQuery(query);
    setPrefillDepth(depth);
    setShowNew(true);
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
          <Button size="sm" variant="outline" onClick={() => { setShowNew(true); setSelected(null); setPrefillQuery(""); setPrefillDepth("medium"); }}>
            <Plus className="mr-1 h-4 w-4" />{t("research.new")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("research.description")}</p>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("research.searchPlaceholder")}
            className="h-9 w-full rounded-md border bg-background py-2 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        {loading && !structure ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {filteredList.length === 0 && !showNew && (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("research.noResearch")}</p>
        )}
        <div className="space-y-1">
          {filteredList.map((f) => (
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
              {lastRunCosts[f.slug] !== undefined && (
                <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                  {new Intl.NumberFormat(undefined, { style: "currency", currency: (settings.costCurrency || "USD").trim(), maximumFractionDigits: 4 }).format(lastRunCosts[f.slug])}
                </Badge>
              )}
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
            bookLanguage={bookLanguage}
            onDone={handleNewDone}
            initialQuery={prefillQuery}
            initialDepth={prefillDepth}
          />
        ) : selectedFile && token ? (
          <ResearchDetail
            key={selectedFile.slug}
            file={selectedFile}
            book={book}
            token={token}
            branch={branch}
            bookLanguage={bookLanguage}
            onDelete={handleDeleted}
            onEntityCreated={() => { void reload(); }}
            onDeepen={handleDeepen}
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

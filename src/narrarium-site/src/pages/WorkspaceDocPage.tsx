import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowLeftRight, Loader2, Lock, Plus, Wand2, X } from "lucide-react";
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
import { useRegisterProseEditor } from "@/components/editor/useRegisterProseEditor";
import { useRegisterPageSave } from "@/store/saveStore";
import { useRegisterPageActions } from "@/store/pageActionsStore";
import { useProseAssist } from "@/components/editor/useProseAssist";
import { parseScript, serializeScript, type ScriptDoc } from "@/narrarium/script/model";
import { proseToScript, refineProse, scriptToProse, stripFrontmatter, generateChapterResume, generateChapterEvaluation, generateParagraphEvaluation, type PipelineSource } from "@/narrarium/pipeline";
import { useGenerateDiffStore } from "@/store/generateDiffStore";
import { switchDraftAndFinal } from "@/narrarium/switchDraftFinal";
import { renderAssistantMarkdownHtml } from "@/assistant/chatArtifacts";

interface MetaEntry {
  key: string;
  value: string | string[];
}

interface EvaluationScore {
  key: string;
  label: string;
  score: number;
  explanation: string;
}

interface ParagraphEvaluationView {
  paragraphNumber: string;
  paragraphTitle: string;
  path: string;
  body: string;
  scores: EvaluationScore[];
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

function paragraphSlug(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

function titleFromCriterion(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseScoresFromEntries(entries: MetaEntry[]): EvaluationScore[] {
  const raw = entries.find((entry) => entry.key === "scores")?.value;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as Record<string, { score?: unknown; explanation?: unknown; description?: unknown }>;
    return Object.entries(parsed).map(([key, value]) => ({
      key,
      label: titleFromCriterion(key),
      score: typeof value?.score === "number" ? Math.max(0, Math.min(10, value.score)) : 0,
      explanation: typeof value?.explanation === "string" && value.explanation.trim()
        ? value.explanation.trim()
        : typeof value?.description === "string" ? value.description.trim() : "",
    }));
  } catch {
    return [];
  }
}

function scoreTone(score: number): { bar: string; badge: string; ring: string } {
  if (score >= 8) return { bar: "bg-emerald-500", badge: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", ring: "#10b981" };
  if (score >= 6) return { bar: "bg-primary", badge: "border-primary/40 bg-primary/10 text-primary", ring: "hsl(var(--primary))" };
  if (score >= 4) return { bar: "bg-amber-500", badge: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300", ring: "#f59e0b" };
  return { bar: "bg-destructive", badge: "border-destructive/40 bg-destructive/10 text-destructive", ring: "hsl(var(--destructive))" };
}

function averageScores(items: ParagraphEvaluationView[]): EvaluationScore[] {
  const grouped = new Map<string, { label: string; total: number; count: number; explanations: string[] }>();
  for (const item of items) {
    for (const score of item.scores) {
      const current = grouped.get(score.key) ?? { label: score.label, total: 0, count: 0, explanations: [] };
      current.total += score.score;
      current.count += 1;
      if (score.explanation) current.explanations.push(`${item.paragraphNumber} ${item.paragraphTitle}: ${score.explanation}`);
      grouped.set(score.key, current);
    }
  }
  return [...grouped.entries()].map(([key, value]) => ({
    key,
    label: value.label,
    score: value.count ? Math.round((value.total / value.count) * 10) / 10 : 0,
    explanation: value.explanations.slice(0, 3).join("\n"),
  })).sort((a, b) => a.label.localeCompare(b.label));
}

function ScoreCards({ scores, t }: { scores: EvaluationScore[]; t: ReturnType<typeof useTranslation>["t"] }) {
  if (!scores.length) return null;
  const overall = scores.reduce((total, score) => total + score.score, 0) / scores.length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border bg-muted/20 p-4">
        <div className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-full" style={{ background: `conic-gradient(hsl(var(--primary)) ${overall * 10}%, hsl(var(--muted)) 0)` }}>
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-card text-lg font-bold">{overall.toFixed(1)}</div>
        </div>
        <div>
          <p className="text-sm font-semibold">{t("evaluationView.overallScore")}</p>
          <p className="text-xs text-muted-foreground">{t("evaluationView.averageAcross", { count: scores.length })}</p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {scores.map((score) => {
          const tone = scoreTone(score.score);
          return (
            <div key={score.key} className="overflow-hidden rounded-2xl border bg-card/70 p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-3">
                <div className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full" style={{ background: `conic-gradient(${tone.ring} ${score.score * 10}%, hsl(var(--muted)) 0)` }}>
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-card text-sm font-bold">{score.score.toFixed(score.score % 1 ? 1 : 0)}</div>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{score.label}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{score.key} · /10</p>
                </div>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.max(0, Math.min(100, score.score * 10))}%` }} />
              </div>
              {score.explanation && <p className="mt-3 whitespace-pre-line text-sm leading-6 text-muted-foreground">{score.explanation}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function evaluationMetaValue(entries: MetaEntry[], keys: string[]): string {
  const entry = entries.find((candidate) => keys.includes(candidate.key.toLowerCase()));
  if (!entry) return "";
  return Array.isArray(entry.value) ? entry.value.join(", ") : entry.value;
}

function EvaluationHighlights({ t, entries }: { t: ReturnType<typeof useTranslation>["t"]; entries: MetaEntry[] }) {
  const wordCount = evaluationMetaValue(entries, ["word_count", "word-count", "wordcount", "wordcounttotal"]);
  const verdict = evaluationMetaValue(entries, ["verdict", "final_verdict", "final-verdict", "finalverdict"]);
  const focus = evaluationMetaValue(entries, ["focus", "evaluation_focus", "evaluation-focus"]);
  if (!wordCount && !verdict && !focus) return null;
  return (
    <div className="grid gap-3 md:grid-cols-[0.7fr_1.6fr_1.2fr]">
      {wordCount && <div className="rounded-2xl border bg-card p-4 shadow-sm"><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("evaluationView.wordCount")}</p><p className="mt-1 text-2xl font-bold tabular-nums">{wordCount}</p></div>}
      {verdict && <div className="rounded-2xl border bg-card p-4 shadow-sm"><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("evaluationView.verdict")}</p><p className="mt-2 text-sm font-medium leading-6">{verdict}</p></div>}
      {focus && <div className="rounded-2xl border bg-card p-4 shadow-sm"><p className="text-xs uppercase tracking-wide text-muted-foreground">{t("evaluationView.focus")}</p><p className="mt-2 text-sm leading-6 text-muted-foreground">{focus}</p></div>}
    </div>
  );
}

function EvaluationBody({ body }: { body: string }) {
  if (!body.trim()) return null;
  return <div className="doc-prose max-w-none" dangerouslySetInnerHTML={{ __html: renderAssistantMarkdownHtml(body) }} />;
}

function EvaluationOverview({
  t,
  body,
  scores,
  paragraphEvaluations,
  loadingParagraphEvaluations,
  isChapter,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  body: string;
  scores: EvaluationScore[];
  paragraphEvaluations: ParagraphEvaluationView[];
  loadingParagraphEvaluations: boolean;
  isChapter: boolean;
}) {
  if (!isChapter) {
    return (
      <div className="space-y-5">
        {scores.length > 0 && (
          <section className="space-y-3">
            <div>
              <p className="text-sm font-semibold">{t("evaluationView.scores")}</p>
              <p className="text-xs text-muted-foreground">{t("evaluationView.scoresHint")}</p>
            </div>
            <ScoreCards scores={scores} t={t} />
          </section>
        )}
        <section className="rounded-2xl border bg-card p-5 shadow-sm"><EvaluationBody body={body} /></section>
      </div>
    );
  }

  const averages = averageScores(paragraphEvaluations);
  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div>
          <p className="text-sm font-semibold">{t("evaluationView.chapterAverage")}</p>
          <p className="text-xs text-muted-foreground">{t("evaluationView.chapterAverageHint")}</p>
        </div>
        {loadingParagraphEvaluations ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[...Array(3)].map((_, index) => <Skeleton key={index} className="h-32 rounded-2xl" />)}
          </div>
        ) : averages.length ? (
          <ScoreCards scores={averages} t={t} />
        ) : (
          <div className="rounded-2xl border border-dashed p-5 text-sm text-muted-foreground">{t("evaluationView.noParagraphScores")}</div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <p className="text-sm font-semibold">{t("evaluationView.paragraphEvaluations")}</p>
          <p className="text-xs text-muted-foreground">{t("evaluationView.paragraphEvaluationsHint")}</p>
        </div>
        {loadingParagraphEvaluations ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, index) => <Skeleton key={index} className="h-28 rounded-2xl" />)}
          </div>
        ) : paragraphEvaluations.length ? (
          <div className="space-y-4">
            {paragraphEvaluations.map((entry) => (
              <article key={entry.path} className="rounded-2xl border bg-card p-5 shadow-sm">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{entry.paragraphNumber} · {entry.paragraphTitle}</p>
                    <p className="font-mono text-xs text-muted-foreground">{entry.path}</p>
                  </div>
                </div>
                {entry.scores.length > 0 && <div className="mb-5"><ScoreCards scores={entry.scores} t={t} /></div>}
                <EvaluationBody body={entry.body} />
              </article>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed p-5 text-sm text-muted-foreground">{t("evaluationView.noParagraphEvaluations")}</div>
        )}
      </section>

      {body.trim() && (
        <section className="rounded-2xl border bg-muted/20 p-5">
          <p className="mb-3 text-sm font-semibold">{t("evaluationView.chapterSourceEvaluation")}</p>
          <EvaluationBody body={body} />
        </section>
      )}
    </div>
  );
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
  const [switchingFinal, setSwitchingFinal] = useState(false);
  const [showAddMeta, setShowAddMeta] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const loadedTargetRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [pipelineMode, setPipelineMode] = useState<"toDraft" | "toFinal">("toDraft");
  const [pipelineText, setPipelineText] = useState("");
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineGw, setPipelineGw] = useState("");
  const [scriptDoc, setScriptDoc] = useState<ScriptDoc>({ nodes: [] });
  const [scriptGenLoading, setScriptGenLoading] = useState(false);
  const [paragraphEvaluations, setParagraphEvaluations] = useState<ParagraphEvaluationView[]>([]);
  const [loadingParagraphEvaluations, setLoadingParagraphEvaluations] = useState(false);

  const proseAssist = useProseAssist({
    textareaRef: bodyRef,
    getBody: () => body,
    setBody,
    ghostwriter: (entries.find((e) => e.key === "ghostwriter")?.value as string) || "",
    buildSource: () => (book && structure && chapter && token ? { token, owner: book.owner, repo: book.repo, branch, settings, structure, chapter } : null),
  });
  useRegisterProseEditor(bodyRef, {
    improve: (s) => proseAssist.improve(s),
    synonym: (s) => proseAssist.synonym(s),
    enabled: workspaceKind !== "script",
  });

  const resolved = resolveWorkspacePath(chapter, paragraph, workspaceKind, !!paragraphNum);
  const path = resolved?.path ?? null;
  const title = resolved
    ? t(resolved.titleKey, resolved.titleParams)
    : t("workspace.document");
  const backHref = paragraph
    ? `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraph.number}`
    : `/app/books/${bookId}/chapters/${chapterId}`;
  const paraSlug = paragraph ? paragraphSlug(paragraph.path) : null;

  const isDirty = body !== savedBody || JSON.stringify(entries) !== JSON.stringify(savedEntries);
  const evaluationScores = parseScoresFromEntries(entries);

  useRegisterPageSave({ dirty: isDirty, enabled: Boolean(book && token), onSave: () => handleSave() });
  useRegisterPageActions([
    ...(paraSlug && workspaceKind === "script" ? [{ id: "script-to-draft", label: t("pipeline.scriptToDraft"), icon: <Wand2 className="h-4 w-4" />, run: () => startPipeline("toDraft") }] : []),
    ...(paraSlug && workspaceKind === "draft" ? [
      { id: "switch-to-final", label: t("paragraph.switchToFinal"), icon: switchingFinal ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeftRight className="h-4 w-4" />, run: () => handleSwitchToFinal(), disabled: switchingFinal || saving },
      { id: "draft-to-final", label: t("pipeline.draftToFinal"), icon: <Wand2 className="h-4 w-4" />, run: () => startPipeline("toFinal") },
    ] : []),
    ...((workspaceKind === "resume" || workspaceKind === "evaluation") ? [{ id: "regenerate", label: workspaceKind === "evaluation" ? t("evaluationView.regenerate") : t("pipeline.regenerate"), icon: <Wand2 className="h-4 w-4" />, run: () => regenerateDoc() }] : []),
  ], Boolean(book && token));

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

  useEffect(() => {
    if (!book || !token || !chapter || paragraph || workspaceKind !== "evaluation") {
      setParagraphEvaluations([]);
      return;
    }
    let active = true;
    setLoadingParagraphEvaluations(true);
    Promise.all(chapter.paragraphs.map(async (entry) => {
      const slug = paragraphSlug(entry.path);
      const evalPath = `evaluations/paragraphs/${chapter.slug}/${slug}.md`;
      try {
        const raw = await loadFileContent(token, book.owner, book.repo, evalPath, branch);
        const parsed = parseFrontmatter(raw);
        return {
          paragraphNumber: entry.number,
          paragraphTitle: entry.title,
          path: evalPath,
          body: parsed.body,
          scores: parseScoresFromEntries(parsed.entries),
        } satisfies ParagraphEvaluationView;
      } catch {
        return null;
      }
    }))
      .then((items) => {
        if (!active) return;
        setParagraphEvaluations(items.filter((item): item is ParagraphEvaluationView => Boolean(item)));
      })
      .finally(() => { if (active) setLoadingParagraphEvaluations(false); });
    return () => { active = false; };
  }, [book, token, branch, chapter, paragraph, workspaceKind]);

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

  async function reloadCurrentWorkspaceFile() {
    if (!book || !path) return;
    setLoading(true);
    try {
      const { content, sha: fileSha } = await readFileWithSha(token, book.owner, book.repo, branch, path);
      const parsed = parseFrontmatter(content);
      loadedTargetRef.current = `${branch}:${path}`;
      setEntries(parsed.entries);
      setSavedEntries(parsed.entries);
      setBody(parsed.body);
      setSavedBody(parsed.body);
      setSha(fileSha);
      if (workspaceKind === "script") setScriptDoc(parseScript(parsed.body));
    } catch (err) {
      loadedTargetRef.current = null;
      toast({ title: t("workspace.loadFailed"), description: String(err), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  function switchResultMessage(action: string, reason?: string) {
    if (action === "swapped") return t("paragraph.switchDoneSwapped");
    if (action === "promoted-to-final") return t("paragraph.switchDoneToFinal");
    if (action === "promoted-to-draft") return t("paragraph.switchDoneToDraft");
    if (reason === "source-empty") return t("paragraph.switchSourceEmpty");
    return t("paragraph.switchBothEmpty");
  }

  async function handleSwitchToFinal() {
    if (!book || !chapter || !paragraph || !path || workspaceKind !== "draft") return;
    if (isDirty) {
      toast({ title: t("paragraph.saveBeforeSwitch") });
      return;
    }
    if (!window.confirm(t("paragraph.switchToFinalConfirm"))) return;
    setSwitchingFinal(true);
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
        draftPath: path,
        title: paragraph.title,
      }, "toFinal");
      toast({ title: switchResultMessage(outcome.action, "reason" in outcome ? outcome.reason : undefined) });
      await reload();
      await reloadCurrentWorkspaceFile();
    } catch (err) {
      toast({ title: t("paragraph.switchFailed"), description: String(err), variant: "destructive" });
    } finally {
      setSwitchingFinal(false);
    }
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

  const readonlyEntries = entries.filter((entry) => READONLY_KEYS.has(entry.key) && entry.key !== "scores");
  const editableEntries = entries.filter((entry) => !READONLY_KEYS.has(entry.key) && entry.key !== "ghostwriter" && entry.key !== "scores");

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

  function startPipeline(mode: "toDraft" | "toFinal") {
    if (!book || !token || !structure || !chapter || !paraSlug) return;
    setPipelineMode(mode);
    setPipelineGw(currentGhostwriter);
    setPipelineText("");
    setPipelineLoading(false);
    setPipelineOpen(true);
    // Generation starts only when the user clicks Generate inside the dialog.
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

  /** Regenerate a resume/evaluation body: generate → diff → apply (writes the file). */
  function regenerateDoc() {
    if (!book || !token || !structure || !chapter || !path) return;
    const bookRef = book;
    const chapterRef = chapter;
    const currentPath = path;
    const src: PipelineSource = { token, owner: bookRef.owner, repo: bookRef.repo, branch, settings, structure, chapter: chapterRef };
    const loadProse = async (p?: string) => (p ? loadFileContent(token, bookRef.owner, bookRef.repo, p, branch).then(stripFrontmatter).catch(() => "") : "");

    useGenerateDiffStore.getState().start(async () => {
      let newBody = "";
      if (workspaceKind === "resume") {
        const scenes = await Promise.all(chapterRef.paragraphs.map(async (p) => ({ title: p.title, text: (await loadProse(p.draftPath)) || (await loadProse(p.path)) })));
        newBody = await generateChapterResume(src, scenes.filter((s) => s.text.trim()));
      } else if (paraSlug && paragraph) {
        const prose = (await loadProse(paragraph.draftPath)) || (await loadProse(paragraph.path));
        newBody = await generateParagraphEvaluation(src, paragraph.title, prose);
      } else {
        const scenes = await Promise.all(chapterRef.paragraphs.map(async (p) => ({ title: p.title, text: (await loadProse(p.draftPath)) || (await loadProse(p.path)) })));
        newBody = await generateChapterEvaluation(src, scenes.filter((s) => s.text.trim()));
      }
      return {
        title,
        oldText: body,
        newText: newBody,
        apply: async () => {
          const nextContent = buildFrontmatter(entries, newBody);
          const newSha = await updateFile(token, bookRef.owner, bookRef.repo, branch, currentPath, sha, nextContent, `Regenerate ${currentPath}`);
          setSha(newSha);
          setBody(newBody);
          setSavedBody(newBody);
        },
      };
    });
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
            {isDirty && !saving && <span className="text-xs text-muted-foreground">{t("common.unsaved")}</span>}
            {workspaceKind === "evaluation" && <Button size="sm" variant="outline" onClick={() => regenerateDoc()} disabled={saving || loading}><Wand2 className="mr-1.5 h-4 w-4" />{t("evaluationView.regenerate")}</Button>}
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
        ) : workspaceKind === "evaluation" ? (
          <EvaluationHighlights t={t} entries={entries} />
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
      ) : workspaceKind === "evaluation" ? (
        <div className="space-y-5">
          <EvaluationOverview
            t={t}
            body={body}
            scores={evaluationScores}
            paragraphEvaluations={paragraphEvaluations}
            loadingParagraphEvaluations={loadingParagraphEvaluations}
            isChapter={!paragraph}
          />
          <details className="rounded-2xl border bg-card p-4">
            <summary className="cursor-pointer text-sm font-medium">{t("evaluationView.sourceEditor")}</summary>
            <AutoTextarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="mt-4 min-h-[42vh] font-mono text-sm leading-7"
              placeholder={t("workspace.writeBodyPlaceholder")}
              spellCheck={false}
            />
          </details>
        </div>
      ) : (
        <AutoTextarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[55vh] font-mono text-sm leading-7"
          placeholder={t("workspace.writeBodyPlaceholder")}
          spellCheck={false}
        />
      )}
      {workspaceKind !== "script" && proseAssist.dialogs}
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

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, Play, RefreshCcw, RotateCcw, Sparkles, Square, Trash2, Users } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useHasLocalRewriteOperation } from "@/hooks/useHasLocalRewriteOperation";
import { resolveBookToken } from "@/types/settings";
import { deleteFile, loadFileContent, readFileWithSha } from "@/github/githubClient";
import { generateReaderEvaluationSummary, hashReaderSource, loadReaderPersonas, parseReaderEvaluation, runReaderEvaluations, type ReaderEvaluationProgress, type ReaderEvaluationRecord, type ReaderEvaluationTarget } from "@/narrarium/readerEvaluations";
import type { ReaderEvaluationDepth, ReaderPersonaProfile } from "@/narrarium/readerPersona";
import { renderAssistantMarkdownHtml } from "@/assistant/chatArtifacts";
import { useRegisterPageActions } from "@/store/pageActionsStore";
import { openFeedbackRewriteWorkflow, type FeedbackRewriteMode } from "@/store/feedbackRewriteWorkflowStore";

export function ReaderEvaluationsPage() {
  const { bookId, chapterId, paragraphNum } = useParams<{ bookId: string; chapterId: string; paragraphNum?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const chapter = structure?.chapters.find((entry) => entry.slug === chapterId);
  const paragraph = chapter?.paragraphs.find((entry) => entry.number === paragraphNum);
  const selection = (location.state as { readerEvaluationSelection?: string } | null)?.readerEvaluationSelection?.trim() ?? "";
  const [target, setTarget] = useState<ReaderEvaluationTarget | null>(null);
  const [personas, setPersonas] = useState<ReaderPersonaProfile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [depth, setDepth] = useState<ReaderEvaluationDepth>("normal");
  const [includeContext, setIncludeContext] = useState(true);
  const [history, setHistory] = useState<ReaderEvaluationRecord[]>([]);
  const [progress, setProgress] = useState<Record<string, ReaderEvaluationProgress>>({});
  const [running, setRunning] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});
  const [setupOpen, setSetupOpen] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const paragraphSlugValue = paragraph ? paragraphSlug(paragraph.path) : undefined;
  const rewriteScope = paragraph ? "paragraph" as const : "chapter" as const;
  const hasRewriteOperation = useHasLocalRewriteOperation({ book, branch, scope: rewriteScope, chapterSlug: chapterId, paragraphSlug: paragraphSlugValue });

  function openRewrite(mode: FeedbackRewriteMode, record?: Pick<ReaderEvaluationRecord, "path" | "readerId" | "readerName">) {
    if (!bookId || !chapterId || selection) return;
    openFeedbackRewriteWorkflow({
      mode,
      scope: rewriteScope,
      bookId,
      chapterSlug: chapterId,
      paragraphSlug: paragraphSlugValue,
      feedbackMode: record ? "reader-opinion" : "panel-summary",
      feedbackPath: record?.path,
      readerId: record?.readerId,
      readerName: record?.readerName,
    });
  }

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const mode = params.get("workflow");
    if (mode !== "generate" && mode !== "restore" && mode !== "status") return;
    if (!chapter || (paragraphNum && !paragraph)) return;
    const readerRecord = mode === "generate" && params.get("feedbackMode") === "reader-opinion" && params.get("feedbackPath") && params.get("readerId")
      ? { path: params.get("feedbackPath")!, readerId: params.get("readerId")!, readerName: params.get("readerName") ?? params.get("readerId")! }
      : undefined;
    openRewrite(mode, readerRecord);
    params.delete("workflow");
    params.delete("feedbackMode");
    params.delete("feedbackPath");
    params.delete("readerId");
    params.delete("readerName");
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [location.search, bookId, chapterId, chapter?.slug, paragraphNum, paragraphSlugValue, selection]);

  useEffect(() => {
    if (!book || !structure || !token || !chapter) return;
    let active = true;
    const build = async () => {
      let text = "";
      let sourcePath = `${chapter.path}/chapter.md`;
      let version = branch;
      if (selection) {
        text = selection;
        sourcePath = paragraph?.path ?? sourcePath;
      } else if (paragraph) {
        const file = await readFileWithSha(token, book.owner, book.repo, branch, paragraph.path);
        text = stripFrontmatter(file.content);
        sourcePath = paragraph.path;
        version = file.sha;
      } else {
        const files = await Promise.all(chapter.paragraphs.map((entry) => readFileWithSha(token, book.owner, book.repo, branch, entry.path).catch(() => null)));
        text = files.map((file, index) => file ? `## ${chapter.paragraphs[index].title}\n\n${stripFrontmatter(file.content)}` : "").filter(Boolean).join("\n\n");
        version = files.map((file) => file?.sha ?? "").join(":");
      }
      const nextTarget: ReaderEvaluationTarget = { type: selection ? "selection" : paragraph ? "paragraph" : "chapter", bookId: book.id, chapterId: chapter.slug, paragraphId: paragraph ? paragraphSlug(paragraph.path) : undefined, title: selection ? t("readerEvaluations.selectionTitle") : paragraph?.title ?? chapter.title, text, sourcePath, sourceVersion: version };
      const [loadedPersonas, currentHash] = await Promise.all([loadReaderPersonas({ token, book, branch, structure }), hashReaderSource(text)]);
      if (!active) return;
      setTarget(nextTarget);
      setPersonas(loadedPersonas);
      setSelected(new Set(loadedPersonas.filter((profile) => profile.enabled).map((profile) => profile.id)));
      const prefixes = targetPrefixes(nextTarget);
      const records = await Promise.all(structure.readerEvaluationFiles.filter((file) => prefixes.some((prefix) => file.path.startsWith(prefix))).map(async (file) => {
        const raw = file.content ?? await loadFileContent(token, book.owner, book.repo, file.path, branch).catch(() => "");
        return raw ? parseReaderEvaluation(file.path, raw, currentHash) : null;
      }));
      if (active) {
        const nextHistory = records.filter((record): record is ReaderEvaluationRecord => Boolean(record)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setHistory(nextHistory);
        setSetupOpen(nextHistory.filter((record) => record.readerId !== "summary").length === 0);
      }
    };
    void build().catch((err) => toast({ title: t("readerEvaluations.loadFailed"), description: String(err), variant: "destructive" }));
    return () => { active = false; };
  }, [book?.id, structure?.loadedBranch, chapter?.slug, paragraph?.path, selection, token, branch]);

  async function run(readersOverride?: ReaderPersonaProfile[]) {
    if (!book || !structure || !target) return;
    const readers = readersOverride ?? personas.filter((profile) => selected.has(profile.id) && profile.enabled);
    if (!readers.length) return;
    setRunning(true);
    setProgress({});
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await runReaderEvaluations({ token, book, branch, structure, settings, target, readers, depth, includeContext, concurrency: 2, signal: controller.signal, onProgress: (entry) => setProgress((current) => ({ ...current, [entry.readerId]: entry })) });
      const nextRecords = [...result.completed, ...result.failed];
      const replacedPaths = new Set(nextRecords.map((record) => record.path));
      setHistory((current) => [...nextRecords, ...current.filter((record) => !replacedPaths.has(record.path))]);
      await reload();
      toast({ title: t("readerEvaluations.runDone", { completed: result.completed.length, failed: result.failed.length }) });
    } catch (err) { toast({ title: t("readerEvaluations.runFailed"), description: String(err), variant: "destructive" }); }
    finally { abortRef.current = null; setRunning(false); }
  }

  async function rerun(record: ReaderEvaluationRecord) {
    const reader = personas.find((profile) => profile.id === record.readerId);
    if (reader) await run([reader]);
  }

  async function removeEvaluation(record: ReaderEvaluationRecord) {
    if (!book || !window.confirm(t("readerEvaluations.deleteConfirm", { reader: record.readerName }))) return;
    const file = await readFileWithSha(token, book.owner, book.repo, branch, record.path).catch(() => null);
    if (!file) return;
    await deleteFile(token, book.owner, book.repo, branch, record.path, file.sha, `Delete reader evaluation ${record.readerName}`);
    setHistory((current) => current.filter((entry) => entry.path !== record.path));
    await reload();
  }

  async function summarize() {
    if (!book || !target) return;
    const evaluations = latestCompletedByReader(history);
    if (evaluations.length < 2) return;
    setSummaryBusy(true);
    try {
      const summary = await generateReaderEvaluationSummary({ token, book, branch, settings, target, evaluations, language: structure?.language });
      setHistory((current) => [summary, ...current.filter((entry) => entry.path !== summary.path)]);
      await reload();
    } catch (err) { toast({ title: t("readerEvaluations.summaryFailed"), description: String(err), variant: "destructive" }); }
    finally { setSummaryBusy(false); }
  }

  const latestSummary = useMemo(() => history.filter((record) => record.readerId === "summary" && record.status === "completed").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null, [history]);

  useRegisterPageActions([
    { id: "run-readers", label: t("readerEvaluations.runSelected"), icon: <Users className="h-4 w-4" />, run: () => run(), disabled: running || !target },
    { id: "summary-readers", label: t("readerEvaluations.generateSummary"), icon: <Sparkles className="h-4 w-4" />, run: () => summarize(), disabled: running || summaryBusy || latestCompletedByReader(history).length < 2 },
    { id: "generate-draft-from-feedback", label: t("feedbackRewrite.generate"), icon: <Sparkles className="h-4 w-4" />, run: () => openRewrite("generate"), disabled: Boolean(selection) || !latestSummary },
    { id: "restore-previous-drafts", label: t("feedbackRewrite.restore"), icon: <RotateCcw className="h-4 w-4" />, run: () => openRewrite("restore"), disabled: Boolean(selection) || !hasRewriteOperation },
  ], Boolean(book && target));

  const groups = useMemo(() => ({ standard: personas.filter((profile) => profile.readerType === "standard"), genre: personas.filter((profile) => profile.readerType === "genre"), custom: personas.filter((profile) => profile.readerType === "custom") }), [personas]);
  const readerHistory = useMemo(() => history.filter((record) => record.readerId !== "summary"), [history]);
  const latestByReader = useMemo(() => latestCompletedByReader(history), [history]);
  const averageScore = useMemo(() => {
    const scores = latestByReader.map((record) => record.score).filter((score): score is number => typeof score === "number");
    if (!scores.length) return null;
    const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    return average % 1 === 0 ? `${average.toFixed(0)}/10` : `${average.toFixed(1)}/10`;
  }, [latestByReader]);
  const summaryOpen = latestSummary ? Boolean(openCards[latestSummary.path]) : Boolean(openCards.__panelSummary__);
  function toggleCard(key: string) {
    setOpenCards((current) => ({ ...current, [key]: !current[key] }));
  }
  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;
  if (!chapter) return <Alert variant="destructive"><AlertDescription>{t("chapter.notFound", { id: chapterId })}</AlertDescription></Alert>;
  return <div className="space-y-6">
    <div className="overflow-hidden rounded-3xl border bg-gradient-to-br from-primary/15 via-card to-card p-6 shadow-sm sm:p-8"><div className="flex flex-wrap items-start justify-between gap-4"><div><Badge variant="secondary"><Users className="mr-1.5 h-3.5 w-3.5" />{t("readerEvaluations.badge")}</Badge><h1 className="mt-4 font-serif text-3xl font-semibold sm:text-4xl">{t("readerEvaluations.title")}</h1><p className="mt-2 text-muted-foreground">{target?.title ?? chapter.title}</p></div><div className="flex flex-wrap items-center gap-2">{typeof latestByReader.length === "number" && latestByReader.length > 0 && <Badge variant="outline">{t("readerEvaluations.completedReaders", { count: latestByReader.length })}</Badge>}{averageScore && <Badge variant="secondary">{t("readerEvaluations.averageScore", { score: averageScore })}</Badge>}</div></div></div>
    <Card className="overflow-hidden">
      <button type="button" onClick={() => setSetupOpen((current) => !current)} className="flex w-full items-center justify-between gap-3 px-6 py-5 text-left">
        <div className="min-w-0">
          <p className="font-semibold">{t("readerEvaluations.runPanelTitle")}</p>
          <p className="text-sm text-muted-foreground">{readerHistory.length > 0 ? t("readerEvaluations.runPanelCollapsed") : t("readerEvaluations.runPanelIntro")}</p>
        </div>
        <ChevronDown className={setupOpen ? "h-4 w-4 shrink-0 rotate-180 transition-transform" : "h-4 w-4 shrink-0 transition-transform"} />
      </button>
      {setupOpen && <CardContent className="space-y-5 border-t pt-6"><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setSelected(new Set(personas.filter((profile) => profile.enabled).map((profile) => profile.id)))}>{t("readerEvaluations.allActive")}</Button><Button size="sm" variant="outline" onClick={() => setSelected(new Set(groups.standard.filter((profile) => profile.enabled).map((profile) => profile.id)))}>{t("readerEvaluations.onlyStandard")}</Button><Button size="sm" variant="outline" onClick={() => setSelected(new Set(groups.genre.filter((profile) => profile.enabled).map((profile) => profile.id)))}>{t("readerEvaluations.onlyGenre")}</Button></div>
        {(["standard", "genre", "custom"] as const).map((group) => groups[group].length ? <div key={group}><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`readerPersonas.filters.${group}`)}</p><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{groups[group].map((profile) => <label key={profile.id} className={profile.enabled ? "flex items-start gap-3 rounded-xl border p-3" : "flex items-start gap-3 rounded-xl border bg-muted/30 p-3 opacity-60"}><input type="checkbox" checked={selected.has(profile.id)} disabled={!profile.enabled || running} onChange={(event) => setSelected((current) => { const next = new Set(current); event.target.checked ? next.add(profile.id) : next.delete(profile.id); return next; })} className="mt-1" /><span><span className="block text-sm font-medium">{profile.name}</span><span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{profile.description}</span></span></label>)}</div></div> : null)}
        <div className="grid gap-4 sm:grid-cols-3"><div><Label>{t("readerEvaluations.depth")}</Label><Select value={depth} onValueChange={(value) => setDepth(value as ReaderEvaluationDepth)}><SelectTrigger className="mt-2"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="brief">{t("readerEvaluations.depthBrief")}</SelectItem><SelectItem value="normal">{t("readerEvaluations.depthNormal")}</SelectItem><SelectItem value="deep">{t("readerEvaluations.depthDeep")}</SelectItem></SelectContent></Select></div><label className="flex items-center gap-3 pt-7"><Switch checked={includeContext} onCheckedChange={setIncludeContext} /><span className="text-sm">{t("readerEvaluations.includeContext")}</span></label><div className="flex items-end gap-2">{running ? <Button variant="destructive" onClick={() => abortRef.current?.abort()}><Square className="mr-2 h-4 w-4" />{t("common.cancel")}</Button> : <Button onClick={() => void run()} disabled={!selected.size || !target}><Play className="mr-2 h-4 w-4" />{t("readerEvaluations.runSelected")}</Button>}</div></div>
      </CardContent>}
    </Card>
    {Object.keys(progress).length > 0 && <div className="grid gap-2 sm:grid-cols-2">{Object.values(progress).map((entry) => <div key={entry.readerId} className="flex items-center gap-3 rounded-xl border p-3">{entry.status === "completed" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : entry.status === "failed" ? <AlertCircle className="h-4 w-4 text-destructive" /> : <Loader2 className="h-4 w-4 animate-spin" />}<span className="text-sm">{entry.readerName}</span><Badge variant="outline" className="ml-auto">{entry.status}</Badge></div>)}</div>}
    <div className="space-y-4">
      <div className="rounded-2xl border bg-card shadow-sm">
        <button type="button" onClick={() => toggleCard(latestSummary?.path ?? "__panelSummary__")} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left">
          <div className="min-w-0">
            <p className="font-semibold">{t("readerEvaluations.panelSummaryTitle")}</p>
            <p className="text-xs text-muted-foreground">{latestSummary ? t("readerEvaluations.panelSummaryReady") : t("readerEvaluations.panelSummaryMissing")}</p>
          </div>
          <div className="flex items-center gap-2">
            {averageScore && <Badge variant="secondary">{t("readerEvaluations.averageScore", { score: averageScore })}</Badge>}
            {latestSummary?.stale && <Badge variant="destructive">{t("readerEvaluations.stale")}</Badge>}
            <ChevronDown className={summaryOpen ? "h-4 w-4 shrink-0 rotate-180 transition-transform" : "h-4 w-4 shrink-0 transition-transform"} />
          </div>
        </button>
        {summaryOpen && (
          <div className="space-y-4 border-t px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{latestSummary ? new Date(latestSummary.createdAt).toLocaleString() : t("readerEvaluations.summaryHint")}</p>
              <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
                <Button className="!h-auto min-h-8 w-full !whitespace-normal sm:w-auto" variant="outline" size="sm" onClick={() => void summarize()} disabled={summaryBusy || latestByReader.length < 2 || running}>
                  {summaryBusy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
                  {latestSummary ? t("readerEvaluations.regenerateSummary") : t("readerEvaluations.generateSummary")}
                </Button>
                <Button className="!h-auto min-h-8 w-full !whitespace-normal sm:w-auto" size="sm" onClick={() => openRewrite("generate")} disabled={Boolean(selection) || !latestSummary || running || summaryBusy}><Sparkles className="mr-1.5 h-4 w-4 shrink-0" />{t("feedbackRewrite.generate")}</Button>
                {hasRewriteOperation && <Button className="!h-auto min-h-8 w-full !whitespace-normal sm:w-auto" variant="outline" size="sm" onClick={() => openRewrite("restore")} disabled={Boolean(selection) || running || summaryBusy}><RotateCcw className="mr-1.5 h-4 w-4 shrink-0" />{t("feedbackRewrite.restore")}</Button>}
                {latestSummary && (
                  <Button className="self-end sm:self-auto" size="icon" variant="ghost" onClick={() => void removeEvaluation(latestSummary)} disabled={running || summaryBusy}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                )}
              </div>
            </div>
            {latestSummary
              ? <div className="doc-prose max-w-none" dangerouslySetInnerHTML={{ __html: renderAssistantMarkdownHtml(latestSummary.body) }} />
              : <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("readerEvaluations.summaryEmptyState")}</div>}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between"><h2 className="text-xl font-semibold">{t("readerEvaluations.readerOpinions")}</h2>{latestByReader.length > 0 && <Badge variant="outline">{t("readerEvaluations.completedReaders", { count: latestByReader.length })}</Badge>}</div>
      <div className="space-y-4">{readerHistory.length ? readerHistory.map((record) => {
        const isOpen = Boolean(openCards[record.path]);
        return <article key={record.path} className="overflow-hidden rounded-2xl border bg-card shadow-sm"><button type="button" onClick={() => toggleCard(record.path)} className="flex w-full items-start justify-between gap-3 px-5 py-4 text-left"><div className="min-w-0"><p className="font-semibold">{record.readerName}</p><p className="text-xs text-muted-foreground">{new Date(record.createdAt).toLocaleString()}</p></div><div className="flex items-center gap-2">{record.stale && <Badge variant="destructive">{t("readerEvaluations.stale")}</Badge>}<Badge variant="outline">{record.score !== undefined ? `${record.score}/10` : record.status}</Badge><ChevronDown className={isOpen ? "h-4 w-4 shrink-0 rotate-180 transition-transform" : "h-4 w-4 shrink-0 transition-transform"} /></div></button>{isOpen && <div className="min-w-0 space-y-4 border-t px-5 py-4"><div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end"><Button className="!h-auto min-h-8 w-full !whitespace-normal sm:w-auto" size="sm" onClick={() => openRewrite("generate", record)} disabled={Boolean(selection) || running || record.status !== "completed"}><Sparkles className="mr-1.5 h-4 w-4 shrink-0" />{t("feedbackRewrite.generateFromOpinion")}</Button><div className="flex items-center justify-end gap-2">{record.readerId !== "summary" && <Button size="sm" variant="outline" onClick={() => void rerun(record)} disabled={running}><RefreshCcw className="mr-1.5 h-4 w-4" />{t("readerEvaluations.rerun")}</Button>}<Button size="icon" variant="ghost" onClick={() => void removeEvaluation(record)} disabled={running}><Trash2 className="h-4 w-4 text-destructive" /></Button></div></div><div className="doc-prose max-w-none" dangerouslySetInnerHTML={{ __html: renderAssistantMarkdownHtml(record.body) }} /></div>}</article>;
      }) : <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">{t("readerEvaluations.empty")}</div>}</div>
    </div>
  </div>;
}

function stripFrontmatter(raw: string): string { return raw.replace(/^---[\s\S]*?---\s*/, "").trim(); }
function paragraphSlug(path: string): string { return (path.split("/").pop() ?? "").replace(/\.md$/i, ""); }
function targetPrefixes(target: ReaderEvaluationTarget): string[] {
  if (target.type === "chapter") return [`evaluations/readers/chapters/${target.chapterId}/`, `evaluations/readers/summaries/chapters/${target.chapterId}.md`];
  if (target.type === "paragraph") return [`evaluations/readers/paragraphs/${target.chapterId}/${target.paragraphId}/`, `evaluations/readers/summaries/paragraphs/${target.chapterId}/${target.paragraphId}.md`];
  return [`evaluations/readers/selections/${target.chapterId}/${target.paragraphId ?? "chapter"}/`, `evaluations/readers/summaries/selections/${target.chapterId}/${target.paragraphId ?? "chapter"}.md`];
}
function latestCompletedByReader(records: ReaderEvaluationRecord[]): ReaderEvaluationRecord[] { const seen = new Set<string>(); return records.filter((record) => { if (record.status !== "completed" || record.readerId === "summary" || seen.has(record.readerId)) return false; seen.add(record.readerId); return true; }); }

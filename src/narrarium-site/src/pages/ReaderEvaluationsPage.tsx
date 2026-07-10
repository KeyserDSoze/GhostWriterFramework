import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Loader2, Play, Sparkles, Square, Users } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { resolveBookToken } from "@/types/settings";
import { loadFileContent, readFileWithSha } from "@/github/githubClient";
import { generateReaderEvaluationSummary, hashReaderSource, loadReaderPersonas, parseReaderEvaluation, runReaderEvaluations, type ReaderEvaluationProgress, type ReaderEvaluationRecord, type ReaderEvaluationTarget } from "@/narrarium/readerEvaluations";
import type { ReaderEvaluationDepth, ReaderPersonaProfile } from "@/narrarium/readerPersona";
import { renderAssistantMarkdownHtml } from "@/assistant/chatArtifacts";
import { useRegisterPageActions } from "@/store/pageActionsStore";

export function ReaderEvaluationsPage() {
  const { bookId, chapterId, paragraphNum } = useParams<{ bookId: string; chapterId: string; paragraphNum?: string }>();
  const location = useLocation();
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
  const abortRef = useRef<AbortController | null>(null);

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
      if (active) setHistory(records.filter((record): record is ReaderEvaluationRecord => Boolean(record)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    };
    void build().catch((err) => toast({ title: t("readerEvaluations.loadFailed"), description: String(err), variant: "destructive" }));
    return () => { active = false; };
  }, [book?.id, structure?.loadedBranch, chapter?.slug, paragraph?.path, selection, token, branch]);

  async function run() {
    if (!book || !structure || !target) return;
    const readers = personas.filter((profile) => selected.has(profile.id) && profile.enabled);
    if (!readers.length) return;
    setRunning(true);
    setProgress({});
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await runReaderEvaluations({ token, book, branch, structure, settings, target, readers, depth, includeContext, concurrency: 2, signal: controller.signal, onProgress: (entry) => setProgress((current) => ({ ...current, [entry.readerId]: entry })) });
      setHistory((current) => [...result.completed, ...result.failed, ...current]);
      await reload();
      toast({ title: t("readerEvaluations.runDone", { completed: result.completed.length, failed: result.failed.length }) });
    } catch (err) { toast({ title: t("readerEvaluations.runFailed"), description: String(err), variant: "destructive" }); }
    finally { abortRef.current = null; setRunning(false); }
  }

  async function summarize() {
    if (!book || !target) return;
    const evaluations = latestCompletedByReader(history);
    if (evaluations.length < 2) return;
    setSummaryBusy(true);
    try {
      const summary = await generateReaderEvaluationSummary({ token, book, branch, settings, target, evaluations, language: structure?.language });
      setHistory((current) => [summary, ...current]);
      await reload();
    } catch (err) { toast({ title: t("readerEvaluations.summaryFailed"), description: String(err), variant: "destructive" }); }
    finally { setSummaryBusy(false); }
  }

  useRegisterPageActions([
    { id: "run-readers", label: t("readerEvaluations.runSelected"), icon: <Users className="h-4 w-4" />, run: () => run(), disabled: running || !target },
    { id: "summary-readers", label: t("readerEvaluations.generateSummary"), icon: <Sparkles className="h-4 w-4" />, run: () => summarize(), disabled: running || summaryBusy || latestCompletedByReader(history).length < 2 },
  ], Boolean(book && target));

  const groups = useMemo(() => ({ standard: personas.filter((profile) => profile.readerType === "standard"), genre: personas.filter((profile) => profile.readerType === "genre"), custom: personas.filter((profile) => profile.readerType === "custom") }), [personas]);
  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;
  if (!chapter) return <Alert variant="destructive"><AlertDescription>{t("chapter.notFound", { id: chapterId })}</AlertDescription></Alert>;
  return <div className="space-y-6">
    <div className="overflow-hidden rounded-3xl border bg-gradient-to-br from-primary/15 via-card to-card p-6 shadow-sm sm:p-8"><Badge variant="secondary"><Users className="mr-1.5 h-3.5 w-3.5" />{t("readerEvaluations.badge")}</Badge><h1 className="mt-4 font-serif text-3xl font-semibold sm:text-4xl">{t("readerEvaluations.title")}</h1><p className="mt-2 text-muted-foreground">{target?.title ?? chapter.title}</p></div>
    <Card><CardHeader><CardTitle>{t("readerEvaluations.chooseReaders")}</CardTitle></CardHeader><CardContent className="space-y-5"><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setSelected(new Set(personas.filter((profile) => profile.enabled).map((profile) => profile.id)))}>{t("readerEvaluations.allActive")}</Button><Button size="sm" variant="outline" onClick={() => setSelected(new Set(groups.standard.filter((profile) => profile.enabled).map((profile) => profile.id)))}>{t("readerEvaluations.onlyStandard")}</Button><Button size="sm" variant="outline" onClick={() => setSelected(new Set(groups.genre.filter((profile) => profile.enabled).map((profile) => profile.id)))}>{t("readerEvaluations.onlyGenre")}</Button></div>
      {(["standard", "genre", "custom"] as const).map((group) => groups[group].length ? <div key={group}><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`readerPersonas.filters.${group}`)}</p><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{groups[group].map((profile) => <label key={profile.id} className={profile.enabled ? "flex items-start gap-3 rounded-xl border p-3" : "flex items-start gap-3 rounded-xl border bg-muted/30 p-3 opacity-60"}><input type="checkbox" checked={selected.has(profile.id)} disabled={!profile.enabled || running} onChange={(event) => setSelected((current) => { const next = new Set(current); event.target.checked ? next.add(profile.id) : next.delete(profile.id); return next; })} className="mt-1" /><span><span className="block text-sm font-medium">{profile.name}</span><span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{profile.description}</span></span></label>)}</div></div> : null)}
      <div className="grid gap-4 sm:grid-cols-3"><div><Label>{t("readerEvaluations.depth")}</Label><Select value={depth} onValueChange={(value) => setDepth(value as ReaderEvaluationDepth)}><SelectTrigger className="mt-2"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="brief">{t("readerEvaluations.depthBrief")}</SelectItem><SelectItem value="normal">{t("readerEvaluations.depthNormal")}</SelectItem><SelectItem value="deep">{t("readerEvaluations.depthDeep")}</SelectItem></SelectContent></Select></div><label className="flex items-center gap-3 pt-7"><Switch checked={includeContext} onCheckedChange={setIncludeContext} /><span className="text-sm">{t("readerEvaluations.includeContext")}</span></label><div className="flex items-end gap-2">{running ? <Button variant="destructive" onClick={() => abortRef.current?.abort()}><Square className="mr-2 h-4 w-4" />{t("common.cancel")}</Button> : <Button onClick={() => void run()} disabled={!selected.size || !target}><Play className="mr-2 h-4 w-4" />{t("readerEvaluations.runSelected")}</Button>}</div></div>
    </CardContent></Card>
    {Object.keys(progress).length > 0 && <div className="grid gap-2 sm:grid-cols-2">{Object.values(progress).map((entry) => <div key={entry.readerId} className="flex items-center gap-3 rounded-xl border p-3">{entry.status === "completed" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : entry.status === "failed" ? <AlertCircle className="h-4 w-4 text-destructive" /> : <Loader2 className="h-4 w-4 animate-spin" />}<span className="text-sm">{entry.readerName}</span><Badge variant="outline" className="ml-auto">{entry.status}</Badge></div>)}</div>}
    <div className="flex items-center justify-between"><h2 className="text-xl font-semibold">{t("readerEvaluations.history")}</h2><Button variant="outline" onClick={() => void summarize()} disabled={summaryBusy || latestCompletedByReader(history).length < 2}>{summaryBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}{t("readerEvaluations.generateSummary")}</Button></div>
    <div className="space-y-4">{history.length ? history.map((record) => <article key={record.path} className="rounded-2xl border bg-card p-5 shadow-sm"><div className="mb-4 flex flex-wrap items-start justify-between gap-2"><div><p className="font-semibold">{record.readerName}</p><p className="text-xs text-muted-foreground">{new Date(record.createdAt).toLocaleString()}</p></div><div className="flex gap-2">{record.stale && <Badge variant="destructive">{t("readerEvaluations.stale")}</Badge>}<Badge variant="outline">{record.score !== undefined ? `${record.score}/10` : record.status}</Badge></div></div><div className="doc-prose max-w-none" dangerouslySetInnerHTML={{ __html: renderAssistantMarkdownHtml(record.body) }} /></article>) : <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">{t("readerEvaluations.empty")}</div>}</div>
  </div>;
}

function stripFrontmatter(raw: string): string { return raw.replace(/^---[\s\S]*?---\s*/, "").trim(); }
function paragraphSlug(path: string): string { return (path.split("/").pop() ?? "").replace(/\.md$/i, ""); }
function targetPrefixes(target: ReaderEvaluationTarget): string[] {
  if (target.type === "chapter") return [`evaluations/readers/chapters/${target.chapterId}/`, `evaluations/readers/summaries/chapters/${target.chapterId}/`];
  if (target.type === "paragraph") return [`evaluations/readers/paragraphs/${target.chapterId}/${target.paragraphId}/`, `evaluations/readers/summaries/paragraphs/${target.chapterId}/${target.paragraphId}/`];
  return [`evaluations/readers/selections/${target.chapterId}/${target.paragraphId ?? "chapter"}/`, `evaluations/readers/summaries/selections/${target.chapterId}/${target.paragraphId ?? "chapter"}/`];
}
function latestCompletedByReader(records: ReaderEvaluationRecord[]): ReaderEvaluationRecord[] { const seen = new Set<string>(); return records.filter((record) => { if (record.status !== "completed" || record.readerId === "summary" || seen.has(record.readerId)) return false; seen.add(record.readerId); return true; }); }

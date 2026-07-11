import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileWarning,
  Loader2,
  Play,
  RefreshCcw,
  Save,
  ShieldAlert,
  Square,
  Trash2,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import {
  AUDIT_CATEGORIES,
  deleteAudit,
  findingSourceHref,
  loadAuditReport,
  resolveAuditTarget,
  runAudit,
  updateAuditFinding,
  type AuditCertainty,
  type AuditFinding,
  type AuditFindingStatus,
  type AuditProgress,
  type AuditReport,
  type AuditRunState,
  type AuditSeverity,
  type AuditTarget,
  type ResolvedAuditTarget,
} from "@/narrarium/audit";
import { useRegisterPageActions } from "@/store/pageActionsStore";
import { useSettingsStore } from "@/store/settingsStore";
import { resolveBookAuditSettings, resolveBookToken, type AuditDepth } from "@/types/settings";

const SEVERITIES: AuditSeverity[] = ["critical", "high", "medium", "low", "informational"];
const CERTAINTIES: AuditCertainty[] = ["confirmed", "probable", "possible", "needs-context"];
const STATUSES: AuditFindingStatus[] = ["open", "resolved", "ignored", "false-positive", "needs-review"];

export function AuditPage() {
  const { bookId, chapterId, paragraphNum } = useParams<{ bookId: string; chapterId?: string; paragraphNum?: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, loading: structureLoading, error: structureError, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const auditSettings = book ? resolveBookAuditSettings(book) : null;
  const targetInput: AuditTarget = paragraphNum
    ? { scope: "paragraph", bookId: bookId ?? "", chapterId, paragraphNum }
    : chapterId
      ? { scope: "chapter", bookId: bookId ?? "", chapterId }
      : { scope: "book", bookId: bookId ?? "" };
  let target: ResolvedAuditTarget | null = null;
  let targetError = "";
  if (structure && bookId) {
    try { target = resolveAuditTarget(structure, targetInput); }
    catch (error) { targetError = error instanceof Error ? error.message : String(error); }
  }

  const [report, setReport] = useState<AuditReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [loadedReportPath, setLoadedReportPath] = useState("");
  const [runState, setRunState] = useState<AuditRunState>("pending");
  const [progress, setProgress] = useState<AuditProgress | null>(null);
  const [depth, setDepth] = useState<AuditDepth>("standard");
  const [error, setError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [updatingFinding, setUpdatingFinding] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [severityFilter, setSeverityFilter] = useState("all");
  const [certaintyFilter, setCertaintyFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const abortRef = useRef<AbortController | null>(null);
  const handledOperationRef = useRef("");

  useEffect(() => {
    if (auditSettings) setDepth(auditSettings.defaultDepth);
  }, [book?.id]);

  useEffect(() => {
    if (!book || !structure || !target || !token) return;
    let active = true;
    setLoadedReportPath("");
    setLoadingReport(true);
    setError("");
    void loadAuditReport({ token, book, branch, structure, target: targetInput })
      .then((loaded) => {
        if (!active) return;
        setReport(loaded);
        setNotes(Object.fromEntries((loaded?.findings ?? []).map((finding) => [finding.id, finding.authorNote])));
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!active) return;
        setLoadingReport(false);
        setLoadedReportPath(target.reportPath);
      });
    return () => { active = false; };
  }, [book?.id, branch, structure?.loadedBranch, target?.reportPath, token]);

  const running = runState === "preparingContext" || runState === "running" || runState === "synthesizing";

  async function executeAudit() {
    if (!book || !structure || !target || !token || running || !auditSettings?.enabled) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setRunState("preparingContext");
    setProgress({ state: "preparingContext", completedCalls: 0, totalCalls: 0 });
    try {
      const completed = await runAudit({
        token,
        book,
        branch,
        structure,
        settings,
        target: targetInput,
        depth,
        signal: controller.signal,
        onProgress: (next) => { setProgress(next); setRunState(next.state); },
      });
      setReport(completed);
      setNotes(Object.fromEntries(completed.findings.map((finding) => [finding.id, finding.authorNote])));
      setRunState("completed");
      toast({ title: t("audit.messages.runComplete") });
      reload();
    } catch (runError) {
      const cancelled = controller.signal.aborted || (runError instanceof Error && runError.name === "AbortError");
      setRunState(cancelled ? "cancelled" : "failed");
      if (!cancelled) {
        const message = runError instanceof Error ? runError.message : String(runError);
        setError(message);
        toast({ title: t("audit.errors.runFailed"), description: message, variant: "destructive" });
      }
    } finally {
      abortRef.current = null;
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const severity = params.get("severity");
    const certainty = params.get("certainty");
    const category = params.get("category");
    const status = params.get("status");
    setSeverityFilter(severity && SEVERITIES.includes(severity as AuditSeverity) ? severity : "all");
    setCertaintyFilter(certainty && CERTAINTIES.includes(certainty as AuditCertainty) ? certainty : "all");
    const knownCategories = new Set<string>([...AUDIT_CATEGORIES, ...(report?.findings.map((finding) => finding.category) ?? [])]);
    setCategoryFilter(category && knownCategories.has(category) ? category : "all");
    setStatusFilter(status && STATUSES.includes(status as AuditFindingStatus) ? status : "all");
  }, [location.search, report]);

  useEffect(() => {
    if (!target || loadedReportPath !== target.reportPath) return;
    const params = new URLSearchParams(location.search);
    const action = params.get("action");
    if (action !== "run" && action !== "delete") return;
    const operationKey = `${target.reportPath}:${location.search}`;
    if (handledOperationRef.current === operationKey) return;
    handledOperationRef.current = operationKey;
    params.delete("action");
    const search = params.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ""}${location.hash}`, { replace: true });
    if (action === "delete") setDeleteOpen(true);
    else void executeAudit();
  }, [loadedReportPath, location.hash, location.pathname, location.search, target?.reportPath]);

  async function removeReport() {
    if (!book || !structure || !target || !token) return;
    setDeleting(true);
    try {
      await deleteAudit({ token, book, branch, structure, target: targetInput });
      setReport(null);
      setNotes({});
      setDeleteOpen(false);
      setRunState("pending");
      setProgress(null);
      toast({ title: t("audit.messages.deleted") });
      reload();
    } catch (deleteError) {
      toast({ title: t("audit.errors.deleteFailed"), description: String(deleteError), variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  async function updateFinding(finding: AuditFinding, patch: { status?: AuditFindingStatus; authorNote?: string }) {
    if (!book || !structure || !target || !token) return;
    setUpdatingFinding(finding.id);
    try {
      const updated = await updateAuditFinding({ token, book, branch, structure, target: targetInput, findingId: finding.id, ...patch });
      setReport((current) => ({ ...updated, stale: current?.stale, currentSourceHash: current?.currentSourceHash }));
      setNotes((current) => patch.authorNote === undefined ? current : ({ ...current, [finding.id]: updated.findings.find((entry) => entry.id === finding.id)?.authorNote ?? "" }));
      toast({ title: t("audit.messages.findingSaved") });
    } catch (updateError) {
      toast({ title: t("audit.errors.updateFailed"), description: String(updateError), variant: "destructive" });
    } finally {
      setUpdatingFinding(null);
    }
  }

  function openSource(finding?: AuditFinding) {
    if (!structure || !target) return;
    const href = finding ? findingSourceHref(structure, target, finding) : target.sourceHref;
    navigate(href, finding ? { state: { auditTextOffset: finding.position.textOffset, auditExcerpt: finding.position.excerpt } } : undefined);
  }

  useRegisterPageActions([
    {
      id: report ? "update-audit" : "run-audit",
      label: report ? t("audit.actions.update") : t("audit.actions.run"),
      icon: report ? <RefreshCcw className="h-4 w-4" /> : <Play className="h-4 w-4" />,
      run: () => executeAudit(),
      disabled: running || !target || !auditSettings?.enabled,
    },
    { id: "open-audit-source", label: t("audit.actions.openSource"), icon: <ExternalLink className="h-4 w-4" />, run: () => openSource(), disabled: !target },
    { id: "delete-audit", label: t("audit.actions.delete"), icon: <Trash2 className="h-4 w-4" />, run: () => setDeleteOpen(true), disabled: running || !report },
  ], Boolean(book && target));

  const categories = useMemo(() => [...new Set([...AUDIT_CATEGORIES, ...(report?.findings.map((finding) => finding.category) ?? [])])], [report]);
  const filteredFindings = useMemo(() => (report?.findings ?? []).filter((finding) =>
    (severityFilter === "all" || finding.severity === severityFilter)
    && (certaintyFilter === "all" || finding.certainty === certaintyFilter)
    && (categoryFilter === "all" || finding.category === categoryFilter)
    && (statusFilter === "all" || finding.status === statusFilter)), [report, severityFilter, certaintyFilter, categoryFilter, statusFilter]);
  const openCount = report?.findings.filter((finding) => finding.status === "open" || finding.status === "needs-review").length ?? 0;
  const criticalCount = report?.findings.filter((finding) => finding.severity === "critical").length ?? 0;

  if (!book && !structureLoading) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;
  if (structureError || targetError) return <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{structureError || targetError}</AlertDescription></Alert>;
  if (!structure || !target) return <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-3xl border bg-gradient-to-br from-amber-500/15 via-card to-card p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary"><ClipboardCheck className="mr-1.5 h-3.5 w-3.5" />{t("audit.badge")}</Badge>
              <Badge variant="outline">{t(`audit.scopes.${target.scope}`)}</Badge>
              {report?.stale && <Badge variant="destructive">{t("audit.stale")}</Badge>}
            </div>
            <h1 className="mt-4 truncate font-serif text-3xl font-semibold sm:text-4xl">{t("audit.title")}</h1>
            <p className="mt-2 text-muted-foreground">{target.title}</p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end">
            <div className="min-w-40">
              <Label>{t("audit.depth.label")}</Label>
              <Select value={depth} onValueChange={(value) => setDepth(value as AuditDepth)} disabled={running}>
                <SelectTrigger className="mt-1.5 bg-background"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="quick">{t("audit.depth.quick")}</SelectItem>
                  <SelectItem value="standard">{t("audit.depth.standard")}</SelectItem>
                  <SelectItem value="deep">{t("audit.depth.deep")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {running ? (
              <Button variant="destructive" onClick={() => abortRef.current?.abort()}><Square className="mr-2 h-4 w-4" />{t("audit.actions.cancel")}</Button>
            ) : (
              <Button onClick={() => void executeAudit()} disabled={!auditSettings?.enabled}>{report ? <RefreshCcw className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}{report ? t(report.stale ? "audit.actions.update" : "audit.actions.rerun") : t("audit.actions.run")}</Button>
            )}
            <Button variant="outline" onClick={() => openSource()}><BookOpen className="mr-2 h-4 w-4" />{t("audit.actions.openSource")}</Button>
            {report && <Button variant="outline" onClick={() => setDeleteOpen(true)} disabled={running}><Trash2 className="h-4 w-4 text-destructive sm:mr-2" /><span className="hidden sm:inline">{t("audit.actions.delete")}</span></Button>}
          </div>
        </div>
      </section>

      {!auditSettings?.enabled && <Alert><AlertCircle className="h-4 w-4" /><AlertDescription>{t("audit.disabled")}</AlertDescription></Alert>}
      {error && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{error}</AlertDescription></Alert>}

      {(running || runState === "failed" || runState === "cancelled" || runState === "completed") && progress && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-4 shadow-sm">
          {running ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : runState === "completed" ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <AlertCircle className="h-5 w-5 text-destructive" />}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t(`audit.progress.${runState}`)}</p>
            {progress.detail && <p className="truncate text-xs text-muted-foreground">{progress.detail}</p>}
          </div>
          {progress.totalCalls > 0 && <Badge variant="outline">{progress.completedCalls}/{progress.totalCalls}</Badge>}
        </div>
      )}

      {loadingReport ? (
        <Card><CardContent className="flex items-center gap-3 py-8 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />{t("audit.progress.loading")}</CardContent></Card>
      ) : !report ? (
        <Card className="border-dashed"><CardContent className="flex flex-col items-center px-6 py-12 text-center"><FileWarning className="h-10 w-10 text-muted-foreground" /><h2 className="mt-4 text-lg font-semibold">{t("audit.empty.title")}</h2><p className="mt-2 max-w-lg text-sm text-muted-foreground">{t("audit.empty.description")}</p><Button className="mt-5" onClick={() => void executeAudit()} disabled={!auditSettings?.enabled || running}><Play className="mr-2 h-4 w-4" />{t("audit.actions.run")}</Button></CardContent></Card>
      ) : (
        <>
          {report.stale && <Alert><RefreshCcw className="h-4 w-4" /><AlertDescription>{t("audit.staleDescription")}</AlertDescription></Alert>}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label={t("audit.cards.result")} value={t(`audit.results.${report.auditResult}`)} icon={<ShieldAlert className="h-5 w-5" />} />
            <MetricCard label={t("audit.cards.total")} value={String(report.findings.length)} icon={<ClipboardCheck className="h-5 w-5" />} />
            <MetricCard label={t("audit.cards.open")} value={String(openCount)} icon={<FileWarning className="h-5 w-5" />} />
            <MetricCard label={t("audit.cards.critical")} value={String(criticalCount)} icon={<AlertCircle className="h-5 w-5" />} />
          </div>

          <Card>
            <CardHeader><CardTitle className="text-xl">{t("audit.summary.title")}</CardTitle></CardHeader>
            <CardContent className="space-y-5 text-sm leading-6">
              <p className="whitespace-pre-wrap">{report.executiveSummary || t("audit.none")}</p>
              {report.recommendedFixOrder.length > 0 && <div><h3 className="font-semibold">{t("audit.summary.fixOrder")}</h3><ol className="mt-2 list-decimal space-y-1 pl-5">{report.recommendedFixOrder.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol></div>}
              <div><h3 className="font-semibold">{t("audit.summary.finalAssessment")}</h3><p className="mt-2 whitespace-pre-wrap">{report.finalAssessment || t("audit.none")}</p></div>
              <p className="text-xs text-muted-foreground">{t("audit.summary.strategy", { passes: report.passCount, chunks: report.chunkCount })}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4"><CardTitle className="text-xl">{t("audit.filters.title")}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <FilterSelect label={t("audit.filters.severity")} value={severityFilter} onChange={setSeverityFilter} allLabel={t("audit.filters.all")} values={SEVERITIES.map((value) => ({ value, label: t(`audit.severities.${value}`) }))} />
                <FilterSelect label={t("audit.filters.certainty")} value={certaintyFilter} onChange={setCertaintyFilter} allLabel={t("audit.filters.all")} values={CERTAINTIES.map((value) => ({ value, label: t(`audit.certainties.${value}`) }))} />
                <FilterSelect label={t("audit.filters.category")} value={categoryFilter} onChange={setCategoryFilter} allLabel={t("audit.filters.all")} values={categories.map((value) => ({ value, label: t(`audit.categories.${value}`, { defaultValue: value }) }))} />
                <FilterSelect label={t("audit.filters.status")} value={statusFilter} onChange={setStatusFilter} allLabel={t("audit.filters.all")} values={STATUSES.map((value) => ({ value, label: t(`audit.statuses.${value}`) }))} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant={statusFilter === "open" ? "default" : "outline"} onClick={() => setStatusFilter("open")}>{t("audit.filters.open")}</Button>
                <Button size="sm" variant={statusFilter === "resolved" ? "default" : "outline"} onClick={() => setStatusFilter("resolved")}>{t("audit.filters.resolved")}</Button>
                <Button size="sm" variant={statusFilter === "false-positive" ? "default" : "outline"} onClick={() => setStatusFilter("false-positive")}>{t("audit.filters.falsePositive")}</Button>
                {statusFilter !== "all" && <Button size="sm" variant="ghost" onClick={() => setStatusFilter("all")}>{t("audit.filters.clear")}</Button>}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-semibold">{t("audit.findings.title")}</h2><Badge variant="outline">{filteredFindings.length}</Badge></div>
            {filteredFindings.length ? filteredFindings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                note={notes[finding.id] ?? ""}
                busy={updatingFinding === finding.id}
                onNoteChange={(value) => setNotes((current) => ({ ...current, [finding.id]: value }))}
                onSaveNote={() => updateFinding(finding, { authorNote: notes[finding.id] ?? "" })}
                onStatusChange={(status) => updateFinding(finding, { status })}
                onOpenSource={() => openSource(finding)}
              />
            )) : <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">{t("audit.findings.noMatches")}</div>}
          </div>
        </>
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("audit.delete.title")}</DialogTitle><DialogDescription>{t("audit.delete.description")}</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>{t("audit.actions.cancel")}</Button><Button variant="destructive" onClick={() => void removeReport()} disabled={deleting}>{deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("audit.delete.confirm")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MetricCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return <Card><CardContent className="p-4 sm:p-5"><div className="flex items-start justify-between gap-3 text-muted-foreground"><p className="text-xs font-medium uppercase tracking-wide">{label}</p>{icon}</div><p className="mt-3 text-xl font-semibold sm:text-2xl">{value}</p></CardContent></Card>;
}

function FilterSelect({ label, value, onChange, allLabel, values }: { label: string; value: string; onChange: (value: string) => void; allLabel: string; values: Array<{ value: string; label: string }> }) {
  return <div><Label>{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{allLabel}</SelectItem>{values.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>;
}

function FindingCard({ finding, note, busy, onNoteChange, onSaveNote, onStatusChange, onOpenSource }: {
  finding: AuditFinding;
  note: string;
  busy: boolean;
  onNoteChange: (value: string) => void;
  onSaveNote: () => void;
  onStatusChange: (status: AuditFindingStatus) => void;
  onOpenSource: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="border-b bg-muted/25 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap gap-2">
            <Badge variant={finding.severity === "critical" || finding.severity === "high" ? "destructive" : "secondary"}>{t(`audit.severities.${finding.severity}`)}</Badge>
            <Badge variant="outline">{t(`audit.certainties.${finding.certainty}`)}</Badge>
            <Badge variant="outline">{t(`audit.categories.${finding.category}`, { defaultValue: finding.category })}</Badge>
            <Badge variant="outline">{t(`audit.statuses.${finding.status}`)}</Badge>
          </div>
          <Button size="sm" variant="outline" onClick={onOpenSource}><ExternalLink className="mr-1.5 h-4 w-4" />{t("audit.findings.source")}</Button>
        </div>
        <h3 className="mt-4 text-base font-semibold leading-6 sm:text-lg">{finding.description}</h3>
      </div>
      <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4 text-sm leading-6">
          <FindingSection title={t("audit.findings.evidence")} value={finding.evidence} />
          <FindingSection title={t("audit.findings.source")} value={[finding.structuredSourceRef.path, finding.structuredSourceRef.heading].filter(Boolean).join(" / ")} mono />
          <FindingSection title={t("audit.findings.conflict")} value={finding.conflictExplanation} />
          <FindingSection title={t("audit.findings.fix")} value={finding.correctionSuggestion} />
        </div>
        <div className="space-y-4 rounded-xl border bg-muted/20 p-4">
          <div><Label>{t("audit.findings.status")}</Label><Select value={finding.status} onValueChange={(value) => onStatusChange(value as AuditFindingStatus)} disabled={busy}><SelectTrigger className="mt-1.5 bg-background"><SelectValue /></SelectTrigger><SelectContent>{STATUSES.map((status) => <SelectItem key={status} value={status}>{t(`audit.statuses.${status}`)}</SelectItem>)}</SelectContent></Select></div>
          <div><Label htmlFor={`note-${finding.id}`}>{t("audit.findings.authorNote")}</Label><Textarea id={`note-${finding.id}`} className="mt-1.5 min-h-28 bg-background" value={note} onChange={(event) => onNoteChange(event.target.value)} placeholder={t("audit.findings.authorNotePlaceholder")} disabled={busy} /></div>
          <Button className="w-full" variant="outline" onClick={onSaveNote} disabled={busy || note === finding.authorNote}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{t("audit.actions.saveNote")}</Button>
        </div>
      </div>
    </article>
  );
}

function FindingSection({ title, value, mono = false }: { title: string; value: string; mono?: boolean }) {
  if (!value) return null;
  return <div><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4><p className={mono ? "mt-1.5 break-all font-mono text-xs" : "mt-1.5 whitespace-pre-wrap"}>{value}</p></div>;
}

import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookMarked, CheckCircle2, ClipboardCheck, ListTree, Loader2, PenLine, TriangleAlert } from "lucide-react";
import type { AutopilotState, DesignCompletionFinding, DesignFieldProposal, DesignProposalsResult, OutlineChapterEntry } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { formatCount, formatDate, voteText } from "@/autopilot/format";
import { completionViewOf, defaultChosen, proposalsDecision, proposedLines, waitingOf, type CompletionChapterView, type CompletionView } from "@/outline/completionModel";

export interface DesignProposalsProps {
  bookId: string;
  state: AutopilotState | null;
  entries: readonly OutlineChapterEntry[];
  /** A run of the autopilot goes on (here or elsewhere): nothing can be applied meanwhile. */
  running: boolean;
  onShowTab: (tab: string) => void;
  onStartWriting: () => void;
}

/**
 * What «Review and complete» proposes (#125), chapter by chapter, for the author to choose: the design fields an entry lacks, what does not hold together (a note for the
 * ghostwriter once applied), and the characters, places and secrets to create. Everything that is not minor is chosen at first; one apply writes the chosen ones, through
 * the engine (a field only where the entry still lacks it, what happens in a chapter never changed).
 */
export default function DesignProposals({ bookId, state, entries, running, onShowTab, onStartWriting }: DesignProposalsProps) {
  const { t } = useTranslation();
  const id = useId();
  const view = useMemo(() => completionViewOf(state, entries), [state, entries]);
  const { busy, run } = useAutopilotActions(bookId);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [result, setResult] = useState<{ value: DesignProposalsResult; at: string } | null>(null);
  if (!view) return null;
  const picked = chosen ?? defaultChosen(view);
  const waiting = result ? 0 : view.waiting.length;
  const count = view.waiting.filter((item) => picked.has(item)).length;
  const disabled = busy !== null || running || view.active;
  const toggle = (ids: readonly string[], on: boolean) => setChosen(() => {
    const next = new Set(picked);
    for (const item of ids) {
      if (on) next.add(item);
      else next.delete(item);
    }
    return next;
  });
  const apply = async () => {
    const decision = proposalsDecision(view, picked);
    const answer: { value: DesignProposalsResult | null } = { value: null };
    const done = await run("answer", async (runtime, book) => {
      answer.value = await runtime.applyDesignProposals(book, decision);
    });
    if (done && answer.value) {
      setResult({ value: answer.value, at: new Date().toISOString() });
      setChosen(null);
    }
  };
  // What applying did shows at once, before the state read again says it.
  const decided = view.decided ?? (result ? { applied: result.value.applied, skipped: result.value.skipped, at: result.at } : undefined);

  return (
    <section aria-labelledby={`${id}-title`} data-design-proposals={decided ? "decided" : view.active ? "active" : "waiting"} className="space-y-4 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
      <div className="space-y-1">
        <h2 id={`${id}-title`} className="flex items-center gap-2 text-lg font-semibold"><ClipboardCheck className="h-5 w-5 text-primary" aria-hidden="true" />{t("design.complete.title")}</h2>
        {view.last && <p className="text-sm text-muted-foreground">{t("design.complete.vote", { score: voteText(view.last.score), round: view.last.round })}</p>}
      </div>

      {decided ? (
        <div data-design-decided="" className="space-y-3">
          <p role="status" className="flex items-start gap-2 text-sm font-medium">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
            {t("design.complete.decided", { applied: formatCount(decided.applied), skipped: formatCount(decided.skipped), date: formatDate(decided.at) })}
          </p>
          {result && <AppliedResult result={result.value} />}
          <div className="flex flex-wrap gap-2">
            <Button type="button" data-design-write="" disabled={running || busy !== null} onClick={onStartWriting}><PenLine className="h-4 w-4" aria-hidden="true" />{t("design.studio.ready.write")}</Button>
            <Button type="button" variant="ghost" onClick={() => onShowTab("synopsis")}><ListTree className="h-4 w-4" aria-hidden="true" />{t("design.studio.ready.synopsis")}</Button>
            <Button type="button" variant="ghost" onClick={() => onShowTab("bible")}><BookMarked className="h-4 w-4" aria-hidden="true" />{t("design.studio.ready.bible")}</Button>
          </div>
        </div>
      ) : waiting === 0 ? (
        <p className="text-sm">{view.active ? t("design.complete.making") : t("design.complete.nothing")}</p>
      ) : (
        <>
          <p className="max-w-3xl text-sm">{t("design.complete.intro", { count: waiting, chapters: formatCount(view.chapters.filter((chapter) => waitingOf(chapter).length).length) })}</p>
          {view.active && <p className="text-sm text-muted-foreground">{t("design.complete.active")}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setChosen(new Set(view.waiting))}>{t("design.complete.all")}</Button>
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setChosen(new Set())}>{t("design.complete.none")}</Button>
          </div>
          <ol className="space-y-2" aria-label={t("design.complete.chapters")}>
            {view.chapters.map((chapter) => <ChapterProposals key={chapter.number} chapter={chapter} picked={picked} disabled={disabled} onToggle={toggle} />)}
          </ol>
          {view.canon.some((proposal) => proposal.status === "waiting") && <CanonProposals view={view} picked={picked} disabled={disabled} onToggle={toggle} />}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" data-design-apply="" disabled={disabled} aria-describedby={`${id}-count ${id}-how`} onClick={() => void apply()}>
              {busy !== null ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
              {count === 0 ? t("design.complete.applyNone") : t("design.complete.apply", { count })}
            </Button>
          </div>
          <p id={`${id}-count`} role="status" className="text-xs text-muted-foreground">{t("design.complete.chosen", { count, total: waiting })}</p>
          <p id={`${id}-how`} className="text-xs text-muted-foreground">{t("design.complete.how")}</p>
        </>
      )}
    </section>
  );
}

function AppliedResult({ result }: { result: DesignProposalsResult }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1 text-sm">
      <p>
        {t("design.complete.result", { count: result.applied, chapters: formatCount(result.chapters.length) })}
        {result.created.length > 0 && <> {t("design.complete.created", { count: result.created.length })}</>}
      </p>
      {result.outdated > 0 && <p className="text-muted-foreground">{t("design.complete.outdated", { count: result.outdated })}</p>}
      {result.held.length > 0 && (
        <div data-design-held="" className="space-y-1">
          <p className="flex items-start gap-1.5 font-medium text-amber-800 dark:text-amber-300"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{t("design.complete.held", { count: result.held.length })}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">{result.held.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function ChapterProposals({ chapter, picked, disabled, onToggle }: { chapter: CompletionChapterView; picked: ReadonlySet<string>; disabled: boolean; onToggle: (ids: readonly string[], on: boolean) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const open = waitingOf(chapter);
  const chosen = open.filter((item) => picked.has(item)).length;
  const fields = chapter.fields.filter((field) => field.status === "waiting");
  const findings = chapter.findings.filter((finding) => finding.status === "waiting");
  if (!open.length) return null;
  return (
    <li data-proposals-chapter={chapter.number} className="rounded-xl border bg-background/60">
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="font-medium">{t("design.complete.chapter", { number: formatCount(chapter.number) })}{chapter.title ? ` — ${chapter.title}` : ""}</span>
          <span className="text-xs text-muted-foreground">{t("design.complete.counts", { fields: fields.length, findings: findings.length, chosen, total: open.length })}</span>
        </summary>
        <div className="space-y-3 border-t px-3 pb-3 pt-2">
          {(chapter.changed || chapter.gone) && (
            <p className="flex items-start gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-300"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{chapter.gone ? t("design.complete.gone") : t("design.complete.changed")}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onToggle(open, true)}>{t("design.complete.chapterAll", { number: formatCount(chapter.number) })}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onToggle(open, false)}>{t("design.complete.chapterNone", { number: formatCount(chapter.number) })}</Button>
          </div>
          {fields.length > 0 && (
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-semibold text-muted-foreground">{t("design.complete.fields")}</legend>
              <ul className="space-y-1.5">{fields.map((field) => <FieldRow key={field.id} id={`${id}-${field.id}`} field={field} checked={picked.has(field.id)} disabled={disabled} onToggle={onToggle} />)}</ul>
            </fieldset>
          )}
          {findings.length > 0 && (
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-semibold text-muted-foreground">{t("design.complete.findings")}</legend>
              <ul className="space-y-1.5">{findings.map((finding) => <FindingRow key={finding.id} id={`${id}-${finding.id}`} finding={finding} checked={picked.has(finding.id)} disabled={disabled} onToggle={onToggle} />)}</ul>
            </fieldset>
          )}
        </div>
      </details>
    </li>
  );
}

function FieldRow({ id, field, checked, disabled, onToggle }: { id: string; field: DesignFieldProposal; checked: boolean; disabled: boolean; onToggle: (ids: readonly string[], on: boolean) => void }) {
  const { t } = useTranslation();
  const lines = proposedLines(field.value);
  const value = typeof field.value === "boolean" ? [field.value ? t("design.complete.yes") : t("design.complete.no")] : lines;
  return (
    <li data-proposal={field.id}>
      <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm sm:min-h-0">
        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={checked} disabled={disabled} aria-describedby={`${id}-value`} onChange={(event) => onToggle([field.id], event.target.checked)} />
        <span className="min-w-0">
          <span className="font-medium">{t(`outline.design.fields.${field.key}`)}</span>
          {value.length === 1 ? <span id={`${id}-value`} className="block whitespace-pre-line break-words text-muted-foreground">{value[0]}</span> : (
            <ul id={`${id}-value`} className="list-disc pl-5 text-muted-foreground">{value.map((line, index) => <li key={index} className="break-words">{line}</li>)}</ul>
          )}
        </span>
      </label>
    </li>
  );
}

function FindingRow({ id, finding, checked, disabled, onToggle }: { id: string; finding: DesignCompletionFinding; checked: boolean; disabled: boolean; onToggle: (ids: readonly string[], on: boolean) => void }) {
  const { t } = useTranslation();
  const who = finding.source === "reader" ? finding.by || t("design.complete.source.reader") : t(`design.complete.source.${finding.source}`);
  return (
    <li data-proposal={finding.id} data-severity={finding.severity}>
      <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm sm:min-h-0">
        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={checked} disabled={disabled} aria-describedby={`${id}-text`} onChange={(event) => onToggle([finding.id], event.target.checked)} />
        <span className="min-w-0">
          <span className="block text-xs font-semibold">
            <span className={finding.severity === "critical" ? "text-destructive" : finding.severity === "major" ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground"}>{t(`design.complete.severity.${finding.severity}`)}</span>
            {finding.criterion && <> · {t(`design.complete.criterion.${finding.criterion}`)}</>}
            {" · "}{who}
          </span>
          <span id={`${id}-text`} className="block whitespace-pre-line break-words">{finding.text}</span>
          {finding.suggestion && <span className="block break-words text-muted-foreground">{t("design.complete.suggestion", { text: finding.suggestion })}</span>}
        </span>
      </label>
    </li>
  );
}

function CanonProposals({ view, picked, disabled, onToggle }: { view: CompletionView; picked: ReadonlySet<string>; disabled: boolean; onToggle: (ids: readonly string[], on: boolean) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const open = view.canon.filter((proposal) => proposal.status === "waiting");
  return (
    <fieldset data-proposals-canon="" className="space-y-1.5 rounded-xl border bg-background/60 p-3">
      <legend className="px-1 text-sm font-semibold">{t("design.complete.canon")}</legend>
      <p className="text-xs text-muted-foreground">{t("design.complete.canonHint")}</p>
      <ul className="space-y-1.5">
        {open.map((proposal) => (
          <li key={proposal.id} data-proposal={proposal.id}>
            <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm sm:min-h-0">
              <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={picked.has(proposal.id)} disabled={disabled} aria-describedby={`${id}-${proposal.id}`} onChange={(event) => onToggle([proposal.id], event.target.checked)} />
              <span className="min-w-0">
                <span className="font-medium">{proposal.name}</span> <span className="text-xs text-muted-foreground">({t(`design.complete.kind.${proposal.kind}`)}{proposal.chapters.length ? ` · ${t("design.complete.inChapters", { list: proposal.chapters.map((number) => formatCount(number)).join(", ") })}` : ""})</span>
                <span id={`${id}-${proposal.id}`} className="block whitespace-pre-line break-words text-muted-foreground">{proposal.description}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

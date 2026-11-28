import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, LockOpen } from "lucide-react";
import { BIBLE_DECISIONS_FILE, answerQuestion, askQuestion, captureDecision, setDecisionStatus, type BibleDecision, type BibleQuestion } from "narrarium-engine";
import "@/i18n/bibleStudio";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBibleSave } from "@/components/outline/bible/bibleParts";
import type { BibleData } from "@/outline/bibleModel";
import type { OutlineSource } from "@/outline/outlineSource";
import { cn } from "@/lib/utils";

interface Props {
  data: BibleData;
  source: OutlineSource | null;
  onSaved: () => void;
  /** This book's autopilot runs on a server that does not announce the decisions: a lock does not bind it there. */
  serverWithoutDecisions?: boolean;
}

const numbersOf = (text: string): number[] => [...new Set(text.split(/[\s,;]+/).map((item) => Number(item)).filter((value) => Number.isSafeInteger(value) && value > 0))];
const linesOf = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);

function Status({ message }: { message: { tone: "ok" | "error"; text: string } | null }) {
  return <p role="status" className={cn("min-h-4 text-xs", message?.tone === "error" ? "font-medium text-destructive" : "text-muted-foreground")}>{message?.text ?? ""}</p>;
}

/** The decisions of the book (the log of `bible/decisions.md`): read, captured, locked by the author; and the open questions the agents add and the author answers. */
export function DecisionsSection({ data, source, onSaved, serverWithoutDecisions = false }: Props) {
  const { t } = useTranslation();
  const { busy, message, save } = useBibleSave(source, onSaved);
  const [filter, setFilter] = useState<"all" | "locked" | "open">("all");
  const filterId = useId();
  const file = data.decisionsFile;
  const content = file?.content ?? null;
  const decisions = data.decisions.decisions.filter((decision) => filter === "all" || decision.status === filter);
  const write = (next: string | null, label: string, ok?: string) => (next === null ? Promise.resolve(false) : save(BIBLE_DECISIONS_FILE, next, file?.hash ?? null, label, ok));

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">{t("bibleStudio.decisions.intro")}</p>
      {serverWithoutDecisions && <p role="alert" data-server-without-decisions className="rounded-lg border border-amber-500/60 bg-amber-50 p-2 text-xs text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">{t("bibleStudio.decisions.serverWithout")}</p>}
      {data.decisionsProblems.length > 0 && <p role="alert" className="text-xs text-amber-800 dark:text-amber-300">{t("bibleStudio.decisions.problems", { problems: data.decisionsProblems.join("; ") })}</p>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Label htmlFor={filterId} className="text-xs font-medium">{t("bibleStudio.decisions.filterLabel")}</Label>
        <select id={filterId} value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
          <option value="all">{t("bibleStudio.decisions.filter.all")}</option>
          <option value="locked">{t("bibleStudio.decisions.filter.locked")}</option>
          <option value="open">{t("bibleStudio.decisions.filter.open")}</option>
        </select>
      </div>
      {data.decisions.decisions.length === 0
        ? <p className="text-sm text-muted-foreground">{t("bibleStudio.decisions.empty")}</p>
        : (
          <ul data-bible-decisions className="space-y-2">
            {decisions.map((decision) => (
              <DecisionRow key={decision.id} decision={decision} busy={busy} onToggle={() => void write(setDecisionStatus(content, decision.id, decision.status === "locked" ? "open" : "locked"), `${decision.status === "locked" ? "open" : "lock"} ${decision.id}`, t(decision.status === "locked" ? "bibleStudio.decisions.unlocking" : "bibleStudio.decisions.locking", { id: decision.id }))} />
            ))}
          </ul>
        )}
      <CaptureForm busy={busy} onCapture={(input, lock) => {
        const captured = captureDecision(content, { ...input, by: "author", status: lock ? "locked" : "open" }, new Date());
        return "content" in captured ? write(captured.content, `decision ${captured.decision.id}`) : Promise.resolve(false);
      }} />
      <Status message={message} />
      <QuestionsBlock questions={data.decisions.questions} busy={busy} onAsk={(text) => {
        const asked = askQuestion(content, { question: text, by: "author" }, new Date());
        return "content" in asked ? write(asked.content, `question ${asked.question.id}`) : Promise.resolve(false);
      }} onAnswer={(question, answer, asDecision) => {
        const answered = answerQuestion(content, question.id, answer, new Date(), asDecision ? { status: "locked" } : undefined);
        return "content" in answered ? write(answered.content, `answer ${question.id}`, t("bibleStudio.questions.closed", { id: question.id })) : Promise.resolve(false);
      }} />
    </div>
  );
}

function DecisionRow({ decision, busy, onToggle }: { decision: BibleDecision; busy: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const locked = decision.status === "locked";
  const scope = [
    decision.chapters.length ? t("bibleStudio.decisions.chapters", { list: decision.chapters.join(", ") }) : "",
    decision.secrets.length ? t("bibleStudio.decisions.secrets", { list: decision.secrets.join(", ") }) : "",
    decision.files.length ? t("bibleStudio.decisions.files", { list: decision.files.join(", ") }) : "",
  ].filter(Boolean).join("; ");
  return (
    <li data-decision={decision.id} data-decision-status={decision.status} className={cn("space-y-1.5 rounded-xl border p-3", locked && "border-emerald-600/50 bg-emerald-500/5")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium"><span className="text-xs font-normal text-muted-foreground">{decision.id}</span> {decision.decision}</p>
        <span className={cn("inline-flex items-center gap-1 text-xs font-medium", locked ? "text-emerald-800 dark:text-emerald-300" : "text-muted-foreground")}>
          {locked ? <Lock className="h-3.5 w-3.5" aria-hidden="true" /> : <LockOpen className="h-3.5 w-3.5" aria-hidden="true" />}
          {t(locked ? "bibleStudio.decisions.locked" : "bibleStudio.decisions.open")}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {[decision.date, t("bibleStudio.decisions.by", { who: t(`bibleStudio.decisions.who.${decision.by}`) })].filter(Boolean).join(" · ")}
      </p>
      {decision.reason && <p className="text-xs text-muted-foreground">{t("bibleStudio.decisions.why", { reason: decision.reason })}</p>}
      {scope && <p className="text-xs text-muted-foreground">{t("bibleStudio.decisions.covers", { scope })}</p>}
      {decision.avoid.length > 0 && <p className="text-xs text-muted-foreground">{t("bibleStudio.decisions.avoid", { phrases: decision.avoid.map((phrase) => `«${phrase}»`).join(", ") })}</p>}
      <Button type="button" size="sm" variant={locked ? "outline" : "default"} disabled={busy} onClick={onToggle} aria-label={t(locked ? "bibleStudio.decisions.unlockFor" : "bibleStudio.decisions.lockFor", { id: decision.id })}>
        {locked ? <LockOpen className="h-4 w-4" aria-hidden="true" /> : <Lock className="h-4 w-4" aria-hidden="true" />}
        {t(locked ? "bibleStudio.decisions.unlock" : "bibleStudio.decisions.lock")}
      </Button>
    </li>
  );
}

function CaptureForm({ busy, onCapture }: { busy: boolean; onCapture: (input: { decision: string; reason: string; chapters: number[]; avoid: string[] }, lock: boolean) => Promise<boolean> }) {
  const { t } = useTranslation();
  const id = useId();
  const [form, setForm] = useState({ decision: "", reason: "", chapters: "", avoid: "" });
  const submit = async (lock: boolean) => {
    if (!form.decision.trim()) return;
    if (await onCapture({ decision: form.decision, reason: form.reason, chapters: numbersOf(form.chapters), avoid: linesOf(form.avoid) }, lock)) setForm({ decision: "", reason: "", chapters: "", avoid: "" });
  };
  return (
    <form className="space-y-3 rounded-xl border border-dashed p-3" aria-labelledby={`${id}-title`} onSubmit={(event) => { event.preventDefault(); void submit(false); }}>
      <h4 id={`${id}-title`} className="text-sm font-semibold">{t("bibleStudio.decisions.add.title")}</h4>
      <div className="space-y-1">
        <Label htmlFor={`${id}-decision`} className="text-xs font-medium">{t("bibleStudio.decisions.add.decision")}</Label>
        <AutoTextarea id={`${id}-decision`} value={form.decision} minRows={2} maxHeight={200} disabled={busy} onChange={(event) => setForm({ ...form, decision: event.target.value })} className="text-sm" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-reason`} className="text-xs font-medium">{t("bibleStudio.decisions.add.reason")}</Label>
          <Input id={`${id}-reason`} value={form.reason} disabled={busy} onChange={(event) => setForm({ ...form, reason: event.target.value })} className="h-9" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-chapters`} className="text-xs font-medium">{t("bibleStudio.decisions.add.chapters")}</Label>
          <Input id={`${id}-chapters`} inputMode="numeric" aria-describedby={`${id}-chapters-hint`} value={form.chapters} disabled={busy} onChange={(event) => setForm({ ...form, chapters: event.target.value })} className="h-9" />
          <p id={`${id}-chapters-hint`} className="text-xs text-muted-foreground">{t("bibleStudio.decisions.add.chaptersHint")}</p>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-avoid`} className="text-xs font-medium">{t("bibleStudio.decisions.add.avoid")}</Label>
        <AutoTextarea id={`${id}-avoid`} aria-describedby={`${id}-avoid-hint`} value={form.avoid} minRows={2} maxHeight={160} disabled={busy} onChange={(event) => setForm({ ...form, avoid: event.target.value })} className="text-sm" />
        <p id={`${id}-avoid-hint`} className="text-xs text-muted-foreground">{t("bibleStudio.decisions.add.avoidHint")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="outline" disabled={busy || !form.decision.trim()}>{t("bibleStudio.decisions.add.capture")}</Button>
        <Button type="button" size="sm" disabled={busy || !form.decision.trim()} onClick={() => void submit(true)}><Lock className="h-4 w-4" aria-hidden="true" />{t("bibleStudio.decisions.add.captureLocked")}</Button>
      </div>
    </form>
  );
}

function QuestionsBlock({ questions, busy, onAsk, onAnswer }: { questions: readonly BibleQuestion[]; busy: boolean; onAsk: (text: string) => Promise<boolean>; onAnswer: (question: BibleQuestion, answer: string, asDecision: boolean) => Promise<boolean> }) {
  const { t } = useTranslation();
  const id = useId();
  const [asking, setAsking] = useState("");
  return (
    <div className="space-y-3 border-t pt-4">
      <h4 className="text-sm font-semibold">{t("bibleStudio.sections.questions")}</h4>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("bibleStudio.questions.intro")}</p>
      {questions.length === 0
        ? <p className="text-sm text-muted-foreground">{t("bibleStudio.questions.empty")}</p>
        : <ul data-bible-questions className="space-y-2">{questions.map((question) => <QuestionRow key={question.id} question={question} busy={busy} onAnswer={onAnswer} />)}</ul>}
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (asking.trim()) void onAsk(asking).then((ok) => { if (ok) setAsking(""); }); }}>
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={`${id}-ask`} className="text-xs font-medium">{t("bibleStudio.questions.askLabel")}</Label>
          <Input id={`${id}-ask`} value={asking} disabled={busy} onChange={(event) => setAsking(event.target.value)} className="h-9" />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={busy || !asking.trim()}>{t("bibleStudio.questions.askSend")}</Button>
      </form>
    </div>
  );
}

function QuestionRow({ question, busy, onAnswer }: { question: BibleQuestion; busy: boolean; onAnswer: (question: BibleQuestion, answer: string, asDecision: boolean) => Promise<boolean> }) {
  const { t } = useTranslation();
  const id = useId();
  const [answer, setAnswer] = useState("");
  const [asDecision, setAsDecision] = useState(false);
  const open = question.status === "open";
  return (
    <li data-question={question.id} data-question-status={question.status} className="space-y-1.5 rounded-xl border p-3">
      <p className="text-sm font-medium"><span className="text-xs font-normal text-muted-foreground">{question.id}</span> {question.question}</p>
      <p className="text-xs text-muted-foreground">{[question.date, t("bibleStudio.decisions.by", { who: t(`bibleStudio.decisions.who.${question.by}`) }), t(open ? "bibleStudio.questions.openLabel" : "bibleStudio.questions.answered")].filter(Boolean).join(" · ")}</p>
      {!open && <p className="text-sm">{t("bibleStudio.questions.answeredWith", { answer: question.answer })}</p>}
      {open && (
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) void onAnswer(question, answer, asDecision); }}>
          <div className="space-y-1">
            <Label htmlFor={`${id}-answer`} className="text-xs font-medium">{t("bibleStudio.questions.answerFor", { id: question.id })}</Label>
            <AutoTextarea id={`${id}-answer`} value={answer} minRows={2} maxHeight={200} disabled={busy} onChange={(event) => setAnswer(event.target.value)} className="text-sm" />
          </div>
          <label className="flex min-h-6 items-center gap-2 text-xs [@media(pointer:coarse)]:min-h-11">
            <input type="checkbox" checked={asDecision} disabled={busy} onChange={(event) => setAsDecision(event.target.checked)} className="h-4 w-4" />
            {t("bibleStudio.questions.alsoDecision")}
          </label>
          <Button type="submit" size="sm" disabled={busy || !answer.trim()}>{t("bibleStudio.questions.send")}</Button>
        </form>
      )}
    </li>
  );
}

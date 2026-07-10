import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ClipboardCheck, Info, Loader2, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { parseDocument, stringify } from "yaml";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useRegisterPageSave } from "@/store/saveStore";
import { useRegisterProseEditor } from "@/components/editor/useRegisterProseEditor";
import { useProseAssist } from "@/components/editor/useProseAssist";
import { resolveBookToken } from "@/types/settings";
import { createOrUpdateTextFile, loadFileContent } from "@/github/githubClient";
import { appendAssistantNote } from "@/assistant/service";
import { completeTextRouted } from "@/assistant/router";
import { defaultEvaluationCriteria, defaultEvaluationGuidelinesMarkdown, EVALUATION_GUIDELINES_PATH } from "@/narrarium/defaultGuidelines";

interface Criterion {
  key: string;
  description: string;
}

function parseEvaluationDoc(raw: string): { frontmatter: Record<string, unknown>; body: string; criteria: Criterion[] } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw, criteria: [] };
  const frontmatter = (parseDocument(match[1]).toJSON() as Record<string, unknown> | null) ?? {};
  const rawCriteria = frontmatter.criteria;
  const criteria = rawCriteria && typeof rawCriteria === "object" && !Array.isArray(rawCriteria)
    ? Object.entries(rawCriteria as Record<string, unknown>).map(([key, value]) => ({
        key,
        description: value && typeof value === "object" && typeof (value as Record<string, unknown>).description === "string"
          ? String((value as Record<string, unknown>).description)
          : String(value ?? ""),
      }))
    : [];
  return { frontmatter, body: match[2].replace(/^\s*\n/, ""), criteria };
}

function buildEvaluationDoc(frontmatter: Record<string, unknown>, criteria: Criterion[], body: string): string {
  const nextFrontmatter = {
    ...frontmatter,
    criteria: Object.fromEntries(criteria.filter((entry) => entry.key.trim()).map((entry) => [entry.key.trim(), { description: entry.description.trim() }])),
  };
  return `---\n${stringify(nextFrontmatter).trim()}\n---\n\n${body.trim()}\n`;
}

function normalizeCriterionKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9à-ÿ]+/gi, "_").replace(/^_+|_+$/g, "");
}

function criteriaFromDefaults(language: string): Criterion[] {
  return Object.entries(defaultEvaluationCriteria(language)).map(([key, description]) => ({ key, description }));
}

function EvaluationCriterionEditor({
  value,
  onChange,
  settings,
  pagePrompt,
  placeholder,
  onSaveSummary,
}: {
  value: string;
  onChange: (value: string) => void;
  settings: Parameters<typeof completeTextRouted>[0];
  pagePrompt: string;
  placeholder: string;
  onSaveSummary: (summary: string) => Promise<void>;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const assist = useProseAssist({
    textareaRef: ref,
    getBody: () => value,
    setBody: onChange,
    buildSource: () => null,
    improveText: async (body, selection) => completeTextRouted(settings, [
      { role: "system", content: `${pagePrompt}\nReturn only the improved criterion description.` },
      { role: "user", content: `Current criterion description:\n${body}\n\nSelected text:\n${selection ?? body}` },
    ], "review", { label: "evaluation-style:improve-criterion" }),
    summarizeText: async (body, selection) => completeTextRouted(settings, [
      { role: "system", content: `${pagePrompt}\nSummarize this criterion description into one concise, actionable rule. Return only the summary.` },
      { role: "user", content: selection ?? body },
    ], "chat-resume", { label: "evaluation-style:summarize-criterion" }),
    onSaveSummary,
  });
  useRegisterProseEditor(ref, { improve: assist.improve, summarize: assist.summarize, synonym: () => undefined });
  return <><AutoTextarea ref={ref} value={value} onChange={(event) => onChange(event.target.value)} className="min-h-24 text-sm leading-6" placeholder={placeholder} />{assist.dialogs}</>;
}

export function EvaluationStylePage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, reload, loading: structureLoading } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({});
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [body, setBody] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const language = structure?.language ?? settings.ui.language;

  const pagePrompt = useMemo(() => language.startsWith("it")
    ? "Questa è la pagina Stile di valutazione di Narrarium. Il testo selezionato è un contratto editoriale che definisce come l'AI deve valutare capitoli e paragrafi. Migliora chiarezza, severità critica, struttura e utilità pratica senza inventare requisiti incoerenti. Mantieni markdown valido."
    : "This is Narrarium's Evaluation Style page. The selected text is an editorial contract defining how AI should evaluate chapters and paragraphs. Improve clarity, critical rigor, structure, and practical usefulness without inventing incoherent requirements. Keep valid markdown.", [language]);

  const proseAssist = useProseAssist({
    textareaRef: bodyRef,
    getBody: () => body,
    setBody,
    buildSource: () => null,
    improveText: async (currentBody, selection) => completeTextRouted(settings, [
      { role: "system", content: `${pagePrompt}\nReturn only the improved text.` },
      { role: "user", content: `Full evaluation-style document body:\n${currentBody}\n\nSelected text to improve:\n${selection ?? currentBody}` },
    ], "review", { label: "evaluation-style:improve" }),
    summarizeText: async (currentBody, selection) => completeTextRouted(settings, [
      { role: "system", content: `${pagePrompt}\nSummarize the selected text into concise, actionable markdown rules. Return only the summary.` },
      { role: "user", content: selection ?? currentBody },
    ], "chat-resume", { label: "evaluation-style:summarize" }),
    onSaveSummary: async (summary) => {
      if (!book || !token) return;
      await appendAssistantNote({ token, owner: book.owner, repo: book.repo, branch, path: "notes.md", noteBody: `## Evaluation style summary\n\n${summary}` });
      toast({ title: t("evaluationStyle.summarySaved") });
    },
  });
  useRegisterProseEditor(bodyRef, { improve: proseAssist.improve, summarize: proseAssist.summarize, synonym: () => undefined });

  useEffect(() => {
    if (!book || !token) return;
    setLoading(true);
    loadFileContent(token, book.owner, book.repo, EVALUATION_GUIDELINES_PATH, branch)
      .then((raw) => {
        const parsed = parseEvaluationDoc(raw.trim() ? raw : defaultEvaluationGuidelinesMarkdown(language));
        const nextCriteria = parsed.criteria.length ? parsed.criteria : criteriaFromDefaults(language);
        setFrontmatter(parsed.frontmatter);
        setCriteria(nextCriteria);
        setBody(parsed.body);
        setSaved(raw.trim() && parsed.criteria.length ? buildEvaluationDoc(parsed.frontmatter, nextCriteria, parsed.body) : "");
      })
      .catch(() => {
        const parsed = parseEvaluationDoc(defaultEvaluationGuidelinesMarkdown(language));
        setFrontmatter(parsed.frontmatter);
        setCriteria(parsed.criteria);
        setBody(parsed.body);
        setSaved("");
      })
      .finally(() => setLoading(false));
  }, [book, token, branch, language]);

  const current = buildEvaluationDoc(frontmatter, criteria, body);
  const dirty = current !== saved;
  useRegisterPageSave({ dirty, enabled: Boolean(book && token), onSave: () => save() });

  async function save() {
    if (!book || !token) return;
    setSaving(true);
    try {
      await createOrUpdateTextFile(token, book.owner, book.repo, branch, EVALUATION_GUIDELINES_PATH, current, `Update ${EVALUATION_GUIDELINES_PATH}`);
      setSaved(current);
      toast({ title: t("common.saved") });
      reload();
    } catch (err) {
      toast({ title: t("common.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function addCriterion() {
    setCriteria((currentCriteria) => [...currentCriteria, { key: `criterion_${currentCriteria.length + 1}`, description: "" }]);
  }

  function updateCriterion(index: number, patch: Partial<Criterion>) {
    setCriteria((currentCriteria) => currentCriteria.map((criterion, position) => position === index ? { ...criterion, ...patch } : criterion));
  }

  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;
  if (structureLoading && !structure) return <div className="flex min-h-[40vh] items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>;

  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-hidden rounded-3xl border bg-gradient-to-br from-primary/15 via-card to-card shadow-sm">
        <div className="flex flex-col gap-5 p-6 sm:p-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="secondary"><ClipboardCheck className="mr-1.5 h-3.5 w-3.5" />{t("evaluationStyle.badge")}</Badge>
              <Badge variant="outline">{language}</Badge>
              <Badge variant="outline">{t("evaluationStyle.criteriaCount", { count: criteria.length })}</Badge>
            </div>
            <h1 className="font-serif text-3xl font-semibold tracking-tight sm:text-4xl">{t("evaluationStyle.title")}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{t("evaluationStyle.intro")}</p>
          </div>
          <Button size="lg" onClick={() => void save()} disabled={saving || !dirty} className="shrink-0">
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {t("common.save")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t bg-background/35 px-6 py-3 text-xs text-muted-foreground sm:px-8">
          <span className="font-mono">{EVALUATION_GUIDELINES_PATH}</span>
          <span>{t("evaluationStyle.criticalHint")}</span>
        </div>
      </div>

      <div className="rounded-2xl border bg-muted/20 p-4 text-sm text-muted-foreground">
        <div className="flex gap-3"><Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><p>{t("evaluationStyle.hint")}</p></div>
        <p className="mt-3 flex items-center gap-2 text-xs"><Sparkles className="h-3.5 w-3.5 text-primary" />{t("evaluationStyle.aiHint")}</p>
      </div>

      <section className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div><h2 className="text-lg font-semibold">{t("evaluationStyle.criteriaTitle")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("evaluationStyle.criteriaHint")}</p></div>
          <Button variant="outline" size="sm" onClick={addCriterion}><Plus className="mr-1.5 h-4 w-4" />{t("evaluationStyle.addCriterion")}</Button>
        </div>
        {criteria.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {criteria.map((criterion, index) => (
              <div key={`${criterion.key}-${index}`} className="rounded-2xl border bg-background/70 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Input value={criterion.key} onChange={(event) => updateCriterion(index, { key: normalizeCriterionKey(event.target.value) })} className="font-mono text-sm" aria-label={t("evaluationStyle.criterionName")} />
                  <Button variant="ghost" size="icon" onClick={() => setCriteria((currentCriteria) => currentCriteria.filter((_, position) => position !== index))} aria-label={t("evaluationStyle.removeCriterion")}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </div>
                <EvaluationCriterionEditor
                  value={criterion.description}
                  onChange={(value) => updateCriterion(index, { description: value })}
                  settings={settings}
                  pagePrompt={pagePrompt}
                  placeholder={t("evaluationStyle.criterionDescription")}
                  onSaveSummary={async (summary) => {
                    if (!book || !token) return;
                    await appendAssistantNote({ token, owner: book.owner, repo: book.repo, branch, path: "notes.md", noteBody: `## Evaluation criterion: ${criterion.key}\n\n${summary}` });
                    toast({ title: t("evaluationStyle.summarySaved") });
                  }}
                />
              </div>
            ))}
          </div>
        ) : <div className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">{t("evaluationStyle.noCriteria")}</div>}
      </section>

      <section className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
        <div className="mb-4"><h2 className="text-lg font-semibold">{t("evaluationStyle.bodyTitle")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("evaluationStyle.bodyHint")}</p></div>
        {loading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</div> : <AutoTextarea ref={bodyRef} value={body} onChange={(event) => setBody(event.target.value)} className="min-h-[55vh] font-mono text-sm leading-7" placeholder={t("evaluationStyle.placeholder")} />}
      </section>
      {proseAssist.dialogs}
    </div>
  );
}

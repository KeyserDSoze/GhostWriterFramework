import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ClipboardCheck, Loader2, Save } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useRegisterPageSave } from "@/store/saveStore";
import { resolveBookToken } from "@/types/settings";
import { createOrUpdateTextFile, loadFileContent } from "@/github/githubClient";
import { defaultEvaluationGuidelinesMarkdown, EVALUATION_GUIDELINES_PATH } from "@/narrarium/defaultGuidelines";

export function EvaluationStylePage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, reload, loading: structureLoading } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const language = structure?.language ?? settings.ui.language;

  useEffect(() => {
    if (!book || !token) return;
    setLoading(true);
    loadFileContent(token, book.owner, book.repo, EVALUATION_GUIDELINES_PATH, branch)
      .then((raw) => {
        const next = raw.trim() ? raw : defaultEvaluationGuidelinesMarkdown(language);
        setContent(next);
        setSaved(next);
      })
      .catch(() => {
        const next = defaultEvaluationGuidelinesMarkdown(language);
        setContent(next);
        setSaved("");
      })
      .finally(() => setLoading(false));
  }, [book, token, branch, language]);

  async function save() {
    if (!book || !token) return;
    setSaving(true);
    try {
      const next = content.trim() ? `${content.trim()}\n` : `${defaultEvaluationGuidelinesMarkdown(language).trim()}\n`;
      await createOrUpdateTextFile(token, book.owner, book.repo, branch, EVALUATION_GUIDELINES_PATH, next, `Update ${EVALUATION_GUIDELINES_PATH}`);
      setContent(next);
      setSaved(next);
      toast({ title: t("common.saved") });
      reload();
    } catch (err) {
      toast({ title: t("common.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const dirty = content !== saved;
  useRegisterPageSave({ dirty, enabled: Boolean(book && token), onSave: () => save() });

  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;
  if (structureLoading && !structure) return <div className="flex min-h-[40vh] items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold"><ClipboardCheck className="h-5 w-5" />{t("evaluationStyle.title")}</h1>
          <p className="text-xs text-muted-foreground">{EVALUATION_GUIDELINES_PATH}</p>
        </div>
        <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>{saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}{t("common.save")}</Button>
      </div>
      <p className="text-sm text-muted-foreground">{t("evaluationStyle.intro")}</p>
      <p className="text-xs text-muted-foreground">{t("evaluationStyle.hint")}</p>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (
        <AutoTextarea value={content} onChange={(e) => setContent(e.target.value)} className="min-h-[60vh] font-mono text-sm leading-7" placeholder={t("evaluationStyle.placeholder")} />
      )}
    </div>
  );
}

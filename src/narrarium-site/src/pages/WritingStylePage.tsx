import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, PenLine, Save } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { resolveBookToken } from "@/types/settings";
import { createOrUpdateTextFile, loadFileContent } from "@/github/githubClient";

export function WritingStylePage() {
  const { bookId, chapterId } = useParams<{ bookId: string; chapterId?: string }>();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const chapter = chapterId ? structure?.chapters.find((c) => c.slug === chapterId) : undefined;

  const path = chapter ? `${chapter.path}/writing-style.md` : (structure?.globalWritingStylePath ?? "guidelines/writing-style.md");
  const [body, setBody] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!book || !token) return;
    setLoading(true);
    loadFileContent(token, book.owner, book.repo, path, branch)
      .then((raw) => { setBody(raw); setSaved(raw); })
      .catch(() => { setBody(""); setSaved(""); })
      .finally(() => setLoading(false));
  }, [book, token, branch, path]);

  async function save() {
    if (!book || !token) return;
    setSaving(true);
    try {
      await createOrUpdateTextFile(token, book.owner, book.repo, branch, path, body, `Update ${path}`);
      setSaved(body);
      toast({ title: t("common.saved") });
      reload();
    } catch (err) {
      toast({ title: t("common.saveFailed"), description: String(err), variant: "destructive" });
    } finally { setSaving(false); }
  }

  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold"><PenLine className="h-5 w-5" />{chapter ? t("writingStyle.chapterTitle", { slug: chapter.slug }) : t("writingStyle.title")}</h1>
          <p className="text-xs text-muted-foreground">{path}</p>
        </div>
        <Button size="sm" onClick={() => void save()} disabled={saving || body === saved}>{saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}{t("common.save")}</Button>
      </div>
      <p className="text-sm text-muted-foreground">{chapter ? t("writingStyle.chapterIntro") : t("writingStyle.intro")}</p>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (
        <AutoTextarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[55vh] text-sm leading-7" placeholder={t("writingStyle.placeholder")} />
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { parseDocument, stringify } from "yaml";
import { Loader2, Quote, Save } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useRegisterPageSave } from "@/store/saveStore";
import { resolveBookToken } from "@/types/settings";
import { createOrUpdateTextFile, loadFileContent } from "@/github/githubClient";
import { PUNCTUATION_STYLE_PATH, defaultPunctuationStyleBody, defaultPunctuationStyleTitle } from "@/narrarium/defaultGuidelines";

function splitMarkdownDoc(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  try {
    return { frontmatter: (parseDocument(match[1]).toJSON() as Record<string, unknown>) ?? {}, body: match[2].replace(/^\s*\n/, "") };
  } catch {
    return { frontmatter: {}, body: match[2].replace(/^\s*\n/, "") };
  }
}

function buildMarkdownDoc(frontmatter: Record<string, unknown>, body: string): string {
  const frontmatterText = stringify(frontmatter).trim();
  if (!frontmatterText || frontmatterText === "{}") return `${body.trim()}\n`;
  return `---\n${frontmatterText}\n---\n\n${body.trim()}\n`;
}

export function PunctuationStylePage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";

  const path = structure?.globalPunctuationStylePath ?? PUNCTUATION_STYLE_PATH;
  const language = structure?.language ?? settings.ui.language;
  const defaultFrontmatter = { type: "punctuation-style", scope: "book", title: defaultPunctuationStyleTitle(language) };
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({});
  const [body, setBody] = useState("");
  const [savedFrontmatter, setSavedFrontmatter] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!book || !token) return;
    setLoading(true);
    loadFileContent(token, book.owner, book.repo, path, branch)
      .then((raw) => {
        const parsed = splitMarkdownDoc(raw);
        setFrontmatter(parsed.frontmatter);
        setBody(parsed.body);
        setSavedFrontmatter(parsed.frontmatter);
        setSaved(parsed.body);
      })
      .catch(() => {
        // No file yet: seed with the default punctuation contract. Saving creates it.
        setFrontmatter(defaultFrontmatter);
        setBody(defaultPunctuationStyleBody(language));
        setSavedFrontmatter({});
        setSaved("");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, token, branch, path, language]);

  async function save() {
    if (!book || !token) return;
    setSaving(true);
    try {
      await createOrUpdateTextFile(token, book.owner, book.repo, branch, path, buildMarkdownDoc(frontmatter, body), `Update ${path}`);
      setSavedFrontmatter(frontmatter);
      setSaved(body);
      toast({ title: t("common.saved") });
      reload();
    } catch (err) {
      toast({ title: t("common.saveFailed"), description: String(err), variant: "destructive" });
    } finally { setSaving(false); }
  }

  const dirty = body !== saved || JSON.stringify(frontmatter) !== JSON.stringify(savedFrontmatter);
  useRegisterPageSave({ dirty, enabled: Boolean(book && token), onSave: () => save() });

  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;

  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-hidden rounded-3xl border bg-gradient-to-br from-primary/15 via-card to-card shadow-sm">
        <div className="flex flex-col gap-5 p-6 sm:p-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="secondary"><Quote className="mr-1.5 h-3.5 w-3.5" />{t("punctuationStyle.badge")}</Badge>
              <Badge variant="outline">{language}</Badge>
            </div>
            <h1 className="font-serif text-3xl font-semibold tracking-tight sm:text-4xl">{t("punctuationStyle.title")}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{t("punctuationStyle.intro")}</p>
          </div>
          <Button size="lg" onClick={() => void save()} disabled={saving || !dirty} className="shrink-0">{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{t("common.save")}</Button>
        </div>
        <div className="border-t bg-background/35 px-6 py-3 text-xs text-muted-foreground sm:px-8"><span className="font-mono">{path}</span></div>
      </div>
      <section className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
        <p className="mb-4 text-sm text-muted-foreground">{t("punctuationStyle.editorHint")}</p>
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <AutoTextarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[55vh] text-sm leading-7" placeholder={t("punctuationStyle.placeholder")} />}
      </section>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { parseDocument, stringify } from "yaml";
import { Loader2, PenLine, Save } from "lucide-react";
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

const DEFAULT_WRITING_STYLE = `# Writing Style

## Core Contract

- Preserve established canon, chronology, names, and visible facts.
- Write concrete scene prose with clear viewpoint, sensory grounding, and purposeful rhythm.
- Keep dialogue readable: each spoken line should have clear speaker ownership through voice, context, or restrained action beats.
- Prefer specific verbs and images over generic summary.
- Improve clarity, tension, pacing, and emotional precision without changing story intent.

## Revision Rules

- Do not invent new canon while revising unless the user explicitly asks.
- Keep the same language as the source text unless a task explicitly requests translation.
- Return only the requested prose or markdown body, without commentary or code fences.
`;

function splitMarkdownDoc(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  try {
    return { frontmatter: (parseDocument(match[1]).toJSON() as Record<string, unknown>) ?? {}, body: match[2] };
  } catch {
    return { frontmatter: {}, body: match[2] };
  }
}

function buildMarkdownDoc(frontmatter: Record<string, unknown>, body: string): string {
  const frontmatterText = stringify(frontmatter).trim();
  if (!frontmatterText || frontmatterText === "{}") return `${body.trim()}\n`;
  return `---\n${frontmatterText}\n---\n\n${body.trim()}\n`;
}

export function WritingStylePage() {
  const { bookId, chapterId } = useParams<{ bookId: string; chapterId?: string }>();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const chapter = chapterId ? structure?.chapters.find((c) => c.slug === chapterId) : undefined;

  const path = chapter ? `${chapter.path}/writing-style.md` : (structure?.globalWritingStylePath ?? "writing-style.md");
  const defaultFrontmatter = chapter
    ? { type: "writing-style", scope: "chapter", chapter: `chapter:${chapter.slug}`, title: `${chapter.title} Style` }
    : { type: "writing-style", scope: "book", title: "Writing Style" };
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
        setFrontmatter(defaultFrontmatter);
        setBody(DEFAULT_WRITING_STYLE);
        setSavedFrontmatter({});
        setSaved("");
      })
      .finally(() => setLoading(false));
  }, [book, token, branch, path]);

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
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold"><PenLine className="h-5 w-5" />{chapter ? t("writingStyle.chapterTitle", { slug: chapter.slug }) : t("writingStyle.title")}</h1>
          <p className="text-xs text-muted-foreground">{path}</p>
        </div>
        <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>{saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}{t("common.save")}</Button>
      </div>
      <p className="text-sm text-muted-foreground">{chapter ? t("writingStyle.chapterIntro") : t("writingStyle.intro")}</p>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (
        <AutoTextarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[55vh] text-sm leading-7" placeholder={t("writingStyle.placeholder")} />
      )}
    </div>
  );
}

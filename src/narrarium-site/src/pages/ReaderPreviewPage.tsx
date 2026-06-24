import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, ArrowLeft, BookOpen } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useSettingsStore } from "@/store/settingsStore";
import { loadBinaryFileContent, loadFileContent } from "@/github/githubClient";
import { resolveBookToken } from "@/types/settings";
import type { Chapter, Paragraph } from "@/types/book";

interface ReaderParagraph {
  paragraph: Paragraph;
  html: string;
  imageUrl?: string;
}

interface ReaderChapter {
  chapter: Chapter;
  html: string;
  imageUrl?: string;
  paragraphs: ReaderParagraph[];
}

type ReaderTheme = "paper" | "sepia" | "dark";

export function ReaderPreviewPage() {
  const { t } = useTranslation();
  const { bookId } = useParams<{ bookId: string }>();
  const { settings } = useSettingsStore();
  const { book, structure, loading, error, reload } = useBookStructure(bookId);
  const { branch } = useWorkingBranch(bookId);
  const [chapters, setChapters] = useState<ReaderChapter[]>([]);
  const [selected, setSelected] = useState("all");
  const [theme, setTheme] = useState<ReaderTheme>("paper");
  const [fontSize, setFontSize] = useState("18");
  const [busy, setBusy] = useState(false);

  const token = book ? resolveBookToken(book, settings) : "";

  useEffect(() => {
    if (!book || !structure || !token) return;
    let active = true;
    const objectUrls: string[] = [];
    setBusy(true);
    void loadReaderChapters({ token, owner: book.owner, repo: book.repo, branch, chapters: structure.chapters, objectUrls })
      .then((loaded) => { if (active) setChapters(loaded); })
      .finally(() => { if (active) setBusy(false); });
    return () => {
      active = false;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [book, branch, structure, token]);

  const visibleChapters = useMemo(() => selected === "all" ? chapters : chapters.filter((entry) => entry.chapter.slug === selected), [chapters, selected]);

  if (!book) return <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;
  if (loading && !structure) return <ReaderSkeleton />;
  if (error && !structure) return <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription className="flex flex-wrap items-center gap-3"><span>{error}</span><Button size="sm" variant="outline" onClick={() => reload()}>{t("common.reloadBook")}</Button></AlertDescription></Alert>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2"><Link to={`/app/books/${book.id}`}><ArrowLeft className="mr-1 h-4 w-4" />{book.name}</Link></Button>
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{t("reader.title")}</h1>
          <p className="text-muted-foreground">{t("reader.description")}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("reader.allChapters")}</SelectItem>
              {chapters.map((entry) => <SelectItem key={entry.chapter.slug} value={entry.chapter.slug}>{entry.chapter.title}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={theme} onValueChange={(value) => setTheme(value as ReaderTheme)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="paper">{t("reader.paper")}</SelectItem>
              <SelectItem value="sepia">{t("reader.sepia")}</SelectItem>
              <SelectItem value="dark">{t("reader.dark")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={fontSize} onValueChange={setFontSize}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="16">16px</SelectItem>
              <SelectItem value="18">18px</SelectItem>
              <SelectItem value="20">20px</SelectItem>
              <SelectItem value="22">22px</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {busy ? <ReaderSkeleton /> : (
        <article className={readerClass(theme)} style={{ fontSize: `${fontSize}px` }}>
          <div className="mx-auto max-w-3xl space-y-16 px-5 py-10 leading-8 sm:px-10">
            {visibleChapters.map((entry) => (
              <section key={entry.chapter.slug} className="space-y-8">
                <header className="space-y-4 text-center">
                  <BookOpen className="mx-auto h-6 w-6 opacity-60" />
                  <h2 className="font-serif text-4xl font-semibold">{entry.chapter.title}</h2>
                  {entry.imageUrl && <img src={entry.imageUrl} alt={entry.chapter.title} className="mx-auto max-h-[70vh] rounded-xl object-contain" />}
                </header>
                {entry.html && <div className="doc-prose" dangerouslySetInnerHTML={{ __html: entry.html }} />}
                {entry.paragraphs.map((paragraph, index) => (
                  <section key={paragraph.paragraph.path} className="space-y-5">
                    {index > 0 && <p className="text-center opacity-70">#</p>}
                    {paragraph.imageUrl && <img src={paragraph.imageUrl} alt={paragraph.paragraph.title} className="mx-auto max-h-[70vh] rounded-xl object-contain" />}
                    <div className="doc-prose" dangerouslySetInnerHTML={{ __html: paragraph.html }} />
                  </section>
                ))}
              </section>
            ))}
          </div>
        </article>
      )}
    </div>
  );
}

async function loadReaderChapters(input: { token: string; owner: string; repo: string; branch: string; chapters: Chapter[]; objectUrls: string[] }): Promise<ReaderChapter[]> {
  const { marked } = await import("marked");
  return Promise.all(input.chapters.map(async (chapter) => {
    const rawChapter = await loadFileContent(input.token, input.owner, input.repo, `${chapter.path}/chapter.md`, input.branch).catch(() => "");
    const chapterImageUrl = chapter.imagePath ? await loadImageUrl(input, chapter.imagePath) : undefined;
    const paragraphs = await Promise.all(chapter.paragraphs.map(async (paragraph) => ({
      paragraph,
      html: marked.parse(stripFrontmatter(await loadFileContent(input.token, input.owner, input.repo, paragraph.path, input.branch).catch(() => "")), { async: false }) as string,
      imageUrl: paragraph.imagePath ? await loadImageUrl(input, paragraph.imagePath) : undefined,
    })));
    return { chapter, html: marked.parse(stripFrontmatter(rawChapter), { async: false }) as string, imageUrl: chapterImageUrl, paragraphs };
  }));
}

async function loadImageUrl(input: { token: string; owner: string; repo: string; branch: string; objectUrls: string[] }, path: string): Promise<string | undefined> {
  const bytes = await loadBinaryFileContent(input.token, input.owner, input.repo, path, input.branch).catch(() => null);
  if (!bytes) return undefined;
  const url = URL.createObjectURL(new Blob([bytesToArrayBuffer(bytes)], { type: imageMimeType(path) }));
  input.objectUrls.push(url);
  return url;
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---[\s\S]*?---\s*/, "").trim();
}

function readerClass(theme: ReaderTheme): string {
  if (theme === "dark") return "rounded-3xl border bg-zinc-950 text-zinc-100 shadow-sm";
  if (theme === "sepia") return "rounded-3xl border bg-[#f4ecd8] text-[#2d2215] shadow-sm";
  return "rounded-3xl border bg-card text-card-foreground shadow-sm";
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function imageMimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/png";
}

function ReaderSkeleton() {
  return <div className="space-y-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-96 w-full rounded-3xl" /></div>;
}

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, ImageIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useSettingsStore } from "@/store/settingsStore";
import { loadBinaryFileContent } from "@/github/githubClient";
import { resolveBookToken } from "@/types/settings";
import { AssetImageDialog } from "@/components/book/AssetImageDialog";
import type { AssetSubjectKind } from "@/assets/assetImages";

type AssetFilter = "all" | "missing" | "book" | "chapter" | "paragraph";

interface AssetCardItem {
  key: string;
  kind: AssetSubjectKind;
  title: string;
  chapterSlug?: string;
  paragraphSlug?: string;
  textPath?: string;
  resumePath?: string;
  imagePath?: string;
  promptPath?: string;
}

export function AssetGalleryPage() {
  const { t } = useTranslation();
  const { bookId } = useParams<{ bookId: string }>();
  const { settings } = useSettingsStore();
  const { book, structure, loading, error, reload } = useBookStructure(bookId);
  const { branch } = useWorkingBranch(bookId);
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [previews, setPreviews] = useState<Record<string, string>>({});

  const token = book ? resolveBookToken(book, settings) : "";
  const cards = useMemo<AssetCardItem[]>(() => {
    if (!book || !structure) return [];
    const items: AssetCardItem[] = [{
      key: "book-cover",
      kind: "book",
      title: structure.title || book.name,
      textPath: "book.md",
      resumePath: "resumes/total.md",
      imagePath: structure.bookCoverPath,
      promptPath: structure.bookCoverPromptPath,
    }];
    structure.chapters.forEach((chapter) => {
      items.push({
        key: `chapter-${chapter.slug}`,
        kind: "chapter",
        title: chapter.title,
        chapterSlug: chapter.slug,
        textPath: `${chapter.path}/chapter.md`,
        resumePath: `resumes/chapters/${chapter.slug}.md`,
        imagePath: chapter.imagePath,
        promptPath: chapter.imagePromptPath,
      });
      chapter.paragraphs.forEach((paragraph) => {
        const paragraphSlug = paragraph.path.split("/").pop()?.replace(/\.md$/i, "") ?? paragraph.number;
        items.push({
          key: `paragraph-${chapter.slug}-${paragraphSlug}`,
          kind: "paragraph",
          title: `${chapter.title} / ${paragraph.title}`,
          chapterSlug: chapter.slug,
          paragraphSlug,
          textPath: paragraph.path,
          imagePath: paragraph.imagePath,
          promptPath: paragraph.imagePromptPath,
        });
      });
    });
    return items;
  }, [book, structure]);

  useEffect(() => {
    if (!book || !token) return;
    const urls: string[] = [];
    let active = true;
    void Promise.all(cards.filter((card) => card.imagePath).map(async (card) => {
      const bytes = await loadBinaryFileContent(token, book.owner, book.repo, card.imagePath!, branch).catch(() => null);
      if (!bytes || !active) return null;
      const url = URL.createObjectURL(new Blob([bytesToArrayBuffer(bytes)], { type: imageMimeType(card.imagePath!) }));
      urls.push(url);
      return [card.key, url] as const;
    })).then((entries) => {
      if (!active) return;
      setPreviews(Object.fromEntries(entries.filter(Boolean) as Array<readonly [string, string]>));
    });
    return () => {
      active = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [book, branch, cards, token]);

  if (!book) return <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;
  if (loading && !structure) return <GallerySkeleton />;
  if (error && !structure) return <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription className="flex flex-wrap items-center gap-3"><span>{error}</span><Button size="sm" variant="outline" onClick={() => reload()}>{t("common.reloadBook")}</Button></AlertDescription></Alert>;
  if (!structure) return <GallerySkeleton />;

  const filtered = cards.filter((card) => filter === "all" || (filter === "missing" ? !card.imagePath : card.kind === filter));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{t("assets.title")}</h1>
          <p className="text-muted-foreground">{t("assets.description")}</p>
        </div>
        <Select value={filter} onValueChange={(value) => setFilter(value as AssetFilter)}>
          <SelectTrigger className="w-full sm:w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("assets.all")}</SelectItem>
            <SelectItem value="missing">{t("assets.missing")}</SelectItem>
            <SelectItem value="book">{t("assets.book")}</SelectItem>
            <SelectItem value="chapter">{t("assets.chapter")}</SelectItem>
            <SelectItem value="paragraph">{t("assets.paragraph")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((card) => (
          <Card key={card.key} className="overflow-hidden">
            <div className="flex h-48 items-center justify-center bg-muted/40">
              {previews[card.key] ? <img src={previews[card.key]} alt={card.title} className="h-full w-full object-cover" /> : <ImageIcon className="h-10 w-10 text-muted-foreground" />}
            </div>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="line-clamp-2 text-base">{card.title}</CardTitle>
                <Badge variant={card.imagePath ? "secondary" : "outline"}>{card.imagePath ? t("assets.ready") : t("assets.missing")}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-xs text-muted-foreground">
              <p className="font-mono break-all">{card.imagePath ?? card.promptPath ?? t("assets.noAsset")}</p>
              {token && <AssetImageDialog book={book} branch={branch} token={token} kind={card.kind} title={card.title} chapterSlug={card.chapterSlug} paragraphSlug={card.paragraphSlug} textPath={card.textPath} resumePath={card.resumePath} />}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
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

function GallerySkeleton() {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-72 rounded-xl" />)}</div>;
}

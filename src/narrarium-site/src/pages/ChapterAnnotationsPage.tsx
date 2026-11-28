import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeft, BookOpen, PencilLine } from "lucide-react";
import "@/i18n/annotations";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { AnchorNotice } from "@/components/annotations/AnchorNotice";
import { AnnotationEditorDialog, type AnnotationEditTarget } from "@/components/annotations/AnnotationEditorDialog";
import { TagLabel } from "@/components/annotations/TagLabel";
import { BookTagsPanel } from "@/components/annotations/page/BookTagsPanel";
import { sceneSlugOfPath } from "@/components/annotations/reader/useLocatedAnnotations";
import { useBookStructure } from "@/hooks/useBookStructure";
import { loadFileContent } from "@/github/githubClient";
import { listPosition, locateInChapter, type ChapterAnchorMatch } from "@/annotations/anchoring";
import { ANNOTATION_STATUSES, annotationStatus, isPendingStatus, resolveTag, type Annotation } from "@/annotations/model";
import { sceneTextOfMarkdown } from "@/annotations/sceneText";
import { AnnotationsFileError } from "@/annotations/repository";
import { useBookAnnotations } from "@/annotations/useBookAnnotations";
import { cn } from "@/lib/utils";

const STATUS_FILTERS = ["pending", ...ANNOTATION_STATUSES, "all"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const SELECT = "h-10 w-full rounded-md border border-field bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [@media(pointer:coarse)]:h-11";

/**
 * The annotations of a chapter, scene by scene in the order of the text: their tag, their passage, their note, their status and where the passage is now,
 * filtered by tag, status and scene (the filters are in the address, so a badge can link to one scene). Each opens its scene, shows itself in the reader
 * or is edited; the tags of the book are made, changed and deleted here too. It reads the scenes from the working copy, never from GitHub.
 */
export function ChapterAnnotationsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { bookId, chapterId } = useParams<{ bookId: string; chapterId: string }>();
  const [params, setParams] = useSearchParams();
  const { structure, loading, error, reload } = useBookStructure(bookId);
  const annotations = useBookAnnotations(bookId);
  const chapter = structure?.chapters.find((entry) => entry.slug === chapterId);
  const state = chapterId ? annotations.chapters.get(chapterId) : undefined;
  const [texts, setTexts] = useState<Map<string, string> | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [editTargets, setEditTargets] = useState<AnnotationEditTarget[] | null>(null);

  const tagFilter = params.get("tag") ?? "";
  const statusFilter = (STATUS_FILTERS as readonly string[]).includes(params.get("status") ?? "") ? (params.get("status") as StatusFilter) : "pending";
  const sceneFilter = params.get("scene") ?? "";
  const setFilter = (key: string, value: string, empty: string) => {
    const next = new URLSearchParams(params);
    if (value === empty) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  // The text of each scene, as the reader shows it, to tell where each passage is now.
  useEffect(() => {
    if (!chapter || !annotations.book || !annotations.branch) return;
    let active = true;
    setTexts(null);
    setReadFailed(false);
    const book = annotations.book;
    void Promise.all(chapter.paragraphs.map(async (paragraph) => [paragraph.path, sceneTextOfMarkdown(await loadFileContent(annotations.token, book.owner, book.repo, paragraph.path, annotations.branch), paragraph.path)] as const))
      .then((entries) => { if (active) setTexts(new Map(entries)); })
      .catch(() => { if (active) { setTexts(new Map()); setReadFailed(true); } });
    return () => { active = false; };
  }, [chapter, annotations.book, annotations.branch, annotations.token]);

  const scenes = useMemo(() => (chapter?.paragraphs ?? []).map((paragraph) => ({ slug: sceneSlugOfPath(paragraph.path), number: paragraph.number, title: paragraph.title, path: paragraph.path })), [chapter]);

  const located = useMemo(() => {
    const paragraphs = texts ? scenes.map((scene) => ({ paragraph: scene.slug, text: texts.get(scene.path) ?? "" })) : null;
    const missing = t("annotations.tag.missing");
    return (state?.annotations ?? []).map((annotation) => ({
      annotation,
      match: paragraphs ? locateInChapter(annotation, paragraphs) : null as ChapterAnchorMatch | null,
      tag: resolveTag(annotations.catalog, annotation.tag, missing),
    }));
  }, [state, texts, scenes, annotations.catalog, t]);

  const sceneIndex = (slug: string) => {
    const index = scenes.findIndex((scene) => scene.slug === slug);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const shown = located
    .filter((item) => !tagFilter || item.annotation.tag === tagFilter)
    .filter((item) => {
      const status = annotationStatus(item.annotation.status);
      return statusFilter === "all" || (statusFilter === "pending" ? isPendingStatus(status) : status === statusFilter);
    })
    .filter((item) => !sceneFilter || (item.match?.paragraph ?? item.annotation.paragraph) === sceneFilter)
    .sort((left, right) => sceneIndex(left.match?.paragraph ?? left.annotation.paragraph) - sceneIndex(right.match?.paragraph ?? right.annotation.paragraph)
      || listPosition(left.annotation, left.match) - listPosition(right.annotation, right.match));
  const groups = new Map<string, typeof shown>();
  for (const item of shown) {
    const key = item.match?.paragraph ?? item.annotation.paragraph;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const tagsInUse = annotations.catalog.filter((tag) => located.some((item) => item.annotation.tag === tag.id));

  const describe = (cause: unknown) => (cause instanceof AnnotationsFileError
    ? (cause.problem === "newer-version" ? t("annotations.reader.newerVersion", { chapter: chapter?.title ?? chapterId }) : t("annotations.reader.unreadable", { chapter: chapter?.title ?? chapterId, path: cause.path, detail: cause.message }))
    : cause instanceof Error ? cause.message : String(cause));

  const save = async (annotation: Annotation) => {
    try {
      await annotations.saveAnnotation(annotation);
      return true;
    } catch (cause) {
      toast({ title: t("annotations.reader.saveFailed"), description: describe(cause), variant: "destructive" });
      return false;
    }
  };
  const remove = async (annotation: Annotation) => {
    try {
      await annotations.deleteAnnotation(annotation);
      toast({ title: t("annotations.reader.deleted") });
      return true;
    } catch (cause) {
      toast({ title: t("annotations.reader.saveFailed"), description: describe(cause), variant: "destructive" });
      return false;
    }
  };
  if (loading && !structure) return <div className="space-y-4"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-40 w-full" /></div>;
  if (error && !structure) return <BookStructureErrorAlert error={error} reload={reload} />;
  if (!chapter) return <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;

  const sceneHref = (slug: string) => {
    const scene = scenes.find((entry) => entry.slug === slug);
    return scene ? `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${scene.number}` : undefined;
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2"><Link to={`/app/books/${bookId}/chapters/${chapterId}`}><ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />{t("annotations.list.back")}</Link></Button>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">{t("annotations.list.heading", { chapter: chapter.title })}</h1>
        <p className="text-muted-foreground">{t("annotations.list.description")}</p>
      </div>

      {state?.error && (
        <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>{t("annotations.reader.unreadable", { chapter: chapter.title, path: state.path, detail: state.error })}</AlertDescription></Alert>
      )}
      {readFailed && <Alert><AlertTriangle className="h-4 w-4" /><AlertDescription>{t("annotations.list.readFailed")}</AlertDescription></Alert>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="annotations-filter-tag">{t("annotations.list.filterTag")}</Label>
          <select id="annotations-filter-tag" className={SELECT} value={tagFilter} onChange={(event) => setFilter("tag", event.target.value, "")}>
            <option value="">{t("annotations.list.allTags")}</option>
            {tagsInUse.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="annotations-filter-status">{t("annotations.list.filterStatus")}</Label>
          <select id="annotations-filter-status" className={SELECT} value={statusFilter} onChange={(event) => setFilter("status", event.target.value, "pending")}>
            {STATUS_FILTERS.map((value) => <option key={value} value={value}>{t(`annotations.status.${value}`)}</option>)}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="annotations-filter-scene">{t("annotations.list.filterScene")}</Label>
          <select id="annotations-filter-scene" className={SELECT} value={sceneFilter} onChange={(event) => setFilter("scene", event.target.value, "")}>
            <option value="">{t("annotations.list.allScenes")}</option>
            {scenes.map((scene) => <option key={scene.slug} value={scene.slug}>{`${scene.number} · ${scene.title}`}</option>)}
          </select>
        </div>
      </div>

      <p className="text-sm text-muted-foreground" role="status">{t("annotations.list.count", { count: shown.length })}</p>

      {located.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("annotations.list.empty")}</p>
      ) : shown.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("annotations.list.noMatch")}</p>
      ) : (
        <div className="space-y-6">
          {[...groups].map(([slug, items]) => {
            const scene = scenes.find((entry) => entry.slug === slug);
            return (
              <section key={slug} aria-labelledby={`scene-${slug}`} className="space-y-3">
                <h2 id={`scene-${slug}`} className="text-lg font-semibold">{scene ? `${scene.number} · ${scene.title}` : t("annotations.list.sceneMissing")}</h2>
                <ul className="space-y-3">
                  {items.map((item) => {
                    const href = sceneHref(item.match?.paragraph ?? item.annotation.paragraph);
                    return (
                      <li key={item.annotation.id} className="space-y-2 rounded-xl border bg-card p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <TagLabel tag={item.tag} showScope />
                          <span className={cn("rounded-full border px-2 py-0.5 text-xs", isPendingStatus(annotationStatus(item.annotation.status)) ? "border-primary/40 text-primary" : "text-muted-foreground")}>{t(`annotations.status.${annotationStatus(item.annotation.status)}`)}</span>
                        </div>
                        <blockquote className="border-l-4 border-primary/40 pl-3 font-serif">{item.annotation.quote}</blockquote>
                        {item.annotation.comment && <p className="whitespace-pre-wrap break-words text-sm">{item.annotation.comment}</p>}
                        {item.match && <AnchorNotice state={item.match.state} />}
                        <div className="flex flex-wrap gap-2">
                          {href && <Button asChild size="sm" variant="outline" className="[@media(pointer:coarse)]:h-11"><Link to={href}>{t("annotations.list.openScene")}</Link></Button>}
                          {item.match?.state !== "orphaned" && (
                            <Button asChild size="sm" variant="outline" className="[@media(pointer:coarse)]:h-11">
                              <Link to={`/app/books/${bookId}/reader`} state={{ annotationId: item.annotation.id }}><BookOpen aria-hidden="true" />{t("annotations.list.showInReader")}</Link>
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="[@media(pointer:coarse)]:h-11" onClick={() => setEditTargets([{ annotation: item.annotation, state: item.match?.state, sceneHref: href }])}>
                            <PencilLine aria-hidden="true" />{t("annotations.edit.action")}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <BookTagsPanel bookId={bookId} />

      <AnnotationEditorDialog targets={editTargets} catalog={annotations.catalog} onClose={() => setEditTargets(null)} onSave={save} onDelete={remove} />
    </div>
  );
}

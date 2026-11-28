import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, ChevronDown, ChevronRight, ListChecks, MessageCircle, Search, Trash2 } from "lucide-react";
import "@/i18n/annotations";
import "@/i18n/annotationsPage";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { AnnotationEditorDialog, type AnnotationEditTarget } from "@/components/annotations/AnnotationEditorDialog";
import { AnnotationFixDialog, type FixRequest } from "@/components/annotations/page/AnnotationFixDialog";
import { AnnotationReasonDialog, type ReasonScope } from "@/components/annotations/page/AnnotationReasonDialog";
import { BookTagsPanel } from "@/components/annotations/page/BookTagsPanel";
import { GlobalTagsPanel } from "@/components/annotations/page/GlobalTagsPanel";
import { NoteCard, type NoteCardActions } from "@/components/annotations/page/NoteCard";
import { sceneSlugOfPath } from "@/components/annotations/reader/useLocatedAnnotations";
import { useBookStructure } from "@/hooks/useBookStructure";
import { ANNOTATION_STATUSES, resolveTag, withStatus, type Annotation, type AnnotationStatus } from "@/annotations/model";
import { AnnotationsFileError } from "@/annotations/repository";
import { useBookAnnotations } from "@/annotations/useBookAnnotations";
import {
  NO_FILTERS,
  STATUS_FILTERS,
  filterNotes,
  filtersFromParams,
  groupNotes,
  paramsFromFilters,
  statusCounts,
  tagsInUse,
  type NoteFilters,
  type NoteItem,
} from "@/annotations/notesView";
import { cn } from "@/lib/utils";

const FIELD = "h-10 w-full rounded-md border border-field bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [@media(pointer:coarse)]:h-11";

/**
 * «Appunti»: the notes of a whole book in one place, by chapter, in the order of the book. Filter them by chapter, tag, status and a few words; close, put
 * off or dismiss one or many at once; fix one with the AI (the author reviews the change and applies it in one write, and can undo it); think about one, a
 * chapter or the book with the AI; show a passage in the reader or open its paragraph; make the tags for every book and for this one. It reads the notes the
 * book has on this device and the structure of the book, nothing from GitHub, and writes each change as a local commit (published by the next sync).
 */
export function BookAnnotationsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { bookId } = useParams<{ bookId: string }>();
  const [params, setParams] = useSearchParams();
  const { structure, loading, error, reload } = useBookStructure(bookId);
  const data = useBookAnnotations(bookId);
  const filters = filtersFromParams(params);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<AnnotationStatus>("handled");
  const [fix, setFix] = useState<FixRequest | null>(null);
  const [reason, setReason] = useState<ReasonScope | null>(null);
  const [editing, setEditing] = useState<AnnotationEditTarget[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const chapters = structure?.chapters;
  const titles = useMemo(() => new Map((chapters ?? []).map((chapter) => [chapter.slug, chapter.title])), [chapters]);

  // Every note of the book with where it is: the order of the book and the title of its scene. A chapter or a scene that is not in the book any more comes last.
  const items = useMemo<NoteItem[]>(() => {
    const missing = t("annotations.tag.missing");
    const result: NoteItem[] = [];
    const order = new Map((chapters ?? []).map((chapter, index) => [chapter.slug, index]));
    for (const [slug, state] of data.chapters) {
      const chapter = chapters?.find((entry) => entry.slug === slug);
      for (const annotation of state.annotations) {
        const scenes = chapter?.paragraphs ?? [];
        const sceneIndex = scenes.findIndex((scene) => sceneSlugOfPath(scene.path) === annotation.paragraph);
        const scene = sceneIndex >= 0 ? scenes[sceneIndex] : undefined;
        result.push({
          annotation,
          tagName: resolveTag(data.catalog, annotation.tag, missing).name,
          chapterTitle: chapter?.title ?? slug,
          chapterOrder: order.get(slug) ?? Number.MAX_SAFE_INTEGER,
          sceneTitle: scene?.title ?? annotation.paragraph,
          sceneNumber: scene?.number ?? "",
          sceneOrder: sceneIndex >= 0 ? sceneIndex : Number.MAX_SAFE_INTEGER,
        });
      }
    }
    return result;
  }, [chapters, data.catalog, data.chapters, t]);

  const shown = useMemo(() => filterNotes(items, filters), [items, filters.chapter, filters.tag, filters.status, filters.text]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupNotes(shown), [shown]);
  const counts = useMemo(() => statusCounts(items), [items]);
  const tags = useMemo(() => tagsInUse(items), [items]);
  const unreadable = [...data.chapters.values()].filter((state) => state.error);

  // What was selected and is not shown any more (changed, filtered out, deleted) is not selected.
  useEffect(() => {
    setSelected((current) => {
      const live = new Set(shown.map((item) => item.annotation.id));
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [shown]);

  const setFilters = useCallback((patch: Partial<NoteFilters>) => setParams(paramsFromFilters({ ...filters, ...patch }, params), { replace: true }), [filters, params, setParams]);

  const describe = (cause: unknown) => (cause instanceof AnnotationsFileError ? cause.message : cause instanceof Error ? cause.message : String(cause));
  const failed = (cause: unknown) => toast({ title: t("annotations.reader.saveFailed"), description: describe(cause), variant: "destructive" });

  const changeStatus = useCallback(async (list: readonly Annotation[], status: AnnotationStatus) => {
    const at = new Date().toISOString();
    const changed = list.map((annotation) => withStatus(annotation, status, at, status === "handled" ? { by: "author", at } : undefined)).filter((annotation): annotation is Annotation => annotation !== null);
    if (!changed.length) return;
    try {
      await data.saveAnnotations(changed);
      setAnnouncement(t("annotationsPage.changed", { count: changed.length, status: t(`annotations.status.${status}`) }));
    } catch (cause) {
      failed(cause);
    }
  }, [data, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = useCallback(async (list: readonly Annotation[]) => {
    if (!list.length || !window.confirm(t("annotationsPage.deleteConfirm", { count: list.length }))) return;
    try {
      await data.deleteAnnotations(list);
      setAnnouncement(t("annotationsPage.deleted", { count: list.length }));
    } catch (cause) {
      failed(cause);
    }
  }, [data, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions: NoteCardActions = {
    onSelect: (annotation, on) => setSelected((current) => { const next = new Set(current); if (on) next.add(annotation.id); else next.delete(annotation.id); return next; }),
    onStatus: (annotation, status) => void changeStatus([annotation], status),
    onFix: (annotation) => setFix({ annotation }),
    onReason: (annotation) => setReason({ kind: "note", annotation }),
    onEdit: (annotation) => {
      const item = items.find((entry) => entry.annotation.id === annotation.id);
      setEditing([{ annotation, sceneHref: item?.sceneNumber ? `/app/books/${bookId}/chapters/${annotation.chapter}/paragraphs/${item.sceneNumber}` : undefined }]);
    },
    onDelete: (annotation) => void remove([annotation]),
  };

  if (loading && !structure) return <div className="space-y-4"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-40 w-full" /></div>;
  if (error && !structure) return <BookStructureErrorAlert error={error} reload={reload} />;

  const allShownSelected = shown.length > 0 && shown.every((item) => selected.has(item.annotation.id));
  const selectedNotes = shown.filter((item) => selected.has(item.annotation.id)).map((item) => item.annotation);
  const filtered = filters.chapter !== "" || filters.tag !== "" || filters.status !== NO_FILTERS.status || filters.text.trim() !== "";
  const chapterScope = filters.chapter ? { kind: "chapter" as const, chapter: filters.chapter, title: titles.get(filters.chapter) ?? filters.chapter, annotations: shown.map((item) => item.annotation) } : null;
  const toggleGroup = (chapter: string) => setCollapsed((current) => { const next = new Set(current); if (next.has(chapter)) next.delete(chapter); else next.add(chapter); return next; });

  return (
    <div className="mx-auto max-w-4xl space-y-6" data-annotations-page="">
      <div className="space-y-2">
        <h1 className="font-serif text-3xl font-semibold tracking-tight">{t("annotationsPage.title")}</h1>
        <p className="text-muted-foreground">{t("annotationsPage.description")}</p>
      </div>

      {unreadable.map((state) => (
        <Alert key={state.chapter} variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{t("annotations.reader.unreadable", { chapter: titles.get(state.chapter) ?? state.chapter, path: state.path, detail: state.error })}</AlertDescription></Alert>
      ))}

      <section aria-label={t("annotationsPage.filters")} className="space-y-3 rounded-xl border bg-card p-3 sm:p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="notes-search">{t("annotationsPage.search")}</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input id="notes-search" type="search" value={filters.text} placeholder={t("annotationsPage.searchPlaceholder")} onChange={(event) => setFilters({ text: event.target.value })} className="pl-9 [@media(pointer:coarse)]:h-11" autoComplete="off" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="notes-chapter">{t("annotationsPage.chapter")}</Label>
            <select id="notes-chapter" className={FIELD} value={filters.chapter} onChange={(event) => setFilters({ chapter: event.target.value })}>
              <option value="">{t("annotationsPage.allChapters")}</option>
              {(chapters ?? []).map((chapter) => <option key={chapter.slug} value={chapter.slug}>{chapter.title}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="notes-tag">{t("annotationsPage.tag")}</Label>
            <select id="notes-tag" className={FIELD} value={filters.tag} onChange={(event) => setFilters({ tag: event.target.value })}>
              <option value="">{t("annotationsPage.allTags")}</option>
              {tags.map((tag) => <option key={tag.id} value={tag.id}>{`${tag.name} (${tag.count})`}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("annotationsPage.status")}>
          {STATUS_FILTERS.map((status) => (
            <Button key={status} type="button" size="sm" variant={filters.status === status ? "default" : "outline"} aria-pressed={filters.status === status} onClick={() => setFilters({ status })} className="[@media(pointer:coarse)]:h-11">
              {t(`annotations.status.${status}`)} <span className="ml-1 tabular-nums">{counts[status]}</span>
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {filtered && <Button type="button" size="sm" variant="ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })} className="[@media(pointer:coarse)]:h-11">{t("annotationsPage.clear")}</Button>}
          <Button type="button" size="sm" variant="outline" disabled={!shown.length} onClick={() => setReason(chapterScope ?? { kind: "book", annotations: shown.map((item) => item.annotation) })} className="ml-auto [@media(pointer:coarse)]:h-11" data-reason-all="">
            <MessageCircle aria-hidden="true" />{chapterScope ? t("annotationsPage.reasonChapter") : t("annotationsPage.reasonBook")}
          </Button>
        </div>
      </section>

      <p role="status" aria-live="polite" className="text-sm text-muted-foreground" data-notes-count="">
        {announcement || t("annotationsPage.count", { count: shown.length })}
      </p>

      {shown.length > 0 && (
        <div className="sticky top-[var(--top-reserve,0px)] z-10 flex flex-wrap items-center gap-2 rounded-xl border bg-card/95 p-2 shadow-sm backdrop-blur sm:p-3" role="region" aria-label={t("annotationsPage.bulk")}>
          <label className="inline-flex min-h-6 cursor-pointer items-center gap-2 text-sm [@media(pointer:coarse)]:min-h-11">
            <input type="checkbox" checked={allShownSelected} onChange={(event) => setSelected(event.target.checked ? new Set(shown.map((item) => item.annotation.id)) : new Set())} className="h-4 w-4 [@media(pointer:coarse)]:h-5 [@media(pointer:coarse)]:w-5" />
            {t("annotationsPage.selectAll", { count: shown.length })}
          </label>
          {selectedNotes.length > 0 && (
            <>
              <span className="text-sm font-medium" data-bulk-count="">{t("annotationsPage.selected", { count: selectedNotes.length })}</span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Label htmlFor="notes-bulk-status" className="sr-only">{t("annotationsPage.bulkStatus")}</Label>
                <select id="notes-bulk-status" className={cn(FIELD, "w-auto")} value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value as AnnotationStatus)}>
                  {ANNOTATION_STATUSES.map((status) => <option key={status} value={status}>{t(`annotationsPage.markAs.${status}`)}</option>)}
                </select>
                <Button type="button" size="sm" onClick={() => void changeStatus(selectedNotes, bulkStatus)} className="[@media(pointer:coarse)]:h-11" data-bulk-apply="">{t("annotationsPage.apply")}</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => void remove(selectedNotes)} className="text-destructive [@media(pointer:coarse)]:h-11"><Trash2 aria-hidden="true" />{t("annotationsPage.delete")}</Button>
              </div>
            </>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="space-y-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          <p>{t("annotationsPage.empty")}</p>
          <Button asChild size="sm" variant="outline" className="[@media(pointer:coarse)]:h-11"><Link to={`/app/books/${bookId}/reader`}>{t("annotationsPage.openReader")}</Link></Button>
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("annotationsPage.noMatch")}</p>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => {
            const open = !collapsed.has(group.chapter);
            const groupCounts = statusCounts(group.items);
            return (
              <section key={group.chapter} aria-labelledby={`notes-chapter-${group.chapter}`} className="space-y-3" data-notes-chapter={group.chapter}>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id={`notes-chapter-${group.chapter}`} className="min-w-0 flex-1 text-lg font-semibold">
                    <button type="button" aria-expanded={open} onClick={() => toggleGroup(group.chapter)} className="inline-flex min-h-6 items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11">
                      {open ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />}
                      <span className="break-words">{group.title}</span>{" "}
                      <span className="text-sm font-normal text-muted-foreground">{t("annotationsPage.chapterCount", { count: group.items.length, pending: groupCounts.pending })}</span>
                    </button>
                  </h2>
                  <Button asChild size="sm" variant="ghost" className="[@media(pointer:coarse)]:h-11"><Link to={`/app/books/${bookId}/chapters/${group.chapter}/annotations`}><ListChecks aria-hidden="true" />{t("annotationsPage.chapterList")}</Link></Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setReason({ kind: "chapter", chapter: group.chapter, title: group.title, annotations: group.items.map((item) => item.annotation) })} className="[@media(pointer:coarse)]:h-11"><MessageCircle aria-hidden="true" />{t("annotationsPage.reasonChapter")}</Button>
                </div>
                {open && (
                  <ul className="space-y-3">
                    {group.items.map((item) => (
                      <NoteCard
                        key={item.annotation.id}
                        annotation={item.annotation}
                        tag={resolveTag(data.catalog, item.annotation.tag, t("annotations.tag.missing"))}
                        sceneTitle={item.sceneTitle}
                        sceneNumber={item.sceneNumber || undefined}
                        bookId={bookId ?? ""}
                        selected={selected.has(item.annotation.id)}
                        actions={actions}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      <section aria-labelledby="notes-tags" className="space-y-4">
        <h2 id="notes-tags" className="text-xl font-semibold">{t("annotationsPage.tags.title")}</h2>
        <BookTagsPanel bookId={bookId} />
        <GlobalTagsPanel />
      </section>

      <AnnotationFixDialog
        bookId={bookId ?? ""}
        request={fix}
        catalog={data.catalog}
        sceneNumber={fix ? items.find((entry) => entry.annotation.id === fix.annotation.id)?.sceneNumber : undefined}
        onClose={() => setFix(null)}
        onApplied={() => setAnnouncement(t("annotationsPage.fix.appliedAnnounce"))}
      />
      <AnnotationReasonDialog bookId={bookId ?? ""} scope={reason} catalog={data.catalog} titles={titles} onClose={() => setReason(null)} onFix={(annotation, instruction) => setFix({ annotation, instruction })} />
      <AnnotationEditorDialog
        targets={editing}
        catalog={data.catalog}
        onClose={() => setEditing(null)}
        onSave={async (annotation) => { try { await data.saveAnnotation(annotation); return true; } catch (cause) { failed(cause); return false; } }}
        onDelete={async (annotation) => { try { await data.deleteAnnotation(annotation); return true; } catch (cause) { failed(cause); return false; } }}
      />
    </div>
  );
}

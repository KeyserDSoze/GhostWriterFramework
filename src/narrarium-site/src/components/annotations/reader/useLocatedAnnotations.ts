import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/annotations";
import { locateInChapter, type ChapterAnchorMatch } from "@/annotations/anchoring";
import { annotationStatus, isPendingStatus, resolveTag, type Annotation, type ResolvedTag } from "@/annotations/model";
import { markHtml, plainTextOfHtml, type MarkedPassage } from "@/annotations/textModel";
import type { ChapterAnnotationsState } from "@/annotations/useBookAnnotations";

/** A scene of the reader, as the annotations need it: where it is and the HTML the reader shows. */
export interface ReaderScene {
  chapterSlug: string;
  chapterTitle: string;
  paragraphSlug: string;
  paragraphNumber: string;
  paragraphTitle: string;
  path: string;
  html: string;
}

/** An annotation, where it is now in the text of the reader, and its tag. */
export interface LocatedAnnotation {
  annotation: Annotation;
  match: ChapterAnchorMatch;
  tag: ResolvedTag;
}

export function sceneSlugOfPath(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

const NOTE_IN_LABEL = 140;

/** The accessible name of the button of a mark: its tag and its note, cut short. */
export function markLabel(t: (key: string, options?: Record<string, unknown>) => string, tag: ResolvedTag, comment: string): string {
  const note = comment.trim();
  if (!note) return t("annotations.mark.label", { tag: tag.name });
  return t("annotations.mark.labelWithNote", { tag: tag.name, note: note.length > NOTE_IN_LABEL ? `${note.slice(0, NOTE_IN_LABEL - 1)}…` : note });
}

/**
 * The annotations of the book in the text of the reader: each one found again in the scenes of its chapter (exact, moved, edited, or orphaned), the
 * HTML of every scene with its marks (when they are shown), and how many annotations wait in each scene.
 */
export function useLocatedAnnotations(input: { scenes: readonly ReaderScene[] | null; chapters: Map<string, ChapterAnnotationsState>; catalog: readonly ResolvedTag[]; show: boolean }) {
  const { t } = useTranslation();
  const { scenes, chapters, catalog, show } = input;

  const texts = useMemo(() => new Map((scenes ?? []).map((scene) => [scene.path, plainTextOfHtml(scene.html)])), [scenes]);

  const scenesByChapter = useMemo(() => {
    const result = new Map<string, ReaderScene[]>();
    for (const scene of scenes ?? []) {
      const list = result.get(scene.chapterSlug) ?? [];
      list.push(scene);
      result.set(scene.chapterSlug, list);
    }
    return result;
  }, [scenes]);

  const located = useMemo(() => {
    const result: LocatedAnnotation[] = [];
    if (!scenes) return result;
    const missing = t("annotations.tag.missing");
    for (const [chapter, state] of chapters) {
      const chapterScenes = scenesByChapter.get(chapter) ?? [];
      const paragraphs = chapterScenes.map((scene) => ({ paragraph: scene.paragraphSlug, text: texts.get(scene.path) ?? "" }));
      for (const annotation of state.annotations) {
        result.push({ annotation, match: locateInChapter(annotation, paragraphs), tag: resolveTag(catalog, annotation.tag, missing) });
      }
    }
    return result;
  }, [scenes, chapters, scenesByChapter, texts, catalog, t]);

  const sceneOf = useMemo(() => {
    const index = new Map<string, ReaderScene>();
    for (const scene of scenes ?? []) index.set(`${scene.chapterSlug}/${scene.paragraphSlug}`, scene);
    return (chapter: string, paragraph: string) => index.get(`${chapter}/${paragraph}`);
  }, [scenes]);

  const marked = useMemo(() => {
    const result = new Map<string, string>();
    if (!show) return result;
    const byScene = new Map<string, { scene: ReaderScene; passages: MarkedPassage[] }>();
    for (const item of located) {
      if (item.match.state === "orphaned") continue;
      const scene = sceneOf(item.annotation.chapter, item.match.paragraph);
      if (!scene) continue;
      const entry = byScene.get(scene.path) ?? { scene, passages: [] };
      entry.passages.push({
        id: item.annotation.id,
        start: item.match.start,
        end: item.match.end,
        underline: item.tag.mark.underline,
        color: item.tag.mark.color,
        icon: item.tag.mark.icon,
        state: item.match.state,
        label: markLabel(t, item.tag, item.annotation.comment),
      });
      byScene.set(scene.path, entry);
    }
    const parser = typeof DOMParser === "undefined" ? null : new DOMParser();
    if (!parser) return result;
    for (const [path, { scene, passages }] of byScene) result.set(path, markHtml(scene.html, passages, parser));
    return result;
  }, [located, show, sceneOf, t]);

  /** By scene path: the annotations that wait for the author there (an orphaned one counts in the scene it was marked in). */
  const pendingByScene = useMemo(() => {
    const result = new Map<string, LocatedAnnotation[]>();
    for (const item of located) {
      if (!isPendingStatus(annotationStatus(item.annotation.status))) continue;
      const scene = sceneOf(item.annotation.chapter, item.match.paragraph) ?? sceneOf(item.annotation.chapter, item.annotation.paragraph);
      if (!scene) continue;
      const list = result.get(scene.path) ?? [];
      list.push(item);
      result.set(scene.path, list);
    }
    return result;
  }, [located, sceneOf]);

  return { located, marked, pendingByScene, sceneOf, texts };
}

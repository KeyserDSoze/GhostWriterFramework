import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/annotationsPage";
import { captureImmediateMutation, commitImmediateMutation } from "@/assistant/immediateMutation";
import { updateFile } from "@/github/githubClient";
import { completeTextRouted } from "@/assistant/router";
import { currentRequest, untrustedData } from "@/assistant/promptTrust";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { useSettingsStore } from "@/store/settingsStore";
import { applyFix, fixRequest, readFixReply, type FixTarget } from "@/annotations/fix";
import { RESOLUTION_SUMMARY_MAX, resolveTag, withStatus, type Annotation } from "@/annotations/model";
import { loadPassageContext, type PassageContext } from "@/components/annotations/page/passageContext";
import { useBookAnnotations } from "@/annotations/useBookAnnotations";
import { useBookStructure } from "@/hooks/useBookStructure";

/** Why a fix could not go on: the passage is no longer in the text, a file could not be read, the AI did not answer, the scene changed meanwhile, or it could not be written. */
export type FixProblem = "orphaned" | "read" | "ai" | "empty" | "stale" | "write";

export type FixPhase = "idle" | "preparing" | "asking" | "proposed" | "applying" | "applied";

export interface FixState {
  phase: FixPhase;
  problem?: FixProblem;
  detail?: string;
  /** The scene file the fix is about, and the blocks it rewrites (once the scene is read). */
  scenePath?: string;
  sceneTitle?: string;
  target?: FixTarget;
  /** What the AI proposed for those blocks. */
  proposal?: string;
}

type Loaded = PassageContext;

/**
 * The fix of an annotation with the AI, step by step: the scene is read from the working copy and the blocks that hold the passage are found, the model is
 * asked (with what the author adds), the proposal is shown for the author to decide (`AnnotationFixReview`), and applying it is ONE write of the scene (a local
 * commit) and the annotation closed as handled by the AI; undoing puts both back as they were while nothing changed them since. Nothing is written without
 * `apply`, and nothing is read from GitHub.
 */
export function useAnnotationFix(bookId: string | undefined) {
  const { t, i18n } = useTranslation();
  const data = useBookAnnotations(bookId);
  const { structure } = useBookStructure(bookId);
  const [state, setState] = useState<FixState>({ phase: "idle" });
  const loaded = useRef<Loaded | null>(null);
  const request = useRef<AbortController | null>(null);
  const applied = useRef<{ path: string; before: string; after: string; annotation: Annotation } | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  const reset = useCallback(() => {
    request.current?.abort();
    request.current = null;
    loaded.current = null;
    applied.current = null;
    setState({ phase: "idle" });
  }, []);

  const fail = useCallback((problem: FixProblem, detail?: string) => setState((current) => ({ ...current, phase: current.proposal ? "proposed" : "idle", problem, detail })), []);

  /** Reads the scene and finds the passage: where it is now, even when it moved to another scene of its chapter. */
  const prepare = useCallback(async (annotation: Annotation): Promise<Loaded | null> => {
    if (!data.book || !data.branch) { fail("read"); return null; }
    const found = await loadPassageContext({ token: data.token, book: data.book, branch: data.branch, chapter: structure?.chapters.find((entry) => entry.slug === annotation.chapter), annotation });
    if ("problem" in found) { fail(found.problem, found.detail); return null; }
    return found.context;
  }, [data.book, data.branch, data.token, fail, structure]);

  /** Asks the model for a proposal for the passage of `annotation`, with what the author adds for this try. */
  const ask = useCallback(async (annotation: Annotation, instruction?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    applied.current = null;
    setState((current) => ({ ...current, phase: "preparing", problem: undefined, detail: undefined }));
    const scene = await prepare(annotation);
    if (controller.signal.aborted || !scene) return;
    loaded.current = scene;
    setState({ phase: "asking", scenePath: scene.path, sceneTitle: scene.sceneTitle, target: scene.target });
    try {
      const tag = resolveTag(data.catalog, annotation.tag, t("annotations.tag.missing"));
      const { system, request: ask, data: material } = fixRequest({
        quote: annotation.quote,
        comment: annotation.comment,
        tag: { name: tag.name, description: tag.description },
        target: scene.target,
        instruction,
        where: `${scene.chapterTitle} / ${scene.sceneTitle}`,
        language: i18n.resolvedLanguage ?? i18n.language,
      });
      const reply = await completeTextRouted(useSettingsStore.getState().settings, [
        { role: "system", content: system },
        { role: "user", content: `${currentRequest(ask)}\n\n${untrustedData("repository_content", material)}` },
      ], "rewrite-from-reader-feedback", { accountScope: localWorkspaceScope(), signal: controller.signal, label: "annotation:fix" });
      if (controller.signal.aborted) return;
      const proposal = readFixReply(reply);
      if (!proposal) { setState((current) => ({ ...current, phase: "idle", problem: "empty" })); return; }
      setState({ phase: "proposed", scenePath: scene.path, sceneTitle: scene.sceneTitle, target: scene.target, proposal });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState((current) => ({ ...current, phase: "idle", problem: "ai", detail: error instanceof Error ? error.message : String(error) }));
    }
  }, [data.catalog, i18n.language, i18n.resolvedLanguage, prepare, t]);

  /** Writes the scene with `replacement` for the blocks (what the author decided) and closes the annotation as handled by the AI: one write of the scene. */
  const apply = useCallback(async (annotation: Annotation, replacement: string): Promise<boolean> => {
    const scene = loaded.current;
    if (!scene || !data.book || !data.branch) return false;
    setState((current) => ({ ...current, phase: "applying", problem: undefined, detail: undefined }));
    try {
      const snapshot = await captureImmediateMutation({ token: data.token, book: data.book, branch: data.branch, path: scene.path });
      // The scene is as it was read: otherwise the fix is about a text that is not there any more.
      if (snapshot.content !== scene.raw) { setState((current) => ({ ...current, phase: "proposed", problem: "stale" })); return false; }
      const next = applyFix(scene.raw, scene.target, replacement);
      if (next === null) { setState((current) => ({ ...current, phase: "proposed", problem: "empty" })); return false; }
      await commitImmediateMutation({ token: data.token, book: data.book, branch: data.branch, snapshot, content: next, message: `Fix an annotation in ${scene.path}` });
      const at = new Date().toISOString();
      const summary = t("annotationsPage.fix.resolution").slice(0, RESOLUTION_SUMMARY_MAX);
      const closed = withStatus(annotation, "handled", at, { by: "ai", at, summary });
      if (closed) await data.saveAnnotation(closed);
      applied.current = { path: scene.path, before: scene.raw, after: next, annotation };
      setState((current) => ({ ...current, phase: "applied", problem: undefined }));
      return true;
    } catch (error) {
      setState((current) => ({ ...current, phase: "proposed", problem: "write", detail: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  }, [data, t]);

  /** Puts the scene and the annotation back as they were, while the scene is still what the fix wrote. */
  const undo = useCallback(async (): Promise<boolean> => {
    const done = applied.current;
    if (!done || !data.book || !data.branch) return false;
    setState((current) => ({ ...current, phase: "applying", problem: undefined, detail: undefined }));
    try {
      const snapshot = await captureImmediateMutation({ token: data.token, book: data.book, branch: data.branch, path: done.path });
      if (snapshot.content !== done.after) { setState((current) => ({ ...current, phase: "applied", problem: "stale" })); return false; }
      // Back to the text the book had before, which a commit of "no change" would refuse: the plain local write takes it.
      await updateFile(data.token, data.book.owner, data.book.repo, data.branch, done.path, snapshot.hash ?? "", done.before, `Undo the fix of an annotation in ${done.path}`);
      await data.saveAnnotation({ ...done.annotation, updatedAt: new Date().toISOString() });
      loaded.current = loaded.current ? { ...loaded.current, raw: done.before } : null;
      applied.current = null;
      setState((current) => ({ ...current, phase: "proposed", problem: undefined }));
      return true;
    } catch (error) {
      setState((current) => ({ ...current, phase: "applied", problem: "write", detail: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  }, [data]);

  const setProposal = useCallback((proposal: string) => setState((current) => (current.phase === "proposed" ? { ...current, proposal } : current)), []);

  return { state, ask, apply, undo, reset, setProposal };
}

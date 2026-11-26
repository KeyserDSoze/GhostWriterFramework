import { useCallback, useEffect, useMemo, useState } from "react";
import { chapterFilePath, summarizeCampaign, type AutopilotCampaignSummary, type AutopilotState, type ChapterFreeze, type ReviseChaptersInput } from "narrarium-engine";
import { AutopilotOutlineApplyUnsupportedError, serverHasOutlineApply } from "@/autopilot/campaign";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { useAutopilotStore } from "@/autopilot/store";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { applyModel, isDecidable, type ApplyModel } from "@/outline/applyModel";
import { chapterFreezes, type WrittenChapter } from "@/outline/outlineModel";
import type { OutlineSource } from "@/outline/outlineSource";
import type { WhatChanged } from "@/outline/whatChanged";
import type { BookEntry } from "@/types/settings";

export interface OutlineApplyOptions {
  book: BookEntry | undefined;
  source: OutlineSource | null;
  view: WhatChanged | null;
  /** The state of the book's autopilot as the page read it. */
  state: AutopilotState | null;
  written: ReadonlyMap<number, WrittenChapter>;
  /** Read the Synopsis and the state again, once something was recorded. */
  refresh: () => Promise<void>;
}

/**
 * «Apply to the book» on the Synopsis page: whether it can be done here (a personal server that predates the campaigns cannot), what the panel shows (`model`, with
 * the records of the frozen chapters read when it opens), the campaign that goes on (the live summary of the run when there is one, else the state's), and the two
 * commands, through the autopilot's runtime: apply (record the choices, then start the autopilot unless it runs) and cancel the chapters that wait.
 */
export function useOutlineApply({ book, source, view, state, written, refresh }: OutlineApplyOptions) {
  const bookId = book?.id;
  const server = book?.autopilotHost === "server";
  const { run, busy } = useAutopilotActions(bookId);
  const serverInfo = useAutopilotStore((store) => store.server.info);
  const live = useAutopilotStore((store) => (bookId ? store.summaries[bookId] ?? null : null));
  const [refused, setRefused] = useState(false);
  const unsupported = server && ((serverInfo !== null && !serverHasOutlineApply(serverInfo)) || refused);
  const fresher = live && (!state || live.updatedAt >= state.updatedAt);
  const running = (fresher ? live.status : state?.status) === "running";
  const campaign: AutopilotCampaignSummary | null = (fresher ? live.campaign : summarizeCampaign(state?.campaign)) ?? null;

  const [open, setOpen] = useState(false);
  const [freezes, setFreezes] = useState<ReadonlyMap<number, ChapterFreeze | null> | null>(null);
  const decidable = useMemo(() => (view?.mode === "plan" ? view.rows.filter(isDecidable) : []), [view]);
  const slugs = decidable.map((row) => written.get(row.number)?.slug ?? state?.plan?.chapters.find((chapter) => chapter.number === row.number)?.slug ?? "").join("\n");

  // The records of the frozen chapters are read when the panel opens: who froze each says what it starts with.
  useEffect(() => {
    if (!open || !source) return;
    let current = true;
    setFreezes(null);
    const numbers = decidable.map((row) => row.number);
    const bySlug = slugs.split("\n");
    source.readFiles(bySlug.filter(Boolean).map(chapterFilePath))
      .then((files) => chapterFreezes(files))
      .catch(() => new Map<string, ChapterFreeze>())
      .then((records) => {
        if (current) setFreezes(new Map(numbers.map((number, index) => [number, records.get(bySlug[index]) ?? null])));
      });
    return () => {
      current = false;
    };
    // `slugs` stands for the chapters decided about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source, slugs]);

  const model: ApplyModel | null = useMemo(() => (view && freezes ? applyModel(view, freezes) : null), [view, freezes]);

  // The estimate measures the speed of the models on the steps the book ran: the log comes with the autopilot's snapshot, read when the panel opens.
  useEffect(() => {
    if (!open || !bookId) return;
    void loadAutopilotRuntime().then((runtime) => runtime.refresh(bookId, { join: true })).catch(() => undefined);
  }, [open, bookId]);

  const refusedHere = useCallback((error: unknown) => {
    if (!(error instanceof AutopilotOutlineApplyUnsupportedError)) return false;
    setRefused(true);
    return true;
  }, []);

  const apply = useCallback(async (input: ReviseChaptersInput, start: boolean): Promise<boolean> => {
    const done = await run("answer", async (runtime, id) => {
      await runtime.reviseChapters(id, input);
      if (!start) return;
      // Recording read the book's autopilot again: a run that goes on (here, in another tab, on the server) takes the chapters at its next step.
      const after = useAutopilotStore.getState().views[id];
      if (after?.snapshot?.running || after?.busyInAnotherTab) return;
      await runtime.start(id);
    }, undefined, refusedHere);
    await refresh();
    return done;
  }, [run, refresh, refusedHere]);

  const cancel = useCallback(async (): Promise<boolean> => {
    const done = await run("answer", (runtime, id) => runtime.cancelRevisionCampaign(id), undefined, refusedHere);
    await refresh();
    return done;
  }, [run, refresh, refusedHere]);

  return {
    open,
    setOpen,
    model,
    decidable: decidable.length,
    campaign,
    running,
    unsupported,
    busy: busy !== null,
    apply,
    cancel,
  };
}

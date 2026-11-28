import { useMemo, useRef, useState } from "react";
import type { AutopilotState, OutlineChapterEntry } from "narrarium-engine";
import "@/i18n/design";
import { useTranslation } from "react-i18next";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { alternativesViewOf, findingsViewOf, reviewBlockOf, reviewRequest, rubricViewOf, type FindingView, type PitchView } from "@/outline/designReviewModel";
import type { DesignBlock } from "@/outline/designModel";
import type { BookEntry } from "@/types/settings";
import { AlternativesPanel } from "@/components/outline/studio/AlternativesPanel";
import { FindingsPanel, type FindingAction } from "@/components/outline/studio/FindingsPanel";
import { ReviewRequest } from "@/components/outline/studio/ReviewRequest";
import { RubricPanel } from "@/components/outline/studio/RubricPanel";

export interface StudioReviewsProps {
  book: BookEntry;
  state: AutopilotState | null;
  entries: readonly OutlineChapterEntry[];
  /** A run goes on, in this tab or another. */
  running: boolean;
  /** A design run goes on (also paused, or waiting for an answer): it reviews the design itself. */
  designing: boolean;
  /** The personal server that runs the book does not have the reviews of a design. */
  serverWithoutReview: boolean;
  /** Why the design cannot be made again, or `null`: a fix asked of the autopilot is a design round. */
  designBlock: DesignBlock | null;
}

/**
 * The reviews of the design in the Studio: the alternative pitches and the choice, the findings of the analysis of the structure with what the author can do about each, the rubric
 * of every subject that was judged, and the buttons that ask for a review on request of the whole design or of a chapter. One chunk, loaded when the Studio has something of it to show.
 */
export default function StudioReviews({ book, state, entries, running, designing, serverWithoutReview, designBlock }: StudioReviewsProps) {
  const { t } = useTranslation();
  const { run, busy } = useAutopilotActions(book.id);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [message, setMessage] = useState("");
  const alternatives = alternativesViewOf(state);
  const rubric = rubricViewOf(state);
  const findings = findingsViewOf(state);
  const titles = useMemo(() => new Map(entries.map((entry) => [entry.number, entry.title])), [entries]);
  const pitchTitles = useMemo(() => new Map((alternatives?.pitches ?? []).map((entry) => [entry.pitch.id, entry.pitch.title])), [alternatives]);
  const block = reviewBlockOf({ chapters: entries.length, running, designing, serverWithoutReview });
  const held = busy !== null || running;
  const say = (text: string) => setMessage(text);

  const choose = async (pitch: PitchView) => {
    if (await run("answer", (runtime, id) => runtime.chooseDesignPitch(id, { id: pitch.pitch.id }))) say(t("designReview.alternatives.chosenAnnounce", { title: pitch.pitch.title }));
  };

  const decide = async (view: FindingView, action: FindingAction) => {
    if (!(await run("answer", (runtime, id) => runtime.decideDesignFinding(id, { id: view.finding.id, action })))) return;
    headingRef.current?.focus();
    say(t(`designReview.findings.announce.${action}`));
    // Asking the autopilot to fix a finding is a design round: the chapters the finding revises are designed again, and judged again.
    if (action === "fix" && (await run("start", (runtime, id) => runtime.start(id, { design: {} })))) say(t("designReview.findings.started"));
  };

  const review = async (chapters?: number[]) => {
    if (await run("start", (runtime, id) => runtime.start(id, { design: reviewRequest(chapters) }))) say(t("designReview.request.started"));
  };

  return (
    <div data-design-reviews className="flex flex-col gap-5">
      {alternatives && <AlternativesPanel view={alternatives} disabled={held} onChoose={(pitch) => void choose(pitch)} />}
      {findings && <FindingsPanel ref={headingRef} view={findings} disabled={held} fixBlocked={designBlock !== null} onDecide={(view, action) => void decide(view, action)} />}
      {rubric && <RubricPanel view={rubric} state={state} titles={titles} pitchTitles={pitchTitles} canReview={block === null} disabled={held} onReviewChapter={(chapter) => void review([chapter])} />}
      {entries.length > 0 && <ReviewRequest chapters={entries.map((entry) => ({ number: entry.number, title: entry.title }))} block={block} starting={busy === "start"} onReview={(chapters) => void review(chapters)} />}
      <p role="status" className="sr-only">{message}</p>
    </div>
  );
}

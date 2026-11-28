import type { AutopilotState, DesignCanonProposal, DesignCompletionFinding, DesignCompletionReading, DesignFieldProposal, DesignProposalsDecision, DesignRound, OutlineChapterEntry } from "narrarium-engine";

/**
 * The proposals of «Review and complete» (`state.design.completion`, #125) as the Studio shows them: chapter by chapter, what each proposal is and whether it still waits,
 * the canon to create, and what the author chooses to apply. Pure: the engine decides what applying writes (`AutopilotSession.applyDesignProposals`).
 */

export interface CompletionChapterView {
  number: number;
  title: string;
  /** The entry changed since its proposals were made: a field it has now stays the author's. */
  changed: boolean;
  /** The entry is gone, or no longer the author's: nothing of it is written. */
  gone: boolean;
  fields: DesignFieldProposal[];
  findings: DesignCompletionFinding[];
}

export interface CompletionView {
  /** The «Review and complete» it is (`AutopilotDesign.startedAt`): what a decision names. */
  run: string;
  /** The run goes on: its proposals are not all made yet. */
  active: boolean;
  decided?: { at: string; applied: number; skipped: number };
  /** The chapters with a proposal, in order. */
  chapters: CompletionChapterView[];
  canon: DesignCanonProposal[];
  readings: DesignCompletionReading[];
  /** The director's last review. */
  last?: DesignRound;
  /** The proposals that wait for the author, by id. */
  waiting: string[];
}

/** The proposals of the «Review and complete» the state has, as the Studio shows them; `null` when the book has none. */
export function completionViewOf(state: Pick<AutopilotState, "design"> | null | undefined, entries: readonly OutlineChapterEntry[]): CompletionView | null {
  const design = state?.design;
  const completion = design?.mode === "complete" ? design.completion : undefined;
  if (!design || !completion) return null;
  const byNumber = new Map(entries.map((entry) => [entry.number, entry]));
  const chapters: CompletionChapterView[] = [];
  const waiting: string[] = [];
  for (const proposals of Object.values(completion.entries).sort((left, right) => left.number - right.number)) {
    if (!proposals.fields.length && !proposals.findings.length) continue;
    const entry = byNumber.get(proposals.number);
    const gone = !entry || entry.intact || Boolean(entry.unreadable);
    chapters.push({
      number: proposals.number,
      title: entry?.title || proposals.title,
      changed: !gone && Boolean(proposals.digest) && entry!.contentDigest !== proposals.digest,
      gone,
      fields: proposals.fields,
      findings: proposals.findings,
    });
    for (const item of [...proposals.fields, ...proposals.findings]) if (item.status === "waiting") waiting.push(item.id);
  }
  for (const proposal of completion.canon) if (proposal.status === "waiting") waiting.push(proposal.id);
  return {
    run: design.startedAt,
    active: !design.endedAt,
    ...(completion.decided ? { decided: completion.decided } : {}),
    chapters,
    canon: completion.canon,
    readings: completion.readings,
    ...(design.rounds.length ? { last: design.rounds[design.rounds.length - 1] } : {}),
    waiting: completion.decided ? [] : waiting,
  };
}

/** What the author finds chosen at first: every field and every entity to create, and the findings that are not minor. */
export function defaultChosen(view: CompletionView): Set<string> {
  const waiting = new Set(view.waiting);
  const chosen = new Set<string>();
  for (const chapter of view.chapters) {
    for (const field of chapter.fields) if (waiting.has(field.id)) chosen.add(field.id);
    for (const finding of chapter.findings) if (waiting.has(finding.id) && finding.severity !== "minor") chosen.add(finding.id);
  }
  for (const proposal of view.canon) if (waiting.has(proposal.id)) chosen.add(proposal.id);
  return chosen;
}

/** The decision of the author: the proposals chosen that wait; every other one is left out. */
export function proposalsDecision(view: CompletionView, chosen: ReadonlySet<string>): DesignProposalsDecision {
  return { run: view.run, apply: view.waiting.filter((id) => chosen.has(id)) };
}

/** The ids a chapter's proposals that wait, for the choice of a whole chapter. */
export function waitingOf(chapter: CompletionChapterView): string[] {
  return [...chapter.fields, ...chapter.findings].filter((item) => item.status === "waiting").map((item) => item.id);
}

/** A proposed value as lines: a list item a line, a flag as `true`/`false` (the component words it). */
export function proposedLines(value: DesignFieldProposal["value"]): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "boolean") return [String(value)];
  return value.split("\n").filter((line) => line.trim());
}

import {
  changeOfWritten,
  isPlannedChapterWritten,
  type AutopilotState,
  type FrozenAction,
  type OutlineChangeOutcome,
  type OutlineChapterEntry,
  type OutlineJournal,
  type OutlineJournalAuthor,
  type OutlineJournalChapter,
  type OutlineJournalChangeKind,
} from "narrarium-engine";

/**
 * «What changed» on the Synopsis page: the chapters whose entry says something else than what the autopilot follows, with what it will do about each, and what
 * else changed since a moment the author knows, told with the journal of the Synopsis (`outline/changes.yml`: who changed an entry, when, how).
 *
 * - What the autopilot has not followed yet is always listed (`pending`): an entry that is not the one its plan keeps (`PlannedChapter.outlineDigest`, as
 *   `outlinePlanStatus` compares them), an entry the plan lost, an entry beyond the plan. What it does about each is the engine's rule (`changeOfWritten`).
 * - What else changed is listed since the author last marked the changes as reviewed (`journal.reviewedAt`), else since the autopilot last worked (the state's
 *   `updatedAt`), else as far as the journal goes back.
 * - A book without an approved plan has nothing the autopilot follows yet: only the journal is told, and the autopilot follows the Synopsis when it plans the book.
 * - What the author already decided about a change holds it (`held`): the chapters the Synopsis is being applied to (the campaign of the engine, `state.campaign`),
 *   the changes left for later (`state.deferredChanges`) and the decisions recorded for the next run (`state.pendingReviews`). The rule of the setting then says
 *   nothing more about them.
 *
 * The journal only tells the story: when it does not know the last change of an entry (the file was changed elsewhere), the row says the entry changed and nothing
 * more. Pure.
 */

/** What the autopilot does about a listed chapter: the engine's outcome, an entry beyond the plan (`extends`), a change it already took into account (`followed`), no plan yet (`no-plan`). */
export type WhatChangedOutcome = OutlineChangeOutcome | "extends" | "followed" | "no-plan";

/**
 * What the author already decided about a change that the autopilot has not followed yet: it is being rewritten now (`rewriting`), waits for its turn (`applying`) or to be
 * kept at the run's next step (`keeping`) in the chapters the Synopsis is being applied to; it is left for later (`deferred`); or a decision waits for the next run (`decided`).
 */
export type WhatChangedHeld = "rewriting" | "applying" | "keeping" | "deferred" | "decided";

/** Since when the view tells what changed: the author's «reviewed», the autopilot's last work, or as far as the journal goes back. */
export type WhatChangedSince = { kind: "review" | "autopilot"; at: string } | { kind: "always" };

export interface WhatChangedRow {
  number: number;
  /** The title of the entry the chapter has now (of the entry it lost, when it has none). */
  title: string;
  /** The last change of the journal about it; `changed` (or `removed`) when the journal does not tell it. */
  change: OutlineJournalChangeKind | "changed";
  from?: number;
  /** `moved`: and its text changed too. */
  edited?: boolean;
  by?: OutlineJournalAuthor;
  at?: string;
  /** The changes the journal tells about it, the last included (0 when it does not tell the last one). */
  series: number;
  outcome: WhatChangedOutcome;
  /** The autopilot has not followed it yet: it has a consequence. */
  pending: boolean;
  /** Its last change came after the author last marked the changes as reviewed (every row, before the first time). */
  fresh: boolean;
  /** The chapter has text in the book; the plan says it is approved; the author wrote it before the autopilot (never rewritten for the autopilot's own decision). */
  written: boolean;
  approved: boolean;
  imported: boolean;
  /** The digest of the entry it has now: the change a decision is about. */
  digest?: string;
  /** What the author already decided about it (only for a change the autopilot has not followed yet). */
  held?: WhatChangedHeld;
  /** `decided`: the decision recorded. */
  decision?: FrozenAction;
}

export interface WhatChanged {
  /** `plan`: an approved plan says what the autopilot follows; `journal`: no plan yet, only the journal. */
  mode: "plan" | "journal";
  /** In the order of the book. */
  rows: WhatChangedRow[];
  since: WhatChangedSince;
  /** Whether the journal has series after the last «reviewed»: what «Mark as reviewed» would clear. */
  unreviewed: boolean;
}

export interface WhatChangedInput {
  /** The entries of the Synopsis now, in order. */
  entries: readonly OutlineChapterEntry[];
  journal: OutlineJournal;
  state: AutopilotState | null;
  /** The chapters of the book that have text, by number. */
  written: ReadonlySet<number>;
}

type Told = { item: OutlineJournalChapter; by: OutlineJournalAuthor; at: string };

/**
 * The items of the journal about chapter `number`, newest first, back to where its change began: the series that changed the entry the autopilot follows
 * (`followed`; the one that made it is not part of the change), the one that created the entry, or the moment `after`.
 */
function historyOf(journal: OutlineJournal, number: number, options: { followed?: string; after?: string } = {}): Told[] {
  const found: Told[] = [];
  for (let index = journal.series.length - 1; index >= 0; index -= 1) {
    const series = journal.series[index];
    if (options.after && series.at <= options.after) break;
    const item = series.chapters.find((entry) => entry.chapter === number);
    if (!item) continue;
    if (options.followed !== undefined && item.change !== "removed" && item.after === options.followed) break;
    found.push({ item, by: series.by, at: series.at });
    if ((options.followed !== undefined && item.before === options.followed) || item.change === "created") break;
  }
  return found;
}

function rowOf(number: number, entry: OutlineChapterEntry | undefined, history: Told[], reviewedAt: string | undefined, rest: Omit<WhatChangedRow, "number" | "title" | "change" | "series" | "fresh">): WhatChangedRow {
  // The journal tells the last change only when it leaves the entry as it is now: else the file changed elsewhere, and only the change itself is known.
  const latest = history[0] && (history[0].item.change === "removed" ? !entry : history[0].item.after === entry?.contentDigest) ? history[0] : undefined;
  return {
    number,
    title: entry?.title.trim() || latest?.item.title || "",
    change: latest?.item.change ?? (entry ? "changed" : "removed"),
    ...(latest?.item.from !== undefined ? { from: latest.item.from } : {}),
    ...(latest?.item.edited ? { edited: true } : {}),
    ...(latest ? { by: latest.by, at: latest.at } : {}),
    series: latest ? history.length : 0,
    fresh: !reviewedAt || Boolean(latest && latest.at > reviewedAt),
    ...rest,
  };
}

/** What the author already decided about the change of the entry of chapter `number` (its digest now: `digest`), as the state keeps it. */
function heldOf(state: AutopilotState | null, number: number, digest: string | undefined): Pick<WhatChangedRow, "held" | "decision"> {
  // Only the Synopsis being applied holds a change of an entry: a review of the book revises chapters for another reason.
  const item = state?.campaign?.reason === "outline-change" ? state.campaign.chapters.find((entry) => entry.number === number && (entry.status === "waiting" || entry.status === "working")) : undefined;
  if (item) return { held: item.status === "working" ? "rewriting" : item.mode === "keep" ? "keeping" : "applying" };
  if (digest && state?.deferredChanges?.some((entry) => entry.kind === "outline" && entry.number === number && entry.fingerprint === digest)) return { held: "deferred" };
  const decided = state?.pendingReviews?.find((entry) => entry.kind === "outline" && entry.number === number && !entry.started);
  return decided ? { held: "decided", decision: decided.action } : {};
}

/** The view of a book now (see the module). */
export function whatChanged({ entries, journal, state, written }: WhatChangedInput): WhatChanged {
  const byNumber = new Map(entries.map((entry) => [entry.number, entry]));
  const reviewedAt = journal.reviewedAt;
  const since: WhatChangedSince = reviewedAt ? { kind: "review", at: reviewedAt } : state?.updatedAt ? { kind: "autopilot", at: state.updatedAt } : { kind: "always" };
  const after = since.kind === "always" ? undefined : since.at;
  const unreviewed = journal.series.some((series) => !reviewedAt || series.at > reviewedAt);
  const plan = state?.plan?.approved ? state.plan : null;
  const rows: WhatChangedRow[] = [];
  const listed = new Set<number>();
  const add = (row: WhatChangedRow) => {
    rows.push(row);
    listed.add(row.number);
  };

  if (plan) {
    const hasEntries = entries.length > 0;
    const highest = plan.chapters.reduce((most, chapter) => Math.max(most, chapter.number), 0);
    for (const chapter of plan.chapters) {
      const entry = byNumber.get(chapter.number);
      const isWritten = isPlannedChapterWritten(chapter) || written.has(chapter.number);
      const base = { pending: true, written: isWritten, approved: chapter.status === "done", imported: chapter.imported === true };
      if (entry) {
        if (entry.unreadable) continue;
        // The rule of `outlinePlanStatus`: a chapter follows its entry while its digest is the plan's; for a plan that does not remember one, an entry the
        // autopilot wrote is the chapter's own, only an entry of the author binds a chapter not written yet, and a written one changes nothing.
        const changed = chapter.outlineDigest ? entry.contentDigest !== chapter.outlineDigest : !isWritten && !entry.intact;
        const held = heldOf(state, chapter.number, entry.contentDigest);
        // The chapter being rewritten follows its new entry already (its plan keeps it from the start of the rewrite): it is listed until it is closed again.
        if (!changed && held.held !== "rewriting") continue;
        add(rowOf(chapter.number, entry, historyOf(journal, chapter.number, changed ? { followed: chapter.outlineDigest } : {}), reviewedAt, { ...base, outcome: changeOfWritten(state, chapter.number), digest: entry.contentDigest, ...held }));
      } else if (chapter.outlineDigest && hasEntries) {
        add(rowOf(chapter.number, undefined, historyOf(journal, chapter.number, { followed: chapter.outlineDigest }), reviewedAt, { ...base, outcome: changeOfWritten(state, chapter.number, { entry: "removed" }) }));
      }
    }
    // An entry after the last chapter of the plan: the book gets longer, and the autopilot plans it once its plan is done.
    for (const entry of entries) {
      if (entry.number <= highest || entry.unreadable) continue;
      add(rowOf(entry.number, entry, historyOf(journal, entry.number), reviewedAt, { outcome: "extends", pending: true, written: written.has(entry.number), approved: false, imported: false, digest: entry.contentDigest }));
    }
  }

  // What else the journal tells since then: taken into account already (a plan), or to be followed when the autopilot plans the book (none yet).
  const told = new Set<number>();
  for (const series of journal.series) {
    if (after && series.at <= after) continue;
    for (const item of series.chapters) if (!listed.has(item.chapter)) told.add(item.chapter);
  }
  for (const number of told) {
    const entry = byNumber.get(number);
    const chapter = plan?.chapters.find((candidate) => candidate.number === number);
    const outcome: WhatChangedOutcome = !plan ? "no-plan" : chapter || !entry ? "followed" : "none";
    const isWritten = written.has(number) || Boolean(chapter && isPlannedChapterWritten(chapter));
    add(rowOf(number, entry, historyOf(journal, number, { after }), reviewedAt, { outcome, pending: false, written: isWritten, approved: chapter?.status === "done", imported: chapter?.imported === true, ...(entry ? { digest: entry.contentDigest } : {}) }));
  }

  rows.sort((left, right) => left.number - right.number);
  return { mode: plan ? "plan" : "journal", rows, since, unreviewed };
}

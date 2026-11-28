import { appendOutlineJournal, outlineJournalChaptersOf, type OutlineJournalSeen } from "../book/outline-journal.js";
import { outlineDesignOf, outlineEntryDigest, serializeOutlineChapter, type OutlineChapterEntry } from "../book/outline.js";
import type { OutlineDesignPatch } from "../book/design.js";
import { OUTLINE_CHANGES_FILE, canonPath, canonSlug } from "../book/paths.js";
import type { BookSnapshot } from "../book/snapshot.js";
import type { BookFileChange } from "../book/store.js";
import { renderMarkdown } from "../markdown/frontmatter.js";
import { isItalian } from "../util/text.js";
import { AutopilotDesignError, endDesign } from "./design.js";
import { completionWaiting, missingDesignKeys } from "./design-complete.js";
import { sameCanonEntity } from "./tasks.js";
import type { AutopilotState, DesignCompletionFinding } from "./types.js";

/**
 * Applying what «Review and complete» proposes (`AutopilotSession.applyDesignProposals`, #125): the author chooses, and one commit writes it. A field is written only where
 * the entry still lacks it (one the author filled meanwhile stays the author's); a finding becomes a note for the ghostwriter of its chapter, after the notes there; a canon
 * entry is created as a draft, unless the canon has it now. The title, the text and the rest of the design of an entry never change, and it stays the author's. The entries
 * written are a series of the journal of the Synopsis, by the autopilot. Pure: the session reads the book and commits.
 */

/** What the author decides about the proposals that wait. */
export interface DesignProposalsDecision {
  /** The «Review and complete» the author looked at (`AutopilotDesign.startedAt`): a decision about another one is `stale`. */
  run: string;
  /** The proposals to apply, by their ids (`DesignFieldProposal.id`, `DesignCompletionFinding.id`, `DesignCanonProposal.id`); every other one that waits is left out. */
  apply: string[];
}

/** What applying did. */
export interface DesignProposalsResult {
  applied: number;
  /** Left out: the ones not chosen, and the chosen ones the book no longer needs (`outdated`). */
  skipped: number;
  /** Chosen, but not written: the entry has the field now, it is no longer the author's, or the canon has the entity. */
  outdated: number;
  /** The chapters whose entry was written, and the canon files created. */
  chapters: number[];
  created: string[];
  /** What a locked decision of the author held (`bible/decisions.md`): its proposals are left out, and said here, a line each in the language of the book. */
  held: string[];
  /** The version of the Synopsis and the Bible kept as they were before (`history/design/…`), when something was written. */
  version?: string;
}

/** A finding as a note for the ghostwriter of its chapter. */
export function findingNote(finding: Pick<DesignCompletionFinding, "text" | "suggestion" | "source" | "by">, language: string): string {
  const italian = isItalian(language);
  const who = finding.source === "director" ? (italian ? "il direttore" : "the director") : finding.source === "reader" ? finding.by || (italian ? "un lettore" : "a reader") : italian ? "l'architetto" : "the architect";
  return `${italian ? "Revisione" : "Review"} (${who}): ${finding.text}${finding.suggestion ? ` — ${finding.suggestion}` : ""}`;
}

/** Throws `AutopilotDesignError` unless the decision is one about the proposals that wait now. */
function checkDecision(state: AutopilotState, decision: DesignProposalsDecision): Set<string> {
  if (!decision || typeof decision !== "object" || typeof decision.run !== "string" || !Array.isArray(decision.apply) || decision.apply.some((id) => typeof id !== "string")) {
    throw new AutopilotDesignError("invalid_request", "A decision about the proposals is { run, apply: [ids] }.");
  }
  const design = state.design;
  const completion = design?.mode === "complete" ? design.completion : undefined;
  if (!design || !completion || completion.decided || !completionWaiting(completion).waiting) throw new AutopilotDesignError("no_proposals", "No proposal of «Review and complete» waits for a decision.");
  if (design.startedAt !== decision.run) throw new AutopilotDesignError("stale", "The proposals changed since they were looked at: look at them again.");
  const waiting = new Set<string>();
  for (const entry of Object.values(completion.entries)) {
    for (const field of entry.fields) if (field.status === "waiting") waiting.add(field.id);
    for (const finding of entry.findings) if (finding.status === "waiting") waiting.add(finding.id);
  }
  for (const proposal of completion.canon) if (proposal.status === "waiting") waiting.add(proposal.id);
  const unknown = decision.apply.filter((id) => !waiting.has(id));
  if (unknown.length) throw new AutopilotDesignError("invalid_request", `Not a proposal that waits: ${unknown.slice(0, 5).join(", ")}.`);
  return new Set(decision.apply);
}

/**
 * The changes of the book and the state once the author's decision is applied (pure). `entries`: the Synopsis as it is now; `journal`: `outline/changes.yml` as it is.
 * Throws `AutopilotDesignError`: `invalid_request`, `no_proposals`, `stale`.
 */
export async function designProposalsChanges(input: {
  state: AutopilotState;
  decision: DesignProposalsDecision;
  entries: readonly OutlineChapterEntry[];
  snapshot: Pick<BookSnapshot, "canon" | "files">;
  journal: { content: string; hash: string } | null;
  now: Date;
  language: string;
  /** The files a locked decision holds (`lockedDecisionConflicts` of the changes without it), and what it says of each: what would change there is not written. */
  held?: ReadonlyMap<string, string>;
}): Promise<{ state: AutopilotState; changes: BookFileChange[]; result: DesignProposalsResult }> {
  const chosen = checkDecision(input.state, input.decision);
  const state = structuredClone(input.state);
  const completion = state.design!.completion!;
  const at = input.now.toISOString();
  const byNumber = new Map(input.entries.map((entry) => [entry.number, entry]));
  const changes: BookFileChange[] = [];
  const was = new Map<number, OutlineJournalSeen>();
  const now = new Map<number, OutlineJournalSeen>();
  const result: DesignProposalsResult = { applied: 0, skipped: 0, outdated: 0, chapters: [], created: [], held: [...new Set(input.held?.values() ?? [])] };
  const held = (path: string) => input.held?.has(path) === true;
  const decide = <T extends { id: string; status: string }>(item: T, writable: boolean): boolean => {
    if (item.status !== "waiting") return false;
    if (!chosen.has(item.id)) {
      item.status = "skipped";
      result.skipped += 1;
      return false;
    }
    if (!writable) {
      item.status = "skipped";
      result.skipped += 1;
      result.outdated += 1;
      return false;
    }
    item.status = "applied";
    result.applied += 1;
    return true;
  };

  for (const proposals of Object.values(completion.entries).sort((left, right) => left.number - right.number)) {
    const entry = byNumber.get(proposals.number);
    // Only an entry of the author's that can be read is written: one the autopilot owns now, or one gone, keeps the proposals as they were left.
    const usable = entry && !entry.intact && !entry.unreadable && !held(entry.path) ? entry : undefined;
    const missing = new Set(usable ? missingDesignKeys(usable.design) : []);
    const patch: OutlineDesignPatch = {};
    for (const field of proposals.fields) {
      if (decide(field, Boolean(usable) && missing.has(field.key))) (patch as Record<string, unknown>)[field.key] = field.value;
    }
    const notes: string[] = [];
    for (const finding of proposals.findings) if (decide(finding, Boolean(usable))) notes.push(findingNote(finding, input.language));
    if (!usable || (!Object.keys(patch).length && !notes.length)) continue;
    if (notes.length) {
      const base = (typeof patch.notes === "string" ? patch.notes : usable.design?.notes ?? "").trim();
      patch.notes = [base, ...notes.filter((line) => !base.includes(line))].filter(Boolean).join("\n");
    }
    const content = serializeOutlineChapter({ number: usable.number, title: usable.title, body: usable.body, ghostwriter: usable.ghostwriter, design: patch, origin: "author", frontmatter: usable.frontmatter });
    changes.push({ path: usable.path, content, expectedHash: usable.hash ?? null });
    const digest = await outlineEntryDigest({ title: usable.title, body: usable.body, ghostwriter: usable.ghostwriter, design: outlineDesignOf({ design: patch, frontmatter: usable.frontmatter }) });
    was.set(usable.number, { title: usable.title, digest: usable.contentDigest });
    now.set(usable.number, { title: usable.title, digest });
    result.chapters.push(usable.number);
  }

  // The canon the chapters need, created as a draft (two names that make one file name get -2, -3…).
  const taken = new Set([...input.snapshot.files.keys()].map((path) => path.toLowerCase()));
  const known = input.snapshot.canon.map((entry) => ({ kind: entry.kind, names: [entry.name, ...entry.aliases] }));
  for (const proposal of completion.canon) {
    const exists = known.some((entry) => entry.kind === proposal.kind && sameCanonEntity(proposal.kind, proposal.name, entry.names));
    const base = canonSlug(proposal.kind, proposal.name);
    let slug = base;
    for (let number = 2; taken.has(canonPath(proposal.kind, slug).toLowerCase()); number += 1) slug = `${base}-${number}`;
    const path = canonPath(proposal.kind, slug);
    if (!decide(proposal, !exists && !held(path))) continue;
    taken.add(path.toLowerCase());
    known.push({ kind: proposal.kind, names: [proposal.name] });
    const label = proposal.kind === "secret" ? { title: proposal.name } : { name: proposal.name };
    changes.push({ path, content: renderMarkdown({ type: proposal.kind, id: `${proposal.kind}:${slug}`, ...label, canon: "draft" }, `# ${proposal.name}\n\n${proposal.description}`.trim()), expectedHash: null });
    result.created.push(path);
  }

  const { chapters, more } = outlineJournalChaptersOf(was, now, input.language);
  if (chapters.length) {
    const italian = isItalian(input.language);
    const note = italian ? `Rivedi e completa: ${result.applied === 1 ? "una proposta applicata" : `${result.applied} proposte applicate`}` : `Review and complete: ${result.applied === 1 ? "one proposal applied" : `${result.applied} proposals applied`}`;
    changes.push({
      path: OUTLINE_CHANGES_FILE,
      content: appendOutlineJournal(input.journal?.content, { id: `autopilot-${input.now.getTime().toString(36)}`, at, by: "autopilot", note, chapters, ...(more ? { more } : {}) }, input.now),
      expectedHash: input.journal?.hash ?? null,
    });
  }
  completion.decided = { at, applied: result.applied, skipped: result.skipped };
  delete completion.awaitingAuthor;
  // A «Review and complete» that was paused before its end ends here: the author took what it had.
  if (!state.design!.endedAt) endDesign(state, "author", at);
  return { state, changes, result };
}

import type { AiPort } from "../ai/types.js";
import { chapterLines } from "../autopilot/outline.js";
import { registerPlateauBreaker, type ReviewPlateau, type ReviewPlateauAnswer, type ReviewPlateauBreaker, type ReviewPlateauContext } from "../autopilot/plateau.js";
import { reviewWildcards } from "../autopilot/review-policy.js";
import type { InsightExtra, TaskAi, TaskContext, TaskResult } from "../autopilot/tasks.js";
import type { AutopilotState, InsightTone } from "../autopilot/types.js";
import { decisionsBlock, type BibleDecisions } from "../book/bible.js";
import { canonManifest, loadDirectorProfile, readBody, referencedChapterNumber } from "../book/context.js";
import { loadDecisions } from "../book/design-load.js";
import { STORY_DESIGN_FILE } from "../book/paths.js";
import type { BookSnapshot } from "../book/snapshot.js";
import type { BookFileChange, BookStore } from "../book/store.js";
import type { DirectorProfile } from "../profiles/director.js";
import { pickWildcardVoices, type WildcardPresetId, type WildcardProfile } from "../profiles/wildcards.js";
import { isItalian, truncate } from "../util/text.js";
import { consultWildcards, loadWildcardPanel, wildcardSecretsChapter, type WildcardConsultResult } from "./context.js";
import type { WildcardTarget } from "./ideas.js";
import { IDEAS_JOURNAL_FILE, appendIdeasJournal } from "./journal.js";
import { triageWildcardIdeas, wildcardIdeasMaterial, type WildcardTriageResult } from "./triage.js";

/**
 * The room of the wildcards in the autopilot (`ReviewPolicy.wildcards`): consulted once before the review of the plan of a design run (the step `wildcards`, a
 * pre-mortem), and when a review of the book stalls (a plateau breaker, registered by the host with `registerWildcardsPlateauBreaker`). The director triages what
 * the room gives (adopted, adapted or rejected, always with the reason, in the journal of the room) and only the ideas it accepts go on: into the review of the
 * design, or into the corrections of the whole book. The room never gives a score and never gates anything; its calls are the step's own (route, record, cost and
 * caps), one voice after the other, within the money cap of a consultation.
 */

/** A consultation the step already paid for, kept a while for the same step tried again (a failure after the room answered): it is not asked twice. */
const KEPT_MS = 6 * 3_600_000;
const KEPT_MAX = 16;
const kept = new WeakMap<BookStore, Map<string, { at: number; consulted: WildcardConsultResult }>>();

function keptConsultation(store: BookStore, key: string): WildcardConsultResult | undefined {
  const entry = kept.get(store)?.get(key);
  return entry && Date.now() - entry.at < KEPT_MS ? entry.consulted : undefined;
}

function keepConsultation(store: BookStore, key: string, consulted: WildcardConsultResult): void {
  const map = kept.get(store) ?? new Map<string, { at: number; consulted: WildcardConsultResult }>();
  map.set(key, { at: Date.now(), consulted });
  while (map.size > KEPT_MAX) map.delete(map.keys().next().value as string);
  kept.set(store, map);
}

/** The voices of a consultation of the autopilot: the preset's first, then the other voices of the book in their order (built-in and the book's own), up to `count`. */
export function autopilotWildcardVoices(panel: readonly WildcardProfile[], preset: WildcardPresetId, count: number): string[] {
  const first = pickWildcardVoices(panel, { preset, max: count });
  const others = panel.filter((profile) => profile.enabled && !profile.warnings?.length && !first.includes(profile));
  return [...first, ...others].slice(0, Math.max(1, count)).map((profile) => profile.id);
}

type Insight = (tone: InsightTone, title: string, detail?: string, extra?: InsightExtra) => void;

interface AutopilotRoom {
  bookId: string;
  store: BookStore;
  snapshot: BookSnapshot;
  ai: TaskAi;
  signal: AbortSignal;
  now: () => Date;
  director: DirectorProfile;
  language: string;
  constraints: readonly string[];
  /** The decisions of the book (`bible/decisions.md`): the locked ones bind the director's triage as the author's rules do. */
  decisions?: BibleDecisions;
  policy: ReturnType<typeof reviewWildcards>;
  preset: WildcardPresetId;
  target: Omit<WildcardTarget, "label">;
  material: string;
  question: string;
  /** What keeps the consultation for the same step tried again. */
  key: string;
  insight: Insight;
}

export interface AutopilotRoomOutcome {
  consulted: WildcardConsultResult;
  triage: WildcardTriageResult | null;
  /** The accepted ideas as material (`wildcardIdeasMaterial`); empty when the director accepted none. */
  material: string;
  /** The journal of the room with this consultation and the director's decisions; `null` when the room gave nothing. */
  change: BookFileChange | null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the room did, said once: the voices, the ideas, what the director accepted (and of what), and what was left out. */
function tell(room: AutopilotRoom, consulted: WildcardConsultResult, triage: WildcardTriageResult | null): void {
  const italian = isItalian(room.language);
  const voices = consulted.voices.filter((voice) => voice.status === "ok").length;
  const asked = consulted.asked.length;
  if (!asked) {
    room.insight("warning", italian ? "Nessun Fuori dal coro da consultare: le voci della stanza sono spente o hanno un problema" : "No wildcard to consult: the voices of the room are turned off or have a problem", undefined, { code: "wildcardsNone" });
    return;
  }
  const ideas = consulted.ideas.length;
  const accepted = triage?.accepted ?? [];
  const failed = consulted.voices.filter((voice) => voice.status === "failed").length;
  const skipped = consulted.voices.filter((voice) => voice.status === "skipped").length;
  const title = italian
    ? `I Fuori dal coro: ${plural(voices, "voce", "voci")}, ${plural(ideas, "idea", "idee")}; il direttore ne accoglie ${accepted.length}`
    : `The wildcards: ${plural(voices, "voice", "voices")}, ${plural(ideas, "idea", "ideas")}; the director accepts ${accepted.length}`;
  const detail = [
    accepted.length ? accepted.map((idea) => `${idea.title || truncate(idea.idea, 80)} (${idea.persona.name})`).join(" · ") : "",
    triage?.summary ?? "",
    failed ? (italian ? `${plural(failed, "voce non ha", "voci non hanno")} risposto.` : `${plural(failed, "voice", "voices")} did not answer.`) : "",
    skipped ? (italian ? `Il tetto di spesa della stanza è stato raggiunto: ${plural(skipped, "voce non è stata consultata", "voci non sono state consultate")}.` : `The money cap of the room was reached: ${plural(skipped, "voice was", "voices were")} not asked.`) : "",
    triage?.overCap ? (italian ? `Altre ${triage.overCap} accolte restano nel registro della stanza (al massimo ${accepted.length} proseguono).` : `${triage.overCap} more accepted stay in the journal of the room (at most ${accepted.length} go on).`) : "",
  ].filter(Boolean).join(" ");
  room.insight(accepted.length ? "ok" : "info", title, detail || undefined, { code: "wildcardsTriaged", figures: { voices, ideas, accepted: accepted.length } });
}

/** Consult the room for the autopilot, have the director triage its ideas, and give the journal with both. */
async function consultForAutopilot(room: AutopilotRoom): Promise<AutopilotRoomOutcome> {
  const port: AiPort = { complete: ({ signal: _signal, ...request }) => room.ai(request) };
  let consulted = keptConsultation(room.store, room.key);
  if (!consulted) {
    // The room of the book: the built-in voices and the book's own; the account's stay in the web app (a personal server has none).
    const panel = await loadWildcardPanel(room.store, room.snapshot);
    consulted = await consultWildcards({
      store: room.store,
      ai: port,
      snapshot: room.snapshot,
      panel,
      voices: autopilotWildcardVoices(panel, room.preset, room.policy.voices),
      maxVoices: room.policy.voices,
      preset: room.preset,
      target: room.target,
      material: room.material,
      question: room.question,
      asker: "director",
      by: "autopilot",
      bookId: room.bookId,
      // One voice after the other: what streams is one voice at a time, and the money cap is checked before each.
      parallel: 1,
      ...(room.policy.moneyCap > 0 ? { moneyCap: room.policy.moneyCap } : {}),
      signal: room.signal,
      now: room.now,
    });
    // Kept only when it gave something: a room where no voice answered is asked again by a step tried again.
    if (consulted.ideas.length) keepConsultation(room.store, room.key, consulted);
  }
  if (!consulted.ideas.length) {
    tell(room, consulted, null);
    return { consulted, triage: null, material: "", change: null };
  }
  const triage = await triageWildcardIdeas({
    ai: port,
    director: room.director,
    language: room.language,
    ideas: consulted.ideas,
    target: consulted.target,
    material: room.material,
    context: `CANON:\n${canonManifest(room.snapshot, { includeSecrets: true, max: 60 }) || "-"}`,
    rules: [
      room.constraints.length ? room.constraints.map((rule) => `- ${rule}`).join("\n") : "",
      room.decisions ? decisionsBlock(room.decisions, undefined, { skipMirrored: true }) : "",
    ].filter(Boolean).join("\n\n"),
    signal: room.signal,
    now: room.now,
  });
  const file = await room.store.read(IDEAS_JOURNAL_FILE);
  const content = appendIdeasJournal(file?.content, { ...consulted.entry, ideas: triage.ideas }, room.now());
  tell(room, consulted, triage);
  return {
    consulted,
    triage,
    material: wildcardIdeasMaterial(triage.accepted, room.language),
    change: file?.content === content ? null : { path: IDEAS_JOURNAL_FILE, content, expectedHash: file?.hash ?? null },
  };
}

// ─── Before the review of a design ────────────────────────────────────────────────────────────────

const DESIGN_QUESTION = [
  "This is the design of the book, before the director's first review and before any prose is written.",
  "Imagine the book was written exactly as planned, and failed: why did it fail? And what, in this plan, would make it better?",
  "Name the chapters each point touches.",
].join(" ");

/**
 * The step `wildcards` of a design run: the room reads the plan (a pre-mortem: why the book would fail, what would make it better), the director triages its
 * ideas, and the accepted ones wait in the plan (`AutopilotPlan.wildcardsMaterial`) for the review of the design, which reads them. Once per design.
 */
export async function runDesignWildcards(ctx: TaskContext): Promise<TaskResult> {
  const plan = ctx.state.plan;
  if (!plan) return { changes: [], summary: "No plan for the room to read." };
  plan.wildcardsDone = true;
  delete plan.wildcardsMaterial;
  const storyDesign = await readBody(ctx.store, STORY_DESIGN_FILE, 4_000);
  const material = [
    ctx.state.brief.idea ? `THE AUTHOR'S IDEA:\n${ctx.state.brief.idea}` : "",
    storyDesign ? `STORY DESIGN:\n${storyDesign}` : "",
    `THE CHAPTER PLAN (${plan.chapters.length} chapters):\n${chapterLines(plan.chapters).text}`,
  ].filter(Boolean).join("\n\n");
  const outcome = await consultForAutopilot({
    bookId: ctx.bookId,
    store: ctx.store,
    snapshot: ctx.snapshot,
    ai: ctx.ai,
    signal: ctx.signal,
    now: ctx.now,
    director: ctx.director,
    language: ctx.language,
    constraints: ctx.state.constraints,
    ...(ctx.decisions ? { decisions: ctx.decisions } : {}),
    policy: reviewWildcards(ctx.state),
    preset: "pre-mortem",
    target: { kind: "plan" },
    material,
    question: DESIGN_QUESTION,
    key: `design:${ctx.state.design?.startedAt ?? ""}:${plan.chapters.length}`,
    insight: ctx.insight,
  });
  if (outcome.material) plan.wildcardsMaterial = outcome.material;
  const accepted = outcome.triage?.accepted.length ?? 0;
  return {
    changes: outcome.change ? [outcome.change] : [],
    summary: `${outcome.consulted.voices.filter((voice) => voice.status === "ok").length} voices, ${outcome.consulted.ideas.length} ideas, ${accepted} accepted by the director`,
  };
}

// ─── At a plateau of a review of the book ────────────────────────────────────────────────────────

function vote(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value}/10` : "no vote";
}

function plateauQuestion(plateau: ReviewPlateau): string {
  const where = plateau.kind === "book"
    ? `every chapter has reached its target (${plateau.target}/10), and the book is still at ${vote(plateau.votes.book)}`
    : `${plateau.votes.below} ${plateau.votes.below === 1 ? "chapter is" : "chapters are"} still under the target (${plateau.target}/10, the lowest at ${vote(plateau.votes.lowest)}), and the book is at ${vote(plateau.votes.book)}`;
  return [
    `The review of this book has stalled: ${where}, and two rounds in a row raised nothing. Another identical round will not help.`,
    "What is missing across the chapters (arcs, promises, rhythm, setups and payoffs, the ending, the weight of the parts)? Give what would change the book as a whole, not one more polish of a chapter, and name the chapters each idea touches.",
  ].join(" ");
}

/**
 * The secrets the voices may not be told at the point of the book the room reads (no reveal, or a reveal after it): a point of the director's that names one is
 * left out of what the voices read. The Secrets Guardian is told every secret anyway, by its own rule.
 */
function hiddenSecretNames(snapshot: BookSnapshot, chapter: number | undefined): string[] {
  return snapshot.canon
    .filter((entry) => entry.kind === "secret")
    .filter((secret) => {
      const reveal = referencedChapterNumber(secret.revealIn) ?? referencedChapterNumber(secret.knownFrom);
      return chapter === undefined || reveal === undefined || reveal > chapter;
    })
    .map((secret) => secret.name.trim().toLowerCase())
    .filter((name) => name.length >= 3);
}

function plateauMaterial(state: Readonly<AutopilotState>, snapshot: BookSnapshot): string {
  const points = state.finalReview?.points ?? [];
  const hidden = hiddenSecretNames(snapshot, wildcardSecretsChapter(snapshot, { kind: "book", label: "" }));
  const told = points.filter((point) => !hidden.some((name) => point.toLowerCase().includes(name)));
  if (!told.length) return "";
  return `WHAT THE DIRECTOR SAID OF THE WHOLE BOOK (the points of its last judgement):\n${told.map((point, index) => `${index + 1}. ${point}`).join("\n")}`;
}

/**
 * The plateau breaker of the room (`ReviewPlateauBreaker`): when a review of the book stalls and its policy turns the room on, the room reads the book (a creative
 * room: the chapters, and the points of the director's judgement it may read), the director triages the ideas, and the accepted ones are the material of the
 * corrections of the whole book (`continue`). With none accepted it stops, and the review ends at the plateau as it would have. The journal of the room is written
 * with the step's commit either way.
 */
export const wildcardsPlateauBreaker: ReviewPlateauBreaker = async (plateau: ReviewPlateau, context: ReviewPlateauContext): Promise<ReviewPlateauAnswer> => {
  const policy = reviewWildcards(context.state);
  if (!policy.plateau) return { action: "stop" };
  const [director, decisions] = await Promise.all([loadDirectorProfile(context.store, plateau.language), loadDecisions(context.store)]);
  const outcome = await consultForAutopilot({
    bookId: context.bookId,
    store: context.store,
    snapshot: context.snapshot,
    ai: context.ai,
    signal: context.signal,
    now: context.now ?? (() => new Date()),
    director,
    language: plateau.language,
    constraints: context.state.constraints,
    decisions,
    policy,
    preset: "creative-room",
    target: { kind: "book" },
    material: plateauMaterial(context.state, context.snapshot),
    question: plateauQuestion(plateau),
    key: `plateau:${plateau.campaignId}:${plateau.round}:${plateau.broken}`,
    insight: context.insight,
  });
  const changes = outcome.change ? [outcome.change] : [];
  return outcome.material ? { action: "continue", material: outcome.material, ...(changes.length ? { changes } : {}) } : { action: "stop", ...(changes.length ? { changes } : {}) };
};

/** Whether the room takes on a plateau of this book: its policy turns it on, and the review was taken on fewer times than the consultations it allows. */
export function wildcardsTakePlateau(state: Readonly<AutopilotState>): boolean {
  const policy = reviewWildcards(state);
  return policy.plateau && (state.campaign?.review?.broken ?? 0) < policy.rounds;
}

let registered: { off: () => void; holders: number } | null = null;

/**
 * Register the room's plateau breaker, where the host starts (the web app, the personal server): once, however many times it is asked. It takes on only the
 * plateaus of the books whose review policy turns the room on (`wildcardsTakePlateau`); for every other book a plateau ends the review as it always did.
 * Answers the function that lets it go: the breaker is taken away when every host that registered it let it go.
 */
export function registerWildcardsPlateauBreaker(): () => void {
  if (!registered) registered = { off: registerPlateauBreaker(wildcardsPlateauBreaker, { applies: wildcardsTakePlateau }), holders: 0 };
  registered.holders += 1;
  let released = false;
  return () => {
    if (released || !registered) return;
    released = true;
    registered.holders -= 1;
    if (registered.holders > 0) return;
    registered.off();
    registered = null;
  };
}

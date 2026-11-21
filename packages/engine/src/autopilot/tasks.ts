import { AI_CAPABILITIES, type AiRequest, type AiResponse } from "../ai/types.js";
import {
  canonDetails,
  canonManifest,
  ghostwriterBlock,
  isThinDocument,
  loadChapterParagraphs,
  loadGhostwriter,
  markedChapterText,
  mentionedCanon,
  readBody,
  readDocument,
  secretRules,
  type LoadedParagraph,
} from "../book/context.js";
import {
  AUTOPILOT_PLAN_FILE,
  BOOK_FILE,
  CONTEXT_FILE,
  PLOT_FILE,
  STORY_DESIGN_FILE,
  TOTAL_RESUME_FILE,
  canonPath,
  chapterFilePath,
  chapterResumePath,
  chapterSlug,
  directorOpinionPath,
  formatOrdinal,
  paragraphFilePath,
  paragraphId,
  paragraphSlug,
  readerEvaluationPath,
  readerSummaryPath,
  slugify,
} from "../book/paths.js";
import type { BookSnapshot, ChapterInfo } from "../book/snapshot.js";
import type { BookFileChange, BookStore } from "../book/store.js";
import { askDirector, directorSystemPrompt, renderDirectorOpinion, type DirectorOpinion } from "../director/opinion.js";
import { frontmatterString, parseMarkdown, renderMarkdown } from "../markdown/frontmatter.js";
import { directorPrompt, type DirectorProfile } from "../profiles/director.js";
import { readerPersonaSystemPrompt, type ReaderPersonaProfile } from "../profiles/readers.js";
import { currentRequest, untrustedData } from "../prompt/trust.js";
import {
  READER_EVALUATION_TOOL,
  READER_SUMMARY_TOOL,
  chapterReaderText,
  normalizeReaderEvaluationOutput,
  renderReaderEvaluationBody,
  renderReaderSummaryBody,
} from "../readers/evaluation.js";
import { sha256Hex } from "../util/hash.js";
import { asArray, asInteger, asNumber, asOneOf, asRecord, asString, asStringList } from "../util/json.js";
import { bulletList, countWords, isItalian, languageName, tail, truncate } from "../util/text.js";
import { importedChapters, type TaskDescriptor } from "./planner.js";
import {
  CHAPTER_REVIEW_TOOL,
  CONCEPT_TOOL,
  CONSOLIDATION_TOOL,
  FINDINGS_TOOL,
  IMPACT_TOOL,
  PLAN_REACTION_TOOL,
  PLAN_REVIEW_TOOL,
  PLAN_TOOL,
  SCENES_TOOL,
  SCENE_SUMMARY_TOOL,
  architectSystemPrompt,
  continuitySystemPrompt,
  specialistsSystemPrompt,
  writerSystemPrompt,
} from "./prompts.js";
import { MAX_DIRECTOR_NOTES } from "./state.js";
import type { AuthorIntervention, AutopilotPlan, AutopilotState, InsightTone, PlannedChapter, PlannedScene, ReviewDecision, ReviewFinding } from "./types.js";

export type TaskAi = (request: Omit<AiRequest, "signal">) => Promise<AiResponse>;

export interface TaskContext {
  bookId: string;
  store: BookStore;
  /** Working copy of the state owned by this step: tasks mutate it directly. */
  state: AutopilotState;
  snapshot: BookSnapshot;
  director: DirectorProfile;
  readerPanel: ReaderPersonaProfile[];
  language: string;
  task: TaskDescriptor;
  /** Author "next step" notes delivered to this step. */
  notes: AuthorIntervention[];
  now: () => Date;
  signal: AbortSignal;
  ai: TaskAi;
  insight: (tone: InsightTone, title: string, detail?: string) => void;
}

export interface TaskResult {
  changes: BookFileChange[];
  summary: string;
}

// ─── Shared prompt fragments ────────────────────────────────────────────────

function bookHeader(ctx: TaskContext): string {
  const brief = ctx.state.brief;
  return [
    `BOOK: ${ctx.snapshot.book.title}`,
    `LANGUAGE: ${languageName(ctx.language)}`,
    brief.genre ? `GENRE: ${brief.genre}` : "",
    brief.audience ? `AUDIENCE: ${brief.audience}` : "",
  ].filter(Boolean).join("\n");
}

function briefBlock(ctx: TaskContext): string {
  const brief = ctx.state.brief;
  return [
    brief.idea ? `AUTHOR'S IDEA:\n${brief.idea}` : "",
    brief.synopsis ? `AUTHOR'S CHAPTER-BY-CHAPTER SYNOPSIS (binding):\n${brief.synopsis}` : "",
    `TARGET: ${brief.targetChapters} chapters, ${brief.scenesPerChapter} scenes per chapter, about ${brief.wordsPerScene} words per scene.`,
  ].filter(Boolean).join("\n\n");
}

/** Author rules travel as instructions (they come from the author), never as repository data. */
function authorRules(ctx: TaskContext, includeNotes = true): string {
  const blocks: string[] = [];
  if (ctx.state.constraints.length) blocks.push(`Binding author rules:\n${bulletList(ctx.state.constraints)}`);
  if (includeNotes && ctx.notes.length) blocks.push(`Author notes for this step (they override your own choices):\n${bulletList(ctx.notes.map((note) => note.text))}`);
  return blocks.join("\n\n");
}

function directorGuidance(ctx: TaskContext): string {
  return ctx.state.directorNotes.length ? `DIRECTOR'S STANDING GUIDANCE:\n${bulletList(ctx.state.directorNotes)}` : "";
}

function directorTaste(profile: DirectorProfile): string {
  return [
    profile.priorities.length ? `Priorities:\n${bulletList(profile.priorities)}` : "",
    profile.taste.length ? `Taste:\n${bulletList(profile.taste)}` : "",
    profile.redLines.length ? `Red lines (never allowed):\n${bulletList(profile.redLines)}` : "",
    profile.body.trim() ? `Vision:\n${truncate(profile.body.trim(), 2500)}` : "",
  ].filter(Boolean).join("\n\n");
}

function planOutline(plan: AutopilotPlan | null, options: { scenes?: boolean; upTo?: number } = {}): string {
  if (!plan?.chapters.length) return "No plan yet.";
  return plan.chapters
    .filter((chapter) => options.upTo === undefined || chapter.number <= options.upTo)
    .map((chapter) => {
      const lines = [`${chapter.number}. ${chapter.title}${chapter.imported ? " (already written by the author)" : ""}${chapter.status === "done" ? " [done]" : ""}`];
      if (chapter.summary) lines.push(`   ${chapter.summary}`);
      if (chapter.reveals.length) lines.push(`   Reveals: ${chapter.reveals.join("; ")}`);
      if (options.scenes) for (const scene of chapter.scenes) lines.push(`   - Scene ${scene.number}: ${scene.title}${scene.summary ? ` — ${scene.summary}` : scene.goal ? ` — ${scene.goal}` : ""}`);
      return lines.join("\n");
    })
    .join("\n");
}

function chapterPlanBlock(chapter: PlannedChapter): string {
  return [
    `CHAPTER ${chapter.number}: ${chapter.title}`,
    chapter.summary ? `Summary: ${chapter.summary}` : "",
    chapter.goal ? `Purpose: ${chapter.goal}` : "",
    chapter.pov.length ? `Point of view: ${chapter.pov.join(", ")}` : "",
    chapter.keyEvents.length ? `Key events:\n${bulletList(chapter.keyEvents)}` : "",
    chapter.reveals.length ? `Reveals:\n${bulletList(chapter.reveals)}` : "",
  ].filter(Boolean).join("\n");
}

function scenePlanBlock(scene: PlannedScene, label = "THIS SCENE"): string {
  return [
    `${label} — Scene ${scene.number}: ${scene.title}`,
    scene.goal ? `Goal: ${scene.goal}` : "",
    scene.pov ? `Point of view: ${scene.pov}` : "",
    scene.location ? `Location: ${scene.location}` : "",
    scene.characters.length ? `Characters: ${scene.characters.join(", ")}` : "",
    scene.beats.length ? `Beats:\n${scene.beats.map((beat, index) => `${index + 1}. ${beat}`).join("\n")}` : "",
    scene.summary ? `Planned outcome: ${scene.summary}` : "",
  ].filter(Boolean).join("\n");
}

function data(sections: Array<string | false | undefined | null>): string {
  return untrustedData("repository_content", sections.filter((section): section is string => Boolean(section && section.trim())).join("\n\n"));
}

function request(lines: Array<string | false | undefined | null>): string {
  return currentRequest(lines.filter((line): line is string => Boolean(line && line.trim())).join("\n\n"));
}

function mergeNotes(existing: string[], incoming: string[]): string[] {
  const merged = [...existing];
  for (const note of incoming.map((entry) => entry.trim()).filter(Boolean)) if (!merged.includes(note)) merged.push(note);
  return merged.slice(-MAX_DIRECTOR_NOTES);
}

function chapterOf(ctx: TaskContext): PlannedChapter {
  const chapter = ctx.state.plan?.chapters.find((entry) => entry.number === ctx.task.chapterNumber);
  if (!chapter) throw new Error(`Chapter ${ctx.task.chapterNumber} is not in the plan.`);
  return chapter;
}

function sceneOf(chapter: PlannedChapter, number: number | undefined): PlannedScene {
  const scene = chapter.scenes.find((entry) => entry.number === number);
  if (!scene) throw new Error(`Scene ${number} is not in the plan of chapter ${chapter.number}.`);
  return scene;
}

function chapterFiles(ctx: TaskContext, chapter: PlannedChapter): ChapterInfo {
  return ctx.snapshot.chapters.find((entry) => entry.slug === chapter.slug)
    ?? { slug: chapter.slug, number: chapter.number, title: chapter.title, pov: chapter.pov, path: chapterFilePath(chapter.slug), paragraphs: [] };
}

/** Strip wrappers models sometimes add around prose. */
export function cleanProse(text: string): string {
  let value = (text ?? "").trim();
  value = value.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  const lines = value.split(/\r?\n/);
  while (lines.length && (/^#{1,6}\s/.test(lines[0].trim()) || /^(?:scene|scena)\s+\d+\s*[:.—-]/i.test(lines[0].trim()) || !lines[0].trim())) lines.shift();
  return lines.join("\n").trim();
}

function assertProse(text: string, minimumWords: number): void {
  if (!text.trim()) throw new Error("The model returned an empty scene.");
  if (/^[{[]/.test(text.trim())) throw new Error("The model returned data instead of prose.");
  const words = countWords(text);
  if (words < minimumWords) throw new Error(`The scene is too short (${words} words, at least ${minimumWords} expected): the reply was probably cut off.`);
}

function normalizeForMatch(text: string): string {
  return text.replace(/[«»“”„"]/g, "\"").replace(/[‘’`]/g, "'").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

async function changeFor(store: BookStore, path: string, render: (existing: { frontmatter: Record<string, unknown>; body: string } | null) => string | null): Promise<BookFileChange | null> {
  const file = await store.read(path);
  const existing = file ? parseMarkdown(file.content) : null;
  const content = render(existing ? { frontmatter: existing.frontmatter, body: existing.body } : null);
  if (content === null) return null;
  if (file && file.content === content) return null;
  return { path, content, expectedHash: file?.hash ?? null };
}

function chapterDocument(chapter: PlannedChapter): string {
  return renderMarkdown(
    { type: "chapter", id: `chapter:${chapter.slug}`, number: chapter.number, title: chapter.title, summary: chapter.summary, pov: chapter.pov, canon: "draft" },
    `# ${chapter.title}\n\n${chapter.goal || chapter.summary || ""}`,
  );
}

function ensureChapterFile(ctx: TaskContext, chapter: PlannedChapter): BookFileChange | null {
  const path = chapterFilePath(chapter.slug);
  return ctx.snapshot.files.has(path) ? null : { path, content: chapterDocument(chapter), expectedHash: null };
}

/** Human-readable mirror of the plan, refreshed whenever the plan changes. */
export function renderPlanMarkdown(state: AutopilotState, language: string): string {
  const italian = isItalian(language);
  const plan = state.plan;
  const status = (chapter: PlannedChapter) => {
    const labels = italian
      ? { planned: "pianificato", writing: "in scrittura", review: "in revisione", done: "approvato" }
      : { planned: "planned", writing: "writing", review: "in review", done: "approved" };
    return chapter.imported ? (italian ? "scritto dall'autore" : "written by the author") : labels[chapter.status];
  };
  const lines = [
    `# ${italian ? "Piano dell'autopilot" : "Autopilot plan"}`,
    "",
    italian ? "File generato dall'autopilot: lo stato completo è in `autopilot/state.json`." : "Generated by the autopilot: the full state lives in `autopilot/state.json`.",
    "",
    `- ${italian ? "Approvato dal direttore" : "Approved by the director"}: ${plan?.approved ? (italian ? "sì" : "yes") : (italian ? "no" : "no")}`,
    `- ${italian ? "Capitoli" : "Chapters"}: ${plan?.chapters.length ?? 0}`,
  ];
  for (const chapter of plan?.chapters ?? []) {
    lines.push("", `## ${formatOrdinal(chapter.number)} ${chapter.title} (${status(chapter)}${chapter.score ? ` · ${chapter.score}/10` : ""})`, "");
    if (chapter.summary) lines.push(chapter.summary, "");
    for (const scene of chapter.scenes) lines.push(`- ${scene.number}. ${scene.title}${scene.summary ? ` — ${scene.summary}` : scene.goal ? ` — ${scene.goal}` : ""}`);
  }
  if (state.directorNotes.length) lines.push("", `## ${italian ? "Indicazioni del direttore" : "Director's guidance"}`, "", bulletList(state.directorNotes));
  return `${lines.join("\n").trim()}\n`;
}

async function planFileChange(ctx: TaskContext): Promise<BookFileChange | null> {
  const content = renderPlanMarkdown(ctx.state, ctx.language);
  const file = await ctx.store.read(AUTOPILOT_PLAN_FILE);
  if (file?.content === content) return null;
  return { path: AUTOPILOT_PLAN_FILE, content, expectedHash: file?.hash ?? null };
}

async function renderPlot(ctx: TaskContext): Promise<BookFileChange | null> {
  const plan = ctx.state.plan;
  if (!plan) return null;
  const secrets = ctx.snapshot.canon.filter((entry) => entry.kind === "secret");
  const sections: string[] = [];
  for (const chapter of plan.chapters) {
    const sceneLines = chapter.scenes.map((scene) => scene.summary || scene.goal).filter((line): line is string => Boolean(line)).slice(0, 6);
    const revealed = secrets.filter((secret) => secret.revealIn === `chapter:${chapter.slug}`).map((secret) => secret.name);
    sections.push([
      `## Chapter ${formatOrdinal(chapter.number)} ${chapter.title}`,
      "",
      chapter.summary || "Add chapter summary here.",
      "",
      "### What Happens",
      "",
      bulletList(sceneLines.length ? sceneLines : chapter.keyEvents.length ? chapter.keyEvents : ["Not written yet."]),
      "",
      "### Secrets Revealed",
      "",
      bulletList(revealed.length ? revealed : chapter.reveals.length ? chapter.reveals : ["No secret reveal is explicitly tied to this chapter yet."]),
      "",
    ].join("\n"));
  }
  const placed = new Set(plan.chapters.map((chapter) => `chapter:${chapter.slug}`));
  const pending = secrets.filter((secret) => !secret.revealIn || !placed.has(secret.revealIn)).map((secret) => secret.name);
  const body = [
    "# Plot Overview",
    "",
    `- Book: ${ctx.snapshot.book.title}`,
    `- Chapters tracked: ${plan.chapters.length}`,
    `- Chapters approved: ${plan.chapters.filter((chapter) => chapter.status === "done").length}`,
    `- Secrets tracked: ${secrets.length}`,
    "",
    "# Chapter Map",
    "",
    ...sections,
    "# Pending Or Unplaced Reveals",
    "",
    bulletList(pending.length ? pending : ["All current secrets are tied to a chapter reveal, or no secrets exist yet."]),
  ].join("\n");
  return changeFor(ctx.store, PLOT_FILE, (existing) => renderMarkdown(
    { ...(existing?.frontmatter ?? {}), type: "plot", id: "plot:main", title: `${ctx.snapshot.book.title} Plot` },
    body,
  ));
}

function compact(changes: Array<BookFileChange | null>): BookFileChange[] {
  return changes.filter((change): change is BookFileChange => Boolean(change));
}

// ─── Concept ────────────────────────────────────────────────────────────────

async function runConcept(ctx: TaskContext): Promise<TaskResult> {
  const [bookBody, design, context] = await Promise.all([
    readBody(ctx.store, BOOK_FILE, 2500),
    readDocument(ctx.store, STORY_DESIGN_FILE),
    readDocument(ctx.store, CONTEXT_FILE),
  ]);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: "autopilot:concept",
    system: architectSystemPrompt(ctx.language),
    user: `${request([
      `Design the foundation of this novel from the author's brief, for about ${ctx.state.brief.targetChapters} chapters.`,
      "Create 3 to 8 characters with clear desires, fears and arcs, the key locations, factions only when useful, and 1 to 5 secrets that drive the plot, each with the chapter where the reader learns it.",
      ctx.state.brief.synopsis ? "The author's chapter-by-chapter synopsis is binding: the concept must make it possible exactly as written." : "",
      "Reuse the existing canon names instead of duplicating them.",
      authorRules(ctx),
    ])}\n\n${data([
      bookHeader(ctx),
      briefBlock(ctx),
      bookBody ? `BOOK DESCRIPTION:\n${bookBody}` : "",
      design?.document.body ? `CURRENT STORY DESIGN:\n${truncate(design.document.body, 4000)}` : "",
      context?.document.body ? `CURRENT WORLD CONTEXT:\n${truncate(context.document.body, 3000)}` : "",
      ctx.snapshot.canon.length ? `EXISTING CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: true })}` : "",
      `DIRECTOR (the author's taste):\n${directorTaste(ctx.director)}`,
    ])}`,
    json: CONCEPT_TOOL,
    maxOutputTokens: 9000,
    temperature: 0.8,
  });
  const output = asRecord(response.json);
  const storyDesign = asString(output.storyDesign);
  if (!storyDesign) throw new Error("The concept has no story design.");
  const logline = asString(output.logline);
  const changes: Array<BookFileChange | null> = [];
  changes.push({
    path: STORY_DESIGN_FILE,
    content: renderMarkdown(
      design?.document.frontmatter && Object.keys(design.document.frontmatter).length ? design.document.frontmatter : { type: "note", id: "note:story-design", title: "Story Design", scope: "story-design", bucket: "story-design" },
      `${storyDesign.startsWith("#") ? "" : "# Story Design\n\n"}${logline && !storyDesign.includes(logline) ? `> ${logline}\n\n` : ""}${storyDesign}`,
    ),
    expectedHash: design?.file.hash ?? null,
  });
  const contextText = asString(output.context);
  if (contextText && (!context || isThinDocument(context.document.body))) {
    changes.push({
      path: CONTEXT_FILE,
      content: renderMarkdown(context?.document.frontmatter && Object.keys(context.document.frontmatter).length ? context.document.frontmatter : { type: "context", id: "context:book", title: "Book Context" }, contextText),
      expectedHash: context?.file.hash ?? null,
    });
  }
  const created = new Set<string>();
  const create = (kind: "character" | "location" | "faction" | "secret", name: string, frontmatter: Record<string, unknown>, body: string) => {
    const slug = slugify(name);
    const path = canonPath(kind, slug);
    if (!slug || created.has(path) || ctx.snapshot.files.has(path)) return null;
    created.add(path);
    const label = kind === "secret" ? { title: name } : { name };
    changes.push({ path, content: renderMarkdown({ type: kind, id: `${kind}:${slug}`, ...label, ...frontmatter, canon: "draft" }, body), expectedHash: null });
    return slug;
  };
  const characters = asArray(output.characters).slice(0, 10).map(asRecord);
  for (const character of characters) {
    const name = asString(character.name);
    if (!name) continue;
    create("character", name, {
      role_tier: asOneOf(character.roleTier, ["main", "supporting", "secondary", "minor"] as const, "supporting"),
      story_role: asOneOf(character.storyRole, ["protagonist", "deuteragonist", "antagonist", "mentor", "ally", "love-interest", "foil", "comic-relief", "other"] as const, "other"),
      speaking_style: asString(character.voice) || undefined,
      function_in_book: truncate(asString(character.description), 300) || undefined,
      arc: asString(character.arc) || undefined,
      desires: asString(character.desire) ? [asString(character.desire)] : undefined,
      fears: asString(character.fear) ? [asString(character.fear)] : undefined,
    }, `# ${name}\n\n${asString(character.description)}`);
  }
  for (const location of asArray(output.locations).slice(0, 10).map(asRecord)) {
    const name = asString(location.name);
    if (name) create("location", name, { atmosphere: asString(location.atmosphere) || undefined }, `# ${name}\n\n${asString(location.description)}`);
  }
  for (const faction of asArray(output.factions).slice(0, 6).map(asRecord)) {
    const name = asString(faction.name);
    if (name) create("faction", name, { mission: asString(faction.mission) || undefined }, `# ${name}\n\n${asString(faction.description)}`);
  }
  const secrets: AutopilotState["concept"]["secrets"] = [];
  for (const secret of asArray(output.secrets).slice(0, 8).map(asRecord)) {
    const title = asString(secret.title);
    if (!title) continue;
    const holders = asStringList(secret.holders, 10).map((holder) => `character:${slugify(holder)}`);
    const slug = create("secret", title, { holders, stakes: asString(secret.stakes) || undefined, status: "hidden" }, `# ${title}\n\n${asString(secret.truth)}`) ?? slugify(title);
    const revealChapter = asInteger(secret.revealChapter, 0, 0, 999);
    secrets.push({ slug, title, revealChapter: revealChapter || undefined });
  }
  ctx.state.concept = { done: true, generated: true, secrets };
  if (logline) ctx.insight("ok", logline);
  const summary = isItalian(ctx.language)
    ? `${characters.length} personaggi, ${created.size - characters.length >= 0 ? created.size - characters.length : 0} altri elementi di canone, ${secrets.length} segreti.`
    : `${characters.length} characters, ${Math.max(0, created.size - characters.length)} other canon entries, ${secrets.length} secrets.`;
  return { changes: compact(changes), summary: logline ? `${logline} — ${summary}` : summary };
}

// ─── Plan ───────────────────────────────────────────────────────────────────

async function runPlan(ctx: TaskContext): Promise<TaskResult> {
  const imported = importedChapters(ctx.snapshot);
  const previous = ctx.state.plan;
  const startNumber = imported.length ? Math.max(...imported.map((chapter) => chapter.number)) + 1 : 1;
  const count = Math.max(1, ctx.state.brief.targetChapters - imported.length);
  const [design, context, resume] = await Promise.all([
    readBody(ctx.store, STORY_DESIGN_FILE, 6000),
    readBody(ctx.store, CONTEXT_FILE, 2500),
    readBody(ctx.store, TOTAL_RESUME_FILE, 4000),
  ]);
  const revising = Boolean(previous && previous.revisionNotes.length);
  const secretsPlan = ctx.state.concept.secrets.filter((secret) => secret.revealChapter).map((secret) => `- ${secret.title}: reveal in chapter ${secret.revealChapter}`).join("\n");
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: "autopilot:plan",
    system: architectSystemPrompt(ctx.language),
    user: `${request([
      revising
        ? `Revise the chapter plan (chapters ${startNumber}-${startNumber + count - 1}) applying the director's changes:\n${bulletList(previous!.revisionNotes)}`
        : `Plan the next ${count} chapters of the novel, numbered ${startNumber} to ${startNumber + count - 1}.`,
      ctx.state.brief.synopsis ? "Follow the author's chapter-by-chapter synopsis exactly: same chapters, same order, same events. Enrich, never change." : "",
      imported.length ? `Chapters 1-${startNumber - 1} are already written by the author: continue from them without changing them.` : "",
      "Every chapter must change something and raise the stakes; place every secret reveal in a specific chapter; vary the shape of chapters.",
      authorRules(ctx),
    ])}\n\n${data([
      bookHeader(ctx),
      briefBlock(ctx),
      design ? `STORY DESIGN:\n${design}` : "",
      context ? `WORLD CONTEXT:\n${context}` : "",
      `CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: true }) || "-"}`,
      secretsPlan ? `PLANNED REVEALS:\n${secretsPlan}` : "",
      imported.length ? `CHAPTERS ALREADY WRITTEN:\n${imported.map((chapter) => `${chapter.number}. ${chapter.title}${chapter.summary ? ` — ${chapter.summary}` : ""}`).join("\n")}` : "",
      resume ? `STORY SO FAR:\n${resume}` : "",
      revising ? `CURRENT PLAN:\n${planOutline(previous)}` : "",
      `DIRECTOR (the author's taste):\n${directorTaste(ctx.director)}`,
    ])}`,
    json: PLAN_TOOL,
    maxOutputTokens: 9000,
    temperature: 0.7,
  });
  const proposed = asArray(asRecord(response.json).chapters).map(asRecord).filter((chapter) => asString(chapter.title)).slice(0, count);
  if (!proposed.length) throw new Error("The plan contains no chapters.");
  const planned: PlannedChapter[] = proposed.map((chapter, index) => {
    const number = startNumber + index;
    const title = asString(chapter.title);
    return {
      number,
      title,
      slug: chapterSlug(number, title),
      summary: asString(chapter.summary),
      goal: asString(chapter.goal),
      pov: asStringList(chapter.pov, 6),
      keyEvents: asStringList(chapter.keyEvents, 12),
      reveals: asStringList(chapter.reveals, 8),
      status: "planned",
      scenes: [],
    };
  });
  const changes: Array<BookFileChange | null> = [];
  if (previous) {
    const keep = new Set(planned.map((chapter) => chapter.slug));
    for (const old of previous.chapters) {
      if (old.imported || keep.has(old.slug)) continue;
      const files = ctx.snapshot.chapters.find((chapter) => chapter.slug === old.slug);
      const hash = ctx.snapshot.files.get(chapterFilePath(old.slug));
      if (hash && (!files || files.paragraphs.length === 0)) changes.push({ path: chapterFilePath(old.slug), content: null, expectedHash: hash });
    }
  }
  ctx.state.plan = {
    chapters: [...imported, ...planned],
    approved: false,
    rounds: previous?.rounds ?? 0,
    revisionNotes: [],
    readerReactions: previous?.readerReactions ?? [],
    readersDone: previous?.readersDone ?? false,
    awaitingAuthor: false,
  };
  changes.push(await planFileChange(ctx));
  ctx.insight("info", isItalian(ctx.language) ? `${planned.length} capitoli pianificati` : `${planned.length} chapters planned`, planned.slice(0, 8).map((chapter) => `${chapter.number}. ${chapter.title}`).join(" · "));
  return {
    changes: compact(changes),
    summary: planned.map((chapter) => `${chapter.number}. ${chapter.title}`).join("; "),
  };
}

async function runPlanReader(ctx: TaskContext): Promise<TaskResult> {
  const plan = ctx.state.plan!;
  const reader = ctx.readerPanel.find((entry) => entry.slug === ctx.task.reader);
  if (!reader) {
    plan.readersDone = true;
    return { changes: [], summary: "Reader not available." };
  }
  const design = await readBody(ctx.store, STORY_DESIGN_FILE, 2500);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.reader,
    label: `autopilot:plan-reader:${reader.slug}`,
    system: `${readerPersonaSystemPrompt(reader, languageName(ctx.language), "brief")}\n\nYou are reading the pitch and the chapter plan of a novel that is not written yet. React honestly as this reader would.`,
    user: `${request(["React as this reader: would you read this book? What excites you, what worries you, what would you wish for?"])}\n\n${data([
      bookHeader(ctx),
      ctx.state.brief.idea ? `PITCH:\n${ctx.state.brief.idea}` : "",
      design ? `PREMISE:\n${design}` : "",
      `CHAPTER PLAN:\n${planOutline(plan)}`,
    ])}`,
    json: PLAN_REACTION_TOOL,
    maxOutputTokens: 1500,
  });
  const output = asRecord(response.json);
  const reaction = {
    slug: reader.slug,
    name: reader.name,
    interest: Math.round(asNumber(output.interest, 5, 1, 10)),
    reaction: asString(output.reaction),
    concerns: asStringList(output.concerns, 8),
    wishes: asStringList(output.wishes, 8),
  };
  plan.readerReactions = [...plan.readerReactions.filter((entry) => entry.slug !== reader.slug), reaction];
  ctx.insight(reaction.interest >= 7 ? "ok" : reaction.interest >= 5 ? "info" : "warning", `${reader.name}: ${reaction.interest}/10`, reaction.reaction);
  return { changes: [], summary: `${reaction.interest}/10 — ${truncate(reaction.reaction, 240)}` };
}

async function runPlanReview(ctx: TaskContext): Promise<TaskResult> {
  const plan = ctx.state.plan!;
  const design = await readBody(ctx.store, STORY_DESIGN_FILE, 5000);
  const lastRound = plan.rounds >= 2;
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.director,
    label: "autopilot:plan-review",
    system: directorSystemPrompt(ctx.director, ctx.language),
    user: `${request([
      `Review the concept and the chapter plan before any prose is written (review ${plan.rounds + 1}).`,
      "Approve when the plan delivers the brief and the vision with a satisfying shape; otherwise list precise changes chapter by chapter. Weigh the simulated readers by their weights: do not chase every opinion.",
      lastRound ? "This is the final plan review: approve it and turn anything still imperfect into standing guidance." : "",
      ctx.director.autonomy === "full" ? "Never ask the author: decide." : "Ask the author (questionForAuthor) only for a critical choice you cannot settle from the vision and the author's rules.",
      authorRules(ctx, false),
    ])}\n\n${data([
      bookHeader(ctx),
      briefBlock(ctx),
      design ? `STORY DESIGN:\n${design}` : "",
      `CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: true }) || "-"}`,
      `CHAPTER PLAN:\n${planOutline(plan)}`,
      plan.readerReactions.length
        ? `SIMULATED READERS:\n${plan.readerReactions.map((reaction) => `- ${reaction.name} (weight ${ctx.director.readerWeights[reaction.slug] ?? 1}): ${reaction.interest}/10 — ${reaction.reaction}${reaction.concerns.length ? ` Concerns: ${reaction.concerns.join("; ")}.` : ""}${reaction.wishes.length ? ` Wishes: ${reaction.wishes.join("; ")}.` : ""}`).join("\n")}`
        : "",
    ])}`,
    json: PLAN_REVIEW_TOOL,
    maxOutputTokens: 4000,
  });
  const output = asRecord(response.json);
  const verdict = asOneOf(output.verdict, ["approve", "revise"] as const, "approve");
  const score = Math.round(asNumber(output.score, 7, 1, 10));
  const summaryText = asString(output.summary);
  const changesRequested = asArray(output.changes).map(asRecord)
    .map((change) => {
      const instruction = asString(change.instruction);
      const chapterNumber = asInteger(change.chapterNumber, 0, 0, 999);
      return instruction ? `${chapterNumber ? `Chapter ${chapterNumber}: ` : ""}${instruction}` : "";
    })
    .filter(Boolean);
  const guidance = asStringList(output.guidance, 10);
  const changes: Array<BookFileChange | null> = [];
  const approved = verdict === "approve" || lastRound || changesRequested.length === 0;
  if (!approved) {
    plan.rounds += 1;
    plan.revisionNotes = changesRequested;
    ctx.insight("warning", isItalian(ctx.language) ? `Il direttore chiede ${changesRequested.length} modifiche al piano` : `The director asks for ${changesRequested.length} plan changes`, changesRequested.slice(0, 3).join(" · "));
  } else {
    plan.approved = true;
    plan.revisionNotes = [];
    plan.awaitingAuthor = ctx.state.options.pauseAfterPlan || ctx.director.autonomy === "ask-always";
    ctx.state.directorNotes = mergeNotes(ctx.state.directorNotes, [...guidance, ...(lastRound ? changesRequested : [])]);
    for (const chapter of plan.chapters) if (!chapter.imported) changes.push(ensureChapterFile(ctx, chapter));
    for (const secret of ctx.state.concept.secrets) {
      const chapter = plan.chapters.find((entry) => entry.number === secret.revealChapter);
      const path = canonPath("secret", secret.slug);
      if (!chapter || !ctx.snapshot.files.has(path)) continue;
      changes.push(await changeFor(ctx.store, path, (existing) => {
        if (!existing || frontmatterString(existing.frontmatter, "reveal_in")) return null;
        return renderMarkdown({ ...existing.frontmatter, reveal_in: `chapter:${chapter.slug}`, known_from: `chapter:${chapter.slug}` }, existing.body);
      }));
    }
    ctx.insight("ok", isItalian(ctx.language) ? `Piano approvato dal direttore (${score}/10)` : `Plan approved by the director (${score}/10)`, summaryText);
  }
  const question = asRecord(output.questionForAuthor);
  if (ctx.director.autonomy !== "full" && asString(question.question)) {
    ctx.state.question = {
      id: `question-${ctx.now().getTime()}`,
      kind: "director",
      question: asString(question.question),
      context: summaryText,
      options: asStringList(question.options, 5),
      askedAt: ctx.now().toISOString(),
    };
  }
  changes.push(await planFileChange(ctx));
  return { changes: compact(changes), summary: `${approved ? "approve" : "revise"} ${score}/10 — ${summaryText}` };
}

// ─── Scenes and prose ───────────────────────────────────────────────────────

async function runScenes(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const plan = ctx.state.plan!;
  const previous = plan.chapters.find((entry) => entry.number === chapter.number - 1);
  const next = plan.chapters.find((entry) => entry.number === chapter.number + 1);
  const target = ctx.state.brief.scenesPerChapter;
  const [resume, design, secrets] = await Promise.all([
    readBody(ctx.store, TOTAL_RESUME_FILE, 5000),
    readBody(ctx.store, STORY_DESIGN_FILE, 2500),
    secretRules(ctx.store, ctx.snapshot, chapter.number),
  ]);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: `autopilot:scenes:${chapter.number}`,
    system: architectSystemPrompt(ctx.language),
    user: `${request([
      `Break chapter ${chapter.number} «${chapter.title}» into ${target} scenes (one more or one fewer only if the chapter truly needs it).`,
      "Each scene has a goal and a turn, and leads into the next. Respect the reveal rules and the director's guidance.",
      authorRules(ctx),
    ])}\n\n${data([
      bookHeader(ctx),
      directorGuidance(ctx),
      chapterPlanBlock(chapter),
      previous ? `PREVIOUS CHAPTER: ${previous.number}. ${previous.title}${previous.summary ? ` — ${previous.summary}` : ""}` : "",
      next ? `NEXT CHAPTER (to set up): ${next.number}. ${next.title}${next.summary ? ` — ${next.summary}` : ""}` : "",
      resume ? `STORY SO FAR:\n${resume}` : "",
      design ? `STORY DESIGN (excerpt):\n${design}` : "",
      `CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: false }) || "-"}`,
      secrets ? `SECRETS AND REVEAL RULES:\n${secrets}` : "",
    ])}`,
    json: SCENES_TOOL,
    maxOutputTokens: 5000,
    temperature: 0.7,
  });
  const scenes = asArray(asRecord(response.json).scenes).map(asRecord).filter((scene) => asString(scene.title)).slice(0, target + 2);
  if (!scenes.length) throw new Error("The scene plan is empty.");
  chapter.scenes = scenes.map((scene, index) => ({
    number: index + 1,
    title: asString(scene.title),
    goal: asString(scene.goal),
    beats: asStringList(scene.beats, 12),
    pov: asString(scene.pov) || undefined,
    location: asString(scene.location) || undefined,
    characters: asStringList(scene.characters, 12),
    summary: asString(scene.summary) || undefined,
    status: "planned",
    revisions: 0,
  }));
  chapter.status = "writing";
  ctx.insight("info", isItalian(ctx.language) ? `Capitolo ${chapter.number}: ${chapter.scenes.length} scene` : `Chapter ${chapter.number}: ${chapter.scenes.length} scenes`, chapter.scenes.map((scene) => scene.title).join(" · "));
  return { changes: compact([ensureChapterFile(ctx, chapter), await planFileChange(ctx)]), summary: chapter.scenes.map((scene) => `${scene.number}. ${scene.title}`).join("; ") };
}

async function sceneNeighbors(ctx: TaskContext, chapter: PlannedChapter, scene: PlannedScene): Promise<{ previousEnding: string; nextOpening: string; writtenSummaries: string }> {
  const previousScene = chapter.scenes.find((entry) => entry.number === scene.number - 1);
  const nextScene = chapter.scenes.find((entry) => entry.number === scene.number + 1);
  let previousEnding = "";
  if (previousScene?.path) {
    previousEnding = tail(await readBody(ctx.store, previousScene.path, 100000), 2400);
  } else if (scene.number === 1) {
    const previousChapter = ctx.state.plan?.chapters.find((entry) => entry.number === chapter.number - 1);
    const last = previousChapter?.scenes.filter((entry) => entry.path).at(-1);
    if (last?.path) previousEnding = tail(await readBody(ctx.store, last.path, 100000), 1500);
  }
  const nextOpening = nextScene?.path ? truncate(await readBody(ctx.store, nextScene.path, 100000), 900) : "";
  const writtenSummaries = chapter.scenes
    .filter((entry) => entry.number < scene.number && entry.status !== "planned")
    .map((entry) => `- Scene ${entry.number} «${entry.title}»: ${entry.summary ?? entry.goal}`)
    .join("\n");
  return { previousEnding, nextOpening, writtenSummaries };
}

async function runWrite(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const scene = sceneOf(chapter, ctx.task.sceneNumber);
  const nextScene = chapter.scenes.find((entry) => entry.number === scene.number + 1);
  const info = chapterFiles(ctx, chapter);
  const [ghostwriter, context, resume, secrets, neighbors] = await Promise.all([
    loadGhostwriter(ctx.store, ctx.snapshot, info),
    readBody(ctx.store, CONTEXT_FILE, 2000),
    readBody(ctx.store, TOTAL_RESUME_FILE, 5000),
    secretRules(ctx.store, ctx.snapshot, chapter.number),
    sceneNeighbors(ctx, chapter, scene),
  ]);
  const relevant = mentionedCanon(ctx.snapshot, [scene.characters.join(" "), scene.location ?? "", scene.beats.join(" "), scene.goal, scene.pov ?? ""].join(" "));
  const words = ctx.state.brief.wordsPerScene;
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: `autopilot:write:${chapter.number}.${scene.number}`,
    system: writerSystemPrompt(ctx.language),
    user: `${request([
      `Write scene ${scene.number} of chapter ${chapter.number} «${chapter.title}»: «${scene.title}». Target length: about ${words} words.`,
      "Follow the beats in order, start in motion, and end on a turn that leads into the next scene.",
      authorRules(ctx),
    ])}\n\n${data([
      bookHeader(ctx),
      `GHOSTWRITER PROFILE:\n${ghostwriterBlock(ghostwriter)}`,
      `DIRECTOR (the author's taste):\n${directorTaste(ctx.director)}`,
      directorGuidance(ctx),
      context ? `WORLD CONTEXT:\n${context}` : "",
      resume ? `STORY SO FAR:\n${resume}` : "",
      chapterPlanBlock(chapter),
      neighbors.writtenSummaries ? `SCENES ALREADY WRITTEN IN THIS CHAPTER:\n${neighbors.writtenSummaries}` : "",
      neighbors.previousEnding ? `PREVIOUS SCENE ENDING (continue seamlessly):\n${neighbors.previousEnding}` : "",
      scenePlanBlock(scene),
      nextScene ? scenePlanBlock(nextScene, "NEXT SCENE (set it up, do not write it)") : "",
      relevant.length ? `RELEVANT CANON:\n${await canonDetails(ctx.store, relevant)}` : "",
      secrets ? `SECRETS AND REVEAL RULES:\n${secrets}` : "",
    ])}`,
    maxOutputTokens: Math.min(16000, Math.ceil(words * 2.4) + 800),
    temperature: ghostwriter?.temperature ?? 0.8,
  });
  const prose = cleanProse(response.text);
  assertProse(prose, Math.min(150, Math.floor(words * 0.25)));
  let summary = scene.summary ?? scene.goal;
  try {
    const summaryResponse = await ctx.ai({
      capability: AI_CAPABILITIES.summary,
      label: `autopilot:scene-summary:${chapter.number}.${scene.number}`,
      system: continuitySystemPrompt(ctx.language),
      user: `${request(["Summarize this scene in one or two sentences: what happens and what changes."])}\n\n${data([prose])}`,
      json: SCENE_SUMMARY_TOOL,
      maxOutputTokens: 400,
    });
    summary = asString(asRecord(summaryResponse.json).summary) || summary;
  } catch (error) {
    if (ctx.signal.aborted) throw error;
  }
  const slug = paragraphSlug(scene.number, scene.title);
  const path = paragraphFilePath(chapter.slug, slug);
  const content = renderMarkdown(
    { type: "paragraph", id: paragraphId(chapter.slug, slug), chapter: `chapter:${chapter.slug}`, number: scene.number, title: scene.title, summary, viewpoint: scene.pov, canon: "draft" },
    prose,
  );
  scene.status = "written";
  scene.slug = slug;
  scene.path = path;
  scene.summary = summary;
  scene.words = countWords(prose);
  if (chapter.scenes.every((entry) => entry.status !== "planned")) chapter.status = "review";
  ctx.insight("ok", isItalian(ctx.language) ? `Scena ${chapter.number}.${scene.number} scritta: ${scene.words} parole` : `Scene ${chapter.number}.${scene.number} written: ${scene.words} words`, summary);
  return {
    changes: compact([{ path, content, expectedHash: ctx.snapshot.files.get(path) ?? null }, ensureChapterFile(ctx, chapter), await planFileChange(ctx)]),
    summary: `${scene.words} words — ${summary}`,
  };
}

// ─── Chapter review ─────────────────────────────────────────────────────────

async function chapterSource(ctx: TaskContext, chapter: PlannedChapter): Promise<{ paragraphs: LoadedParagraph[]; readerText: string; sourceHash: string; sourceVersion: string }> {
  const paragraphs = await loadChapterParagraphs(ctx.store, chapterFiles(ctx, chapter));
  if (!paragraphs.length) throw new Error(`Chapter ${chapter.number} has no written scenes.`);
  const readerText = chapterReaderText(paragraphs.map((paragraph) => ({ title: paragraph.title, raw: paragraph.raw })));
  return { paragraphs, readerText, sourceHash: await sha256Hex(readerText), sourceVersion: paragraphs.map((paragraph) => paragraph.hash).join(":") };
}

async function runReader(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const review = ctx.state.review!;
  const slug = ctx.task.reader!;
  review.readersPending = review.readersPending.filter((entry) => entry !== slug);
  const reader = ctx.readerPanel.find((entry) => entry.slug === slug);
  if (!reader) return { changes: [], summary: "Reader not available." };
  const source = await chapterSource(ctx, chapter);
  const resume = await readBody(ctx.store, TOTAL_RESUME_FILE, 3000);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.reader,
    label: `reader-evaluation:${reader.slug}`,
    system: readerPersonaSystemPrompt(reader, languageName(ctx.language), "normal"),
    user: `${currentRequest("Evaluate the target as the configured simulated reader.")}\n\n${untrustedData("repository_content", [
      `TARGET: chapter — ${chapter.title}`,
      resume ? `STORY SO FAR (before this chapter):\n${resume}` : "",
      source.readerText,
    ].filter(Boolean).join("\n\n"))}`,
    json: READER_EVALUATION_TOOL,
    maxOutputTokens: 2500,
  });
  const output = normalizeReaderEvaluationOutput(response.json);
  const path = readerEvaluationPath({ kind: "chapter", chapter: chapter.slug }, reader.slug);
  const updatedAt = ctx.now().toISOString();
  const change = await changeFor(ctx.store, path, (existing) => renderMarkdown({
    ...(existing?.frontmatter ?? {}),
    id: `reader-evaluation:chapter:${chapter.slug}:chapter:${reader.slug}`,
    type: "readerEvaluation",
    createdAt: frontmatterString(existing?.frontmatter ?? {}, "createdAt") ?? updatedAt,
    updatedAt,
    targetType: "chapter",
    targetId: `chapter:${chapter.slug}`,
    bookId: ctx.bookId,
    chapterId: chapter.slug,
    readerId: reader.id,
    readerName: reader.name,
    readerType: reader.readerType,
    readerVersion: reader.version,
    language: ctx.language,
    evaluationDepth: "normal",
    sourceContentHash: source.sourceHash,
    sourceContentVersion: source.sourceVersion,
    sourceUpdatedAt: updatedAt,
    routerTask: "reader-evaluation",
    model: response.model,
    provider: response.provider,
    integrationId: response.integrationId,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    estimatedCost: response.cost,
    finalCost: response.cost,
    currency: response.currency,
    score: output.score,
    status: "completed",
    generatedBy: "autopilot",
  }, renderReaderEvaluationBody(output, ctx.language)));
  review.readerScores = [...review.readerScores.filter((entry) => entry.slug !== slug), { slug, name: reader.name, score: output.score, mainProblem: output.mainProblem, prioritySuggestion: output.prioritySuggestion, path }];
  ctx.insight(output.score >= 7 ? "ok" : output.score >= 5 ? "info" : "warning", `${reader.name}: ${output.score}/10`, output.mainProblem || output.generalImpression);
  return { changes: compact([change]), summary: `${output.score}/10 — ${truncate(output.generalImpression, 220)}` };
}

async function runReadersSummary(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const review = ctx.state.review!;
  const evaluations = await Promise.all(review.readerScores.map(async (score) => `READER: ${score.name}\nSCORE: ${score.score}\n${await readBody(ctx.store, score.path, 5000)}`));
  const source = await chapterSource(ctx, chapter);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.readerSummary,
    label: "reader-evaluation-summary",
    system: `Compare the separate simulated-reader evaluations. Preserve disagreements rather than flattening them. Return the summary in ${languageName(ctx.language)}.`,
    user: `${currentRequest("Summarize and compare these reader evaluations.")}\n\n${untrustedData("repository_content", evaluations.join("\n\n---\n\n"))}`,
    json: READER_SUMMARY_TOOL,
    maxOutputTokens: 2500,
  });
  const output = asRecord(response.json);
  const overall = Math.round(asNumber(output.overallScore, 6, 1, 10) * 10) / 10;
  const path = readerSummaryPath({ kind: "chapter", chapter: chapter.slug });
  const updatedAt = ctx.now().toISOString();
  const change = await changeFor(ctx.store, path, (existing) => renderMarkdown({
    ...(existing?.frontmatter ?? {}),
    id: `reader-evaluation-summary:chapter:${chapter.slug}:chapter`,
    type: "readerEvaluationSummary",
    createdAt: frontmatterString(existing?.frontmatter ?? {}, "createdAt") ?? updatedAt,
    updatedAt,
    targetType: "chapter",
    targetId: `chapter:${chapter.slug}`,
    bookId: ctx.bookId,
    chapterId: chapter.slug,
    readerIds: review.readerScores.map((score) => ctx.readerPanel.find((reader) => reader.slug === score.slug)?.id ?? score.slug),
    readerCount: review.readerScores.length,
    language: ctx.language,
    sourceContentHash: source.sourceHash,
    sourceContentVersion: source.sourceVersion,
    routerTask: "reader-evaluation-summary",
    model: response.model,
    provider: response.provider,
    integrationId: response.integrationId,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    finalCost: response.cost,
    currency: response.currency,
    score: overall,
    status: "completed",
    refs: review.readerScores.map((score) => `reader-evaluation:chapter:${chapter.slug}:chapter:${score.slug}`),
    generatedBy: "autopilot",
  }, renderReaderSummaryBody(output, ctx.language)));
  const proposals = [...asStringList(output.revisionPriorities, 5), ...asStringList(output.recurringProblems, 3)]
    .filter((entry, index, list) => list.findIndex((other) => normalizeForMatch(other) === normalizeForMatch(entry)) === index)
    .slice(0, 6);
  const findings: ReviewFinding[] = proposals.map((problem, index) => ({
    id: `R${review.round}-${index + 1}`,
    source: "reader",
    category: "readers",
    severity: "major",
    anchored: false,
    problem,
    remediation: "",
  }));
  review.findings = [...review.findings.filter((finding) => finding.source !== "reader"), ...findings];
  review.readersSummaryDone = true;
  ctx.insight(overall >= 7 ? "ok" : overall >= 5 ? "info" : "warning", isItalian(ctx.language) ? `Lettori: ${overall}/10` : `Readers: ${overall}/10`, asStringList(output.consensus, 2).join(" · "));
  return { changes: compact([change]), summary: `${overall}/10 — ${findings.length} proposals for the director` };
}

async function runSpecialists(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const review = ctx.state.review!;
  const source = await chapterSource(ctx, chapter);
  const info = chapterFiles(ctx, chapter);
  const text = source.paragraphs.map((paragraph) => paragraph.body).join("\n");
  const [ghostwriter, secrets] = await Promise.all([loadGhostwriter(ctx.store, ctx.snapshot, info), secretRules(ctx.store, ctx.snapshot, chapter.number)]);
  const relevant = mentionedCanon(ctx.snapshot, text, 16);
  const previousChapters = ctx.state.plan!.chapters.filter((entry) => entry.number < chapter.number).map((entry) => `${entry.number}. ${entry.title}${entry.summary ? ` — ${entry.summary}` : ""}`).join("\n");
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.specialist,
    label: `autopilot:specialists:${chapter.number}`,
    system: specialistsSystemPrompt(ctx.language),
    user: `${request([
      `Review chapter ${chapter.number} «${chapter.title}» (review round ${review.round}). Return at most 12 findings, most important first, using the scene numbers of the markers.`,
      review.previousFixes.length ? `These fixes were applied after the previous round: verify them and report only remaining or new real problems.\n${bulletList(review.previousFixes)}` : "",
      authorRules(ctx, false),
    ])}\n\n${data([
      bookHeader(ctx),
      `GHOSTWRITER PROFILE:\n${ghostwriterBlock(ghostwriter)}`,
      previousChapters ? `PREVIOUS CHAPTERS:\n${previousChapters}` : "",
      chapterPlanBlock(chapter),
      `SCENE PLANS:\n${chapter.scenes.map((scene) => `- Scene ${scene.number} «${scene.title}»: ${scene.goal}`).join("\n")}`,
      `CANON:\n${canonManifest(ctx.snapshot, { includeSecrets: false }) || "-"}`,
      relevant.length ? `CANON DETAILS:\n${await canonDetails(ctx.store, relevant, 600)}` : "",
      secrets ? `SECRETS AND REVEAL RULES:\n${secrets}` : "",
      `CHAPTER TEXT:\n${markedChapterText(source.paragraphs)}`,
    ])}`,
    json: FINDINGS_TOOL,
    maxOutputTokens: 5000,
  });
  const scenesByNumber = new Map(source.paragraphs.map((paragraph) => [paragraph.number, normalizeForMatch(paragraph.body)]));
  const whole = normalizeForMatch(text);
  const findings: ReviewFinding[] = asArray(asRecord(response.json).findings).map(asRecord).slice(0, 12).map((finding, index) => {
    const sceneNumber = asInteger(finding.sceneNumber, 0, 0, 999);
    const evidence = asString(finding.evidence);
    const needle = normalizeForMatch(evidence);
    const anchored = needle.length >= 8 && ((scenesByNumber.get(sceneNumber) ?? whole).includes(needle) || whole.includes(needle));
    return {
      id: `S${review.round}-${index + 1}`,
      source: "specialist" as const,
      category: asString(finding.category) || "other",
      severity: asOneOf(finding.severity, ["critical", "major", "minor"] as const, "minor"),
      sceneNumber: sceneNumber || undefined,
      evidence: evidence || undefined,
      anchored,
      problem: asString(finding.problem),
      remediation: asString(finding.remediation),
    };
  }).filter((finding) => finding.problem);
  review.findings = [...review.findings.filter((finding) => finding.source !== "specialist"), ...findings];
  review.specialistsDone = true;
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const major = findings.filter((finding) => finding.severity === "major").length;
  for (const finding of findings.filter((entry) => entry.severity !== "minor").slice(0, 4)) {
    ctx.insight(finding.severity === "critical" ? "critical" : "warning", `${finding.category}${finding.sceneNumber ? ` · ${isItalian(ctx.language) ? "scena" : "scene"} ${finding.sceneNumber}` : ""}: ${truncate(finding.problem, 160)}`, finding.remediation);
  }
  if (!findings.length) ctx.insight("ok", isItalian(ctx.language) ? "Gli specialisti non trovano problemi" : "The specialists found no problems");
  return { changes: [], summary: `${findings.length} findings (${critical} critical, ${major} major) — ${asString(asRecord(response.json).summary)}` };
}

function findingLine(finding: ReviewFinding): string {
  return [
    `[${finding.id}] ${finding.source}${finding.reader ? ` (${finding.reader})` : ""} · ${finding.severity} · ${finding.category}${finding.sceneNumber ? ` · scene ${finding.sceneNumber}` : ""}${finding.source === "specialist" && !finding.anchored ? " · UNANCHORED (evidence not found verbatim)" : ""}`,
    `Problem: ${finding.problem}`,
    finding.evidence ? `Evidence: «${finding.evidence}»` : "",
    finding.remediation ? `Proposed fix: ${finding.remediation}` : "",
  ].filter(Boolean).join("\n");
}

async function runDirectorReview(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const review = ctx.state.review!;
  const source = await chapterSource(ctx, chapter);
  const [resume, secrets, readersSummary] = await Promise.all([
    readBody(ctx.store, TOTAL_RESUME_FILE, 4000),
    secretRules(ctx.store, ctx.snapshot, chapter.number),
    review.readerScores.length ? readBody(ctx.store, readerSummaryPath({ kind: "chapter", chapter: chapter.slug }), 2500) : Promise.resolve(""),
  ]);
  const maxRounds = ctx.director.maxReviewRounds;
  const last = review.round >= maxRounds;
  const perScene = Math.max(3000, Math.floor(60000 / Math.max(1, source.paragraphs.length)));
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.director,
    label: `autopilot:director-review:${chapter.number}`,
    system: directorSystemPrompt(ctx.director, ctx.language),
    user: `${request([
      `Decide on chapter ${chapter.number} «${chapter.title}» (review round ${review.round} of ${maxRounds}).`,
      "For EVERY finding decide exactly once: accept it with a precise, minimal remediation for the ghostwriter and its scene number, or reject it with the reason. Reject unfounded or unanchored findings, findings against the vision or the author's rules, and single-reader taste the intended audience would not share.",
      `Score the chapter from 1 to 10. Verdict "approve" when it deserves at least ${ctx.director.approvalScore}/10 and nothing critical remains; otherwise "revise".`,
      last ? "This is the LAST review round: accepted fixes will be applied and the chapter closed without another review, so accept only what really matters." : "",
      "Add standing guidance for the next chapters when this chapter taught you something.",
      ctx.director.autonomy === "full" ? "Never ask the author: decide." : "Ask the author (questionForAuthor) only for a critical matter you must not settle alone.",
      authorRules(ctx, false),
    ])}\n\n${data([
      bookHeader(ctx),
      directorGuidance(ctx),
      chapterPlanBlock(chapter),
      `SCENE PLANS:\n${chapter.scenes.map((scene) => `- Scene ${scene.number} «${scene.title}»: ${scene.goal}`).join("\n")}`,
      resume ? `STORY SO FAR:\n${resume}` : "",
      secrets ? `SECRETS AND REVEAL RULES:\n${secrets}` : "",
      review.readerScores.length
        ? `SIMULATED READERS:\n${review.readerScores.map((score) => `- ${score.name} (weight ${ctx.director.readerWeights[score.slug] ?? 1}): ${score.score}/10. Main problem: ${score.mainProblem}. Priority: ${score.prioritySuggestion}`).join("\n")}`
        : "",
      readersSummary ? `READERS PANEL SUMMARY:\n${readersSummary}` : "",
      review.previousFixes.length ? `FIXES APPLIED AFTER THE PREVIOUS ROUND:\n${bulletList(review.previousFixes)}` : "",
      `FINDINGS TO DECIDE:\n${review.findings.length ? review.findings.map(findingLine).join("\n\n") : "None."}`,
      `CHAPTER TEXT:\n${markedChapterText(source.paragraphs, perScene)}`,
    ])}`,
    json: CHAPTER_REVIEW_TOOL,
    maxOutputTokens: 6000,
  });
  const output = asRecord(response.json);
  const writtenScenes = new Set(chapter.scenes.filter((scene) => scene.status !== "planned").map((scene) => scene.number));
  const byId = new Map(asArray(output.decisions).map(asRecord).map((decision) => [asString(decision.findingId), decision]));
  const decisions: ReviewDecision[] = review.findings.map((finding) => {
    const decision = byId.get(finding.id);
    const action = decision ? asOneOf(decision.action, ["accept", "reject"] as const, "reject") : "reject";
    const remediation = asString(decision?.remediation) || (action === "accept" ? finding.remediation : "");
    const sceneNumber = asInteger(decision?.sceneNumber, 0, 0, 999) || finding.sceneNumber;
    return {
      findingId: finding.id,
      action: action === "accept" && remediation && sceneNumber && writtenScenes.has(sceneNumber) ? "accept" : "reject",
      rationale: asString(decision?.rationale) || (decision ? "" : "No decision from the director: rejected by default."),
      remediation,
      sceneNumber: sceneNumber || undefined,
    };
  });
  asArray(output.extraFixes).map(asRecord).slice(0, 5).forEach((fix, index) => {
    const sceneNumber = asInteger(fix.sceneNumber, 0, 0, 999);
    const remediation = asString(fix.remediation);
    if (!remediation || !writtenScenes.has(sceneNumber)) return;
    decisions.push({ findingId: `D${review.round}-${index + 1}`, action: "accept", rationale: asString(fix.rationale), remediation, sceneNumber });
  });
  const accepted = decisions.filter((decision) => decision.action === "accept");
  const rejected = decisions.filter((decision) => decision.action === "reject");
  const score = Math.round(asNumber(output.score, 6, 1, 10) * 10) / 10;
  let verdict = asOneOf(output.verdict, ["approve", "revise"] as const, accepted.length ? "revise" : "approve");
  if (verdict === "revise" && !accepted.length) verdict = "approve";
  const summaryText = asString(output.summary);
  review.decisions = decisions;
  review.directorDone = true;
  review.verdict = verdict;
  review.score = score;
  review.summary = summaryText;
  review.repairQueue = [...new Set(accepted.map((decision) => decision.sceneNumber!))].sort((left, right) => left - right);
  review.history = [...review.history, { round: review.round, verdict, score, accepted: accepted.length, rejected: rejected.length }];
  ctx.state.directorNotes = mergeNotes(ctx.state.directorNotes, asStringList(output.guidance, 6));
  const question = asRecord(output.questionForAuthor);
  if (ctx.director.autonomy !== "full" && asString(question.question)) {
    ctx.state.question = {
      id: `question-${ctx.now().getTime()}`,
      kind: "director",
      question: asString(question.question),
      context: summaryText,
      options: asStringList(question.options, 5),
      chapterNumber: chapter.number,
      askedAt: ctx.now().toISOString(),
    };
  }
  const italian = isItalian(ctx.language);
  const findingFor = (decision: ReviewDecision) => review.findings.find((finding) => finding.id === decision.findingId);
  const opinion: DirectorOpinion = {
    target: { kind: "chapter", chapter: chapter.slug },
    targetTitle: `${chapter.number}. ${chapter.title}`,
    verdict,
    score,
    summary: summaryText,
    strengths: asStringList(output.strengths, 8),
    concerns: accepted.map((decision) => {
      const finding = findingFor(decision);
      return {
        severity: finding?.severity ?? "major",
        issue: finding?.problem ?? decision.rationale,
        ...(finding?.evidence ? { evidence: finding.evidence } : {}),
        suggestion: `${decision.sceneNumber ? `${italian ? "Scena" : "Scene"} ${decision.sceneNumber}: ` : ""}${decision.remediation}`,
      };
    }),
    decisions: decisions.map((decision) => `${decision.action === "accept" ? (italian ? "Accettato" : "Accepted") : (italian ? "Respinto" : "Rejected")} ${decision.findingId}: ${decision.rationale || decision.remediation}`),
    nextSteps: asStringList(output.guidance, 6),
    questionsForAuthor: asString(question.question) ? [asString(question.question)] : [],
    createdAt: ctx.now().toISOString(),
    source: "autopilot",
    directorName: ctx.director.name,
    model: response.model,
    provider: response.provider,
    usage: response.usage,
    cost: response.cost,
    currency: response.currency,
    sourceHash: source.sourceHash,
  };
  const opinionPath = directorOpinionPath({ kind: "chapter", chapter: chapter.slug });
  const opinionChange = await changeFor(ctx.store, opinionPath, () => renderDirectorOpinion(opinion, ctx.language));
  ctx.insight(verdict === "approve" ? "ok" : "warning", italian
    ? `Il direttore: ${verdict === "approve" ? "approvato" : "da rivedere"} (${score}/10), ${accepted.length} correzioni accettate, ${rejected.length} respinte`
    : `Director: ${verdict === "approve" ? "approved" : "revise"} (${score}/10), ${accepted.length} fixes accepted, ${rejected.length} rejected`, summaryText);
  for (const decision of accepted.slice(0, 4)) ctx.insight("info", `${italian ? "Correzione" : "Fix"} ${italian ? "scena" : "scene"} ${decision.sceneNumber}: ${truncate(decision.remediation, 160)}`, decision.rationale);
  return { changes: compact([opinionChange]), summary: `${verdict} ${score}/10 — ${accepted.length} accepted, ${rejected.length} rejected. ${summaryText}` };
}

async function rewriteScene(ctx: TaskContext, chapter: PlannedChapter, scene: PlannedScene, instructions: string[], mode: "repair" | "revise"): Promise<{ change: BookFileChange; words: number }> {
  if (!scene.path) throw new Error(`Scene ${chapter.number}.${scene.number} has no file.`);
  const loaded = await readDocument(ctx.store, scene.path);
  if (!loaded) throw new Error(`Scene file not found: ${scene.path}`);
  const info = chapterFiles(ctx, chapter);
  const [ghostwriter, secrets, neighbors] = await Promise.all([
    loadGhostwriter(ctx.store, ctx.snapshot, info),
    secretRules(ctx.store, ctx.snapshot, chapter.number),
    sceneNeighbors(ctx, chapter, scene),
  ]);
  const originalWords = countWords(loaded.document.body);
  const relevant = mentionedCanon(ctx.snapshot, loaded.document.body, 10);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: `autopilot:${mode}:${chapter.number}.${scene.number}`,
    system: writerSystemPrompt(ctx.language),
    user: `${request([
      mode === "repair"
        ? `Revise scene ${scene.number} of chapter ${chapter.number} «${scene.title}» applying ONLY these fixes approved by the director:`
        : `Rewrite scene ${scene.number} of chapter ${chapter.number} «${scene.title}» to honor the author's revision:`,
      instructions.map((instruction, index) => `${index + 1}. ${instruction}`).join("\n"),
      "Keep everything else as it is: events, facts, voice, rhythm, secrets and approximate length, unless an instruction requires otherwise. Return the complete revised scene.",
      authorRules(ctx),
    ])}\n\n${data([
      bookHeader(ctx),
      `GHOSTWRITER PROFILE:\n${ghostwriterBlock(ghostwriter)}`,
      directorGuidance(ctx),
      scenePlanBlock(scene),
      relevant.length ? `RELEVANT CANON:\n${await canonDetails(ctx.store, relevant)}` : "",
      secrets ? `SECRETS AND REVEAL RULES:\n${secrets}` : "",
      neighbors.previousEnding ? `PREVIOUS SCENE ENDING:\n${neighbors.previousEnding}` : "",
      neighbors.nextOpening ? `NEXT SCENE OPENING (keep it consistent):\n${neighbors.nextOpening}` : "",
      `CURRENT SCENE:\n${loaded.document.body}`,
    ])}`,
    maxOutputTokens: Math.min(16000, Math.ceil(Math.max(originalWords, 300) * 2.4) + 800),
    temperature: Math.min(0.7, ghostwriter?.temperature ?? 0.7),
  });
  const prose = cleanProse(response.text);
  assertProse(prose, Math.max(60, Math.floor(originalWords * 0.5)));
  return {
    change: { path: scene.path, content: renderMarkdown(loaded.document.frontmatter, prose), expectedHash: loaded.file.hash },
    words: countWords(prose),
  };
}

async function runRepair(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const scene = sceneOf(chapter, ctx.task.sceneNumber);
  const review = ctx.state.review!;
  const instructions = review.decisions.filter((decision) => decision.action === "accept" && decision.sceneNumber === scene.number).map((decision) => decision.remediation);
  review.repairQueue = review.repairQueue.filter((number) => number !== scene.number);
  if (!instructions.length) return { changes: [], summary: "No fix to apply." };
  const { change, words } = await rewriteScene(ctx, chapter, scene, [...instructions, ...ctx.notes.map((note) => note.text)], "repair");
  scene.revisions += 1;
  scene.words = words;
  ctx.insight("ok", isItalian(ctx.language) ? `Scena ${chapter.number}.${scene.number} corretta (${instructions.length})` : `Scene ${chapter.number}.${scene.number} revised (${instructions.length})`, instructions.join(" · "));
  return { changes: [change], summary: `${instructions.length} fixes applied, ${words} words.` };
}

async function runConsolidate(ctx: TaskContext): Promise<TaskResult> {
  const chapter = chapterOf(ctx);
  const review = ctx.state.review;
  const source = await chapterSource(ctx, chapter);
  const resume = await readBody(ctx.store, TOTAL_RESUME_FILE, 7000);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.writer,
    label: `autopilot:consolidate:${chapter.number}`,
    system: continuitySystemPrompt(ctx.language),
    user: `${request([
      `Close chapter ${chapter.number} «${chapter.title}»: write its summary, its recap (one bullet per scene, in order), the continuity delta, and the updated story so far including this chapter.`,
    ])}\n\n${data([
      bookHeader(ctx),
      chapterPlanBlock(chapter),
      resume ? `STORY SO FAR (before this chapter):\n${resume}` : "STORY SO FAR: this is the first chapter.",
      `CHAPTER TEXT:\n${markedChapterText(source.paragraphs, 9000)}`,
    ])}`,
    json: CONSOLIDATION_TOOL,
    maxOutputTokens: 5000,
    temperature: 0.3,
  });
  const output = asRecord(response.json);
  const summary = asString(output.summary);
  if (!summary) throw new Error("The chapter consolidation has no summary.");
  const recap = asString(output.recap) || summary;
  const storySoFar = asString(output.storySoFar);
  const stateChanges = asRecord(output.stateChanges);
  const changes: Array<BookFileChange | null> = [];
  changes.push(await changeFor(ctx.store, chapterFilePath(chapter.slug), (existing) => existing
    ? renderMarkdown({ ...existing.frontmatter, summary }, existing.body)
    : renderMarkdown({ type: "chapter", id: `chapter:${chapter.slug}`, number: chapter.number, title: chapter.title, summary, canon: "draft" }, `# ${chapter.title}`)));
  changes.push(await changeFor(ctx.store, chapterResumePath(chapter.slug), (existing) => renderMarkdown({
    ...(existing?.frontmatter ?? {}),
    type: "resume",
    id: `resume:chapter:${chapter.slug}`,
    title: `Resume ${chapter.slug}`,
    chapter: `chapter:${chapter.slug}`,
    state_changes: Object.keys(stateChanges).length ? stateChanges : undefined,
  }, `# Chapter Summary\n\n${recap}`)));
  if (storySoFar) {
    changes.push(await changeFor(ctx.store, TOTAL_RESUME_FILE, (existing) => renderMarkdown(
      { ...(existing?.frontmatter ?? {}), type: "resume", id: "resume:total", title: "Total Resume" },
      `# Book So Far\n\n${storySoFar}`,
    )));
  }
  chapter.summary = summary;
  chapter.status = "done";
  chapter.score = review?.score;
  chapter.skipReaders = undefined;
  for (const scene of chapter.scenes) if (scene.status === "written") scene.status = "reviewed";
  ctx.state.review = null;
  changes.push(await renderPlot(ctx));
  changes.push(await planFileChange(ctx));
  ctx.insight("ok", isItalian(ctx.language) ? `Capitolo ${chapter.number} approvato${review?.score ? ` (${review.score}/10)` : ""}` : `Chapter ${chapter.number} approved${review?.score ? ` (${review.score}/10)` : ""}`, summary);
  return { changes: compact(changes), summary };
}

// ─── Author revision and final review ───────────────────────────────────────

async function runImpact(ctx: TaskContext): Promise<TaskResult> {
  const revision = ctx.state.revision!;
  const plan = ctx.state.plan;
  const written = (plan?.chapters ?? []).flatMap((chapter) => chapter.scenes.filter((scene) => scene.status !== "planned" && scene.path).map((scene) => ({ chapter, scene })));
  if (!written.length) {
    revision.targets = [];
    return { changes: [], summary: "Nothing written yet: the instruction becomes a permanent rule." };
  }
  const design = await readBody(ctx.store, STORY_DESIGN_FILE, 3000);
  const response = await ctx.ai({
    capability: AI_CAPABILITIES.director,
    label: "autopilot:impact",
    system: directorSystemPrompt(ctx.director, ctx.language),
    user: `${request([
      `The author asked to revise what is already written: «${revision.instruction}».`,
      "Decide which written scenes must change to honor it, in reading order, with a precise instruction for each. Choose the minimum set; include later scenes only when they depend on the change.",
    ])}\n\n${data([
      bookHeader(ctx),
      design ? `STORY DESIGN:\n${design}` : "",
      `WRITTEN SCENES:\n${written.map(({ chapter, scene }) => `- Chapter ${chapter.number}, scene ${scene.number} «${scene.title}»: ${scene.summary ?? scene.goal}`).join("\n")}`,
    ])}`,
    json: IMPACT_TOOL,
    maxOutputTokens: 3000,
  });
  const output = asRecord(response.json);
  const valid = new Set(written.map(({ chapter, scene }) => `${chapter.number}:${scene.number}`));
  revision.targets = asArray(output.targets).map(asRecord)
    .map((target) => ({ chapterNumber: asInteger(target.chapterNumber, 0, 0, 999), sceneNumber: asInteger(target.sceneNumber, 0, 0, 999), instruction: asString(target.instruction) || revision.instruction }))
    .filter((target, index, list) => valid.has(`${target.chapterNumber}:${target.sceneNumber}`) && list.findIndex((other) => other.chapterNumber === target.chapterNumber && other.sceneNumber === target.sceneNumber) === index)
    .sort((left, right) => left.chapterNumber - right.chapterNumber || left.sceneNumber - right.sceneNumber)
    .slice(0, 40);
  revision.cursor = 0;
  ctx.insight(revision.targets.length ? "warning" : "info", isItalian(ctx.language) ? `${revision.targets.length} scene da riscrivere` : `${revision.targets.length} scenes to rewrite`, asString(output.summary));
  return { changes: [], summary: `${revision.targets.length} scenes — ${asString(output.summary)}` };
}

async function runRevise(ctx: TaskContext): Promise<TaskResult> {
  const revision = ctx.state.revision!;
  const target = revision.targets![revision.cursor];
  const chapter = chapterOf(ctx);
  const scene = sceneOf(chapter, ctx.task.sceneNumber);
  const { change, words } = await rewriteScene(ctx, chapter, scene, [target.instruction, ...ctx.notes.map((note) => note.text)], "revise");
  scene.revisions += 1;
  scene.words = words;
  revision.cursor += 1;
  ctx.insight("ok", isItalian(ctx.language) ? `Scena ${chapter.number}.${scene.number} riscritta` : `Scene ${chapter.number}.${scene.number} rewritten`, target.instruction);
  return { changes: [change], summary: `${words} words — ${target.instruction}` };
}

async function runFinal(ctx: TaskContext): Promise<TaskResult> {
  const result = await askDirector({
    store: ctx.store,
    ai: { complete: (aiRequest) => ctx.ai(aiRequest) },
    target: { kind: "book" },
    snapshot: ctx.snapshot,
    signal: ctx.signal,
    now: ctx.now,
    source: "autopilot",
    instruction: "Every chapter has been approved: judge the arcs, the promises made to the reader, the open threads and the ending, and list what the author should still consider.",
  });
  ctx.state.finalDone = true;
  const change = await changeFor(ctx.store, result.path, () => renderDirectorOpinion(result.opinion, ctx.language));
  ctx.insight(result.opinion.verdict === "approve" ? "ok" : "warning", isItalian(ctx.language) ? `Giudizio finale del direttore: ${result.opinion.score}/10` : `Director's final judgement: ${result.opinion.score}/10`, result.opinion.summary);
  return { changes: compact([change]), summary: `${result.opinion.verdict} ${result.opinion.score}/10 — ${result.opinion.summary}` };
}

export const TASK_EXECUTORS: Record<TaskDescriptor["kind"], (ctx: TaskContext) => Promise<TaskResult>> = {
  concept: runConcept,
  plan: runPlan,
  "plan-reader": runPlanReader,
  "plan-review": runPlanReview,
  scenes: runScenes,
  write: runWrite,
  reader: runReader,
  "readers-summary": runReadersSummary,
  specialists: runSpecialists,
  "director-review": runDirectorReview,
  repair: runRepair,
  consolidate: runConsolidate,
  impact: runImpact,
  revise: runRevise,
  final: runFinal,
};

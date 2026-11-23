import { isExtensionNote, parseMarkdown, parseOutlineChapterPath, readOutlineChapter, type AutopilotActivity, type AutopilotPlan, type AutopilotState, type AutopilotTaskKind } from "narrarium-engine";
import { parseVerdictLine } from "@/autopilot/bandModel";

/**
 * What the approval of the plan shows, worked out from what the page already has (the saved state and the log of the steps) and from the few
 * files of the book it reads for it (the story design, the characters the concept created, the entries of the outline on the screen). Pure.
 */

/**
 * What the plan waits for while nothing runs: the author's approval (`approve`: the director approved it and the run stopped for the author), or
 * to be made again with the changes asked for it (`revise`: the author asked for a change, or a run stopped while it was revising the plan).
 * `null` for anything else: a run that goes on, a plan that is approved, an extension of a book, a run stopped by an error (its panel says it).
 */
export type PlanReviewMode = "approve" | "revise";

export function planReviewMode(state: Pick<AutopilotState, "plan" | "status"> | null | undefined, running: boolean): PlanReviewMode | null {
  const plan = state?.plan;
  if (!plan || running || state.status === "running") return null;
  if (plan.awaitingAuthor) return "approve";
  if (state.status !== "paused" && state.status !== "idle") return null;
  if (plan.approved || pendingPlanChanges(plan).length === 0) return null;
  return "revise";
}

/** The changes the plan will be made again with: the notes of the revision, without the one that only extends the book. */
export function pendingPlanChanges(plan: Pick<AutopilotPlan, "revisionNotes"> | null | undefined): string[] {
  return (plan?.revisionNotes ?? []).filter((note) => !isExtensionNote(note));
}

/**
 * What a change asked for a chapter does, by the engine's rule for an intervention that rewrites (`applyRewrite`): when nothing of the book is
 * written the plan is made again with the author's words; when the book has scenes written (chapters of the author, for one) the written chapters
 * are revised and the plan stays as it is. In both cases the words become a rule of the book.
 */
export type ChangeEffect = "replan" | "revise-written";

export function changeEffect(plan: Pick<AutopilotPlan, "chapters">): ChangeEffect {
  return plan.chapters.some((chapter) => chapter.scenes.some((scene) => scene.status !== "planned")) ? "revise-written" : "replan";
}

export interface PlanReview {
  /** The review's place in the planning, from 1. */
  number: number;
  verdict: "approve" | "revise" | "rewrite";
  score: number;
  text: string;
  /** When the director gave it. */
  at: string;
}

/** The steps of the planning: a log that has anything else between two of them was written in between. */
const PLANNING: ReadonlySet<AutopilotTaskKind> = new Set(["concept", "summarize-imported", "plan", "plan-reader", "plan-review", "freeze"]);

/**
 * The director's reviews of the plan in the planning that led to it, oldest first: the reviews that worked since the last step that was not part of
 * the planning. The engine keeps the vote and the words of a review only in the result of its step ("approve 8/10 — …"), not in the state.
 */
export function planReviews(activities: readonly AutopilotActivity[]): PlanReview[] {
  const found: Array<Omit<PlanReview, "number">> = [];
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!PLANNING.has(activity.task)) break;
    if (activity.task !== "plan-review" || activity.status !== "succeeded") continue;
    const line = parseVerdictLine(activity.summary);
    if (line) found.push({ verdict: line.verdict, score: line.score, text: line.text, at: activity.endedAt ?? activity.startedAt });
  }
  return found.reverse().map((review, index) => ({ number: index + 1, ...review }));
}

const CHARACTER_FILE = /^characters\/[^/]+\.md$/;

/** The files of the characters the concept created, in the order it wrote them: what the last concept that worked wrote under `characters/`. */
export function castPaths(activities: readonly AutopilotActivity[]): string[] {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity.task === "concept" && activity.status === "succeeded") return (activity.changedPaths ?? []).filter((path) => CHARACTER_FILE.test(path));
  }
  return [];
}

/** The roles of a character the engine writes (`story_role`): the page says them in its own words. */
export const STORY_ROLES = ["protagonist", "deuteragonist", "antagonist", "mentor", "ally", "love-interest", "foil", "comic-relief"] as const;
export type StoryRole = (typeof STORY_ROLES)[number];

export interface CastMember {
  path: string;
  slug: string;
  name: string;
  role: StoryRole | null;
  tier: string | null;
  /** What the character is for, in one line. */
  line: string | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The name a file gives itself: `li-wei` is Li Wei. */
function nameOfSlug(slug: string): string {
  return slug.split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/** One character in one line, from its file (`null` while it cannot be read: the name of the file is the name). */
export function castMember(path: string, content: string | null | undefined): CastMember {
  const slug = path.replace(/^characters\//, "").replace(/\.md$/, "");
  if (!content) return { path, slug, name: nameOfSlug(slug), role: null, tier: null, line: null };
  const document = parseMarkdown(content);
  const frontmatter = document.frontmatter;
  const role = text(frontmatter.story_role);
  const body = document.body.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? null;
  return {
    path,
    slug,
    name: text(frontmatter.name) ?? text(frontmatter.title) ?? nameOfSlug(slug),
    role: role && (STORY_ROLES as readonly string[]).includes(role) ? (role as StoryRole) : null,
    tier: text(frontmatter.role_tier),
    line: text(frontmatter.function_in_book) ?? body,
  };
}

/** The longest premise the screen shows: the story design is the place to read all of it. */
const PREMISE_CHARACTERS = 1200;
const PREMISE_TITLE = /^(premise|premessa|premisa|prémisse|premissa|prämisse)\b/i;

/**
 * The premise of the story design the concept wrote: the section called so (in English or in Italian, or a few neighbouring languages), or else its
 * first section, which is where the concept puts it whatever the language. `null` when there is none with words in it.
 */
export function premiseOf(storyDesign: string | null | undefined): string | null {
  if (!storyDesign) return null;
  const body = parseMarkdown(storyDesign).body;
  const sections: Array<{ title: string; lines: string[] }> = [];
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) sections.push({ title: heading[1], lines: [] });
    else if (/^#\s/.test(line)) continue;
    else sections[sections.length - 1]?.lines.push(line);
  }
  const section = sections.find((entry) => PREMISE_TITLE.test(entry.title.trim())) ?? sections[0];
  const premise = section?.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!premise) return null;
  return premise.length > PREMISE_CHARACTERS ? `${premise.slice(0, PREMISE_CHARACTERS).trimEnd()}…` : premise;
}

export type OutlineOrigin = "author" | "autopilot";

/**
 * Who wrote the entry of the outline of each chapter, from the files of the entries, as the engine reads them: `autopilot` for an entry it wrote
 * and nobody touched since, `author` for every other (it binds the plan).
 */
export async function outlineOrigins(files: ReadonlyArray<{ path: string; content: string }>): Promise<Map<number, OutlineOrigin>> {
  const origins = new Map<number, OutlineOrigin>();
  const entries = await Promise.all(files.map(async (file) => {
    const place = parseOutlineChapterPath(file.path);
    if (!place) return null;
    const { entry } = await readOutlineChapter(file.path, place.number, file.content);
    return [place.number, entry.intact ? "autopilot" : "author"] as const;
  }));
  for (const entry of entries) if (entry) origins.set(entry[0], entry[1]);
  return new Map([...origins].sort((left, right) => left[0] - right[0]));
}

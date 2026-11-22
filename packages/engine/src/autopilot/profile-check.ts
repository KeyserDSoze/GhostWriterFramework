import { loadGhostwriter } from "../book/context.js";
import type { BookSnapshot, ChapterInfo } from "../book/snapshot.js";
import type { BookStore } from "../book/store.js";
import type { DirectorProfile } from "../profiles/director.js";
import type { EvaluationStyle } from "../profiles/evaluation-style.js";
import type { ReaderPersonaProfile } from "../profiles/readers.js";
import { isItalian, truncate } from "../util/text.js";
import type { TaskDescriptor } from "./planner.js";
import type { AutopilotState, AutopilotTaskKind } from "./types.js";

/** The steps that write, or review the writing, with the profile of a ghostwriter. */
const GHOSTWRITER_TASKS = new Set<AutopilotTaskKind>(["write", "specialists", "repair", "revise"]);

/** Problems a message lists before it says how many more there are, and the length of each. */
const MAX_PROBLEMS_LISTED = 8;
const MAX_PROBLEM_CHARACTERS = 320;

/**
 * What is wrong with the profiles the next step uses: the director's, the evaluation style of the book (`evaluation-guidelines.md`,
 * which judges the plan, every chapter and the book), the files of the simulated readers when readers are used at all (an override
 * that cannot be read changes who reads and who does not), and the ghostwriter of the chapter for a step that writes. Each one is a
 * problem the author must fix: the autopilot never goes on with a profile that is not what its file says, and never replaces the file
 * with the defaults.
 */
export async function profileProblems(input: { store: BookStore; snapshot: BookSnapshot; state: AutopilotState; director: DirectorProfile; panel: ReaderPersonaProfile[]; task: TaskDescriptor; evaluationStyle?: EvaluationStyle | null }): Promise<string[]> {
  const problems: string[] = [...(input.director.warnings ?? []), ...(input.evaluationStyle?.warnings ?? [])];
  if (input.state.options.readers || input.state.options.readersOnPlan) for (const reader of input.panel) problems.push(...(reader.warnings ?? []));
  if (GHOSTWRITER_TASKS.has(input.task.kind)) {
    const planned = input.state.plan?.chapters.find((chapter) => chapter.number === input.task.chapterNumber);
    const folder: ChapterInfo | undefined = planned ? input.snapshot.chapters.find((entry) => entry.slug === planned.slug) : undefined;
    // A chapter whose folder is not there yet is written by the ghostwriter its plan names, else by the book's.
    const chapter = folder ?? (planned?.ghostwriter ? { slug: planned.slug, number: planned.number, title: planned.title, pov: planned.pov, path: "", paragraphs: [], ghostwriter: planned.ghostwriter } : undefined);
    problems.push(...((await loadGhostwriter(input.store, input.snapshot, chapter))?.warnings ?? []));
  }
  return [...new Set(problems)];
}

/** The title of the insight and the message of the status `waiting-author` that tell the author what to correct. */
export function profileProblemsTitle(problems: string[], language: string): string {
  return isItalian(language)
    ? `Correggi ${problems.length === 1 ? "il profilo" : "i profili"} prima di riprendere: l'autopilot non usa un profilo che non riesce a leggere così com'è scritto`
    : `Correct ${problems.length === 1 ? "this profile" : "these profiles"} before resuming: the autopilot does not use a profile it cannot read as it is written`;
}

export function profileProblemsMessage(problems: string[], language: string): string {
  const listed = problems.slice(0, MAX_PROBLEMS_LISTED).map((problem) => truncate(problem, MAX_PROBLEM_CHARACTERS));
  const more = problems.length - listed.length;
  const rest = more > 0 ? (isItalian(language) ? ` (e altri ${more})` : ` (and ${more} more)`) : "";
  return `${profileProblemsTitle(problems, language)}. ${listed.join(" · ")}${rest}`;
}

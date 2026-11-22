import { EVALUATION_GUIDELINES_FILE } from "../book/paths.js";
import { clipText, truncate } from "../util/text.js";
import { isEmptyValue, isMapping, quoted, readProfileFile } from "./read.js";

/** One criterion of the author's evaluation style: its key, as the site writes it (`canon_coherence`), and what it weighs. */
export interface EvaluationCriterion {
  name: string;
  description: string;
}

/**
 * The evaluation style of a book (`evaluation-guidelines.md`, the site's "Evaluation style"): the criteria the author judges by and,
 * in the body, the critical method, the severity and the structure of a written evaluation. The autopilot judges with it: the
 * director's review of a chapter, the specialists and the final judgement read the criteria and the method, the review of the plan
 * the method and the severity only.
 */
export interface EvaluationStyle {
  title: string;
  criteria: EvaluationCriterion[];
  /** The method, the severity and the structure the author asks of an evaluation, in Markdown. */
  body: string;
  path: string;
  /**
   * What is wrong with the file, each problem naming it (YAML that cannot be read, a criterion that cannot be read). Empty when the
   * file is as it says. The autopilot does not judge with a style that has warnings: like a profile, it stops before spending.
   */
  warnings: string[];
}

/** The most characters the style takes in a prompt: the criteria first, then the method, cut. */
export const EVALUATION_STYLE_MAX_CHARS = 3000;

/** The least the method keeps of the block when there are more criteria than room: the severity must reach the judge. */
const METHOD_RESERVE = 800;
/** The most a single criterion takes in the block. */
const CRITERION_MAX = 400;
const CRITERIA_LABEL = "Criteria:";
const METHOD_LABEL = "Method and severity:";
const BLOCK_END = "END OF THE EVALUATION STYLE";

type Warn = (message: string) => void;

/** A description as the author may have written it: text (or a number, a switch), nothing, or something that cannot be one. */
function descriptionOf(name: string, value: unknown, warn: Warn): string {
  if (isEmptyValue(value)) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  warn(`the description of the criterion ${name} must be text (${quoted(value)} is not): only its name is used`);
  return "";
}

/** A criterion of the mapping the site writes (`clarity: { description }`), or written as text, or left empty. */
function criterionOf(name: string, value: unknown, warn: Warn): EvaluationCriterion {
  if (isMapping(value)) {
    if ("description" in value) return { name, description: descriptionOf(name, value.description, warn) };
    warn(`the criterion ${name} has no description (${quoted(value)}): only its name is used`);
    return { name, description: "" };
  }
  if (Array.isArray(value)) {
    warn(`the criterion ${name} must be a description (${quoted(value)} is not one): only its name is used`);
    return { name, description: "" };
  }
  return { name, description: descriptionOf(name, value, warn) };
}

/** An item of a list of criteria: `name: description` as text, `{ name, description }`, or `{ clarity: description }`. */
function listedCriterion(item: unknown, warn: Warn): EvaluationCriterion | null {
  if (typeof item === "string" || typeof item === "number") {
    const text = String(item).trim();
    const colon = text.indexOf(": ");
    const name = (colon > 0 ? text.slice(0, colon) : text).trim();
    return name ? { name, description: colon > 0 ? text.slice(colon + 2).trim() : "" } : null;
  }
  if (!isMapping(item)) return null;
  const named = ["name", "key", "title"].map((key) => item[key]).find((value) => typeof value === "string" && value.trim());
  if (typeof named === "string") return { name: named.trim(), description: descriptionOf(named.trim(), item.description, warn) };
  const keys = Object.keys(item);
  if (keys.length === 1 && keys[0] !== "description" && keys[0].trim()) return criterionOf(keys[0].trim(), item[keys[0]], warn);
  return null;
}

/**
 * The evaluation style of `evaluation-guidelines.md`. It never throws and never hides a problem: YAML that cannot be read (with
 * its line) and a criterion that cannot be read are warnings that name the file, and no criterion is dropped in silence. The
 * `criteria` are read as the site writes them (a mapping of keys to `{ description }`), as text, or as a list.
 */
export function parseEvaluationStyle(raw: string): EvaluationStyle {
  const { frontmatter, body, warnings, warn } = readProfileFile(EVALUATION_GUIDELINES_FILE, raw);
  const criteria: EvaluationCriterion[] = [];
  const value = frontmatter.criteria;
  if (isMapping(value)) {
    for (const [name, entry] of Object.entries(value)) if (name.trim()) criteria.push(criterionOf(name.trim(), entry, warn));
  } else if (Array.isArray(value)) {
    let skipped = 0;
    for (const item of value) {
      const criterion = listedCriterion(item, warn);
      if (criterion) criteria.push(criterion);
      else if (item !== null && item !== undefined) skipped += 1;
    }
    if (skipped) warn(`${skipped === 1 ? "one entry" : `${skipped} entries`} of criteria cannot be read as a criterion with a name and a description and ${skipped === 1 ? "was" : "were"} left out`);
  } else if (!isEmptyValue(value)) {
    warn(`criteria must give each criterion with its description (${quoted(value)} is not that): no criterion is read`);
  }
  return {
    title: typeof frontmatter.title === "string" ? frontmatter.title.trim() : "",
    criteria,
    body,
    path: EVALUATION_GUIDELINES_FILE,
    warnings,
  };
}

/**
 * The style as a delimited block of a prompt (it is the author's file: it goes among the data, never among the instructions), at most
 * `EVALUATION_STYLE_MAX_CHARS` characters: the criteria first (each at most 400 characters, and a line that says how many are not
 * listed when they do not all fit), then the method, cut with `clipText`; the method keeps a part of its own however many criteria
 * there are. With `criteria: false` only the method and the severity. Empty when there is no style, or nothing in it.
 */
export function evaluationStyleBlock(style: EvaluationStyle | null | undefined, options: { criteria?: boolean; maxChars?: number } = {}): string {
  if (!style) return "";
  const withCriteria = options.criteria !== false;
  const criteria = withCriteria ? style.criteria.filter((criterion) => criterion.name.trim()) : [];
  const body = style.body.trim();
  if (!criteria.length && !body) return "";
  const max = options.maxChars ?? EVALUATION_STYLE_MAX_CHARS;
  const head = withCriteria
    ? "EVALUATION STYLE (the author's evaluation-guidelines.md: the criteria to judge by, then the method and the severity):"
    : "EVALUATION STYLE (the method and the severity of the author's evaluation-guidelines.md; its criteria are for chapters):";
  const render = (lines: string[], method: string) => [head, ...(lines.length ? [CRITERIA_LABEL, ...lines] : []), ...(method ? [METHOD_LABEL, method] : []), BLOCK_END].join("\n");
  const omitted = (count: number) => `(${count} more ${count === 1 ? "criterion is" : "criteria are"} not listed: judge by the ones above.)`;

  const lines: string[] = [];
  if (criteria.length) {
    const reserve = body ? Math.min(body.length, METHOD_RESERVE) : 0;
    let room = max - render([], body ? "x".repeat(reserve) : "").length - (CRITERIA_LABEL.length + 1);
    for (let index = 0; index < criteria.length; index += 1) {
      const { name, description } = criteria[index];
      const line = truncate(`- ${name}${description ? `: ${description}` : ""}`.replace(/\s+/g, " "), CRITERION_MAX);
      const left = criteria.length - index - 1;
      const cost = line.length + 1;
      if (cost + (left ? omitted(left).length + 1 : 0) > room) break;
      lines.push(line);
      room -= cost;
    }
    if (lines.length < criteria.length) lines.push(omitted(criteria.length - lines.length));
  }
  let method = "";
  if (body) {
    const room = max - render(lines, "").length - METHOD_LABEL.length - 2;
    method = body.length <= room ? body : room > 1 ? `${clipText(body, room - 1).trimEnd()}…` : "";
  }
  return render(lines, method);
}

/** What a step that judges is told about the style, among its instructions: it guides the judgement; the scale and the format stay. */
export function evaluationStyleInstruction(kind: "chapter" | "scene" | "specialists" | "plan" | "book"): string {
  switch (kind) {
    case "plan":
      return "Review the plan with the method and the severity of the author's evaluation style (EVALUATION STYLE, in the data): its criteria judge chapters, not plans. The score keeps its scale and your answer keeps the format of the function, whatever the style says about sections.";
    case "specialists":
      return "Look for problems also against the criteria of the author's evaluation style (EVALUATION STYLE, in the data), with its severity. Every finding keeps the format of the function, whatever the style says about sections.";
    case "book":
      return "Judge the book with the author's evaluation style (EVALUATION STYLE, in the data): its criteria, its method and its severity. The score keeps its scale and your answer keeps the format of the function, whatever the style says about sections.";
    case "scene":
      return "Judge the scene with the author's evaluation style (EVALUATION STYLE, in the data): its criteria, its method and its severity. The score keeps its scale and your answer keeps the format of the function, whatever the style says about sections.";
    default:
      return "Judge the chapter with the author's evaluation style (EVALUATION STYLE, in the data): weigh it against its criteria, with its method and its severity. The score keeps its scale (from 1 to 10) and your answer keeps the format of the function, whatever the style says about sections.";
  }
}

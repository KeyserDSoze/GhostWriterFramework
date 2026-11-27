import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { unescapePromptDataDeep } from "narrarium-engine";
import { EVALUATION_GUIDELINES_PATH, defaultEvaluationGuidelinesMarkdown } from "@/narrarium/defaultGuidelines";
import { matchKey } from "@/lib/matchText";
import { toolData, toolRefused, type ScopedToolOutcome } from "@/assistant/scopedTools";
import type { PageChangeRow } from "@/assistant/store";
import { pageEditsRefusal, pageProposal, proposalHead, readPageFiles, shortValue, type CurrentFiles } from "@/assistant/pages/proposal";
import type { PageCapability, PageEnv, PageTool } from "@/assistant/pages/types";
import { PAGE_TOOL, pageChangeRule } from "@/assistant/pages/registry";

/**
 * The Evaluation style page with the Copilot: it sees the criteria an evaluation scores and the method it follows (`evaluation-guidelines.md`, the defaults in
 * the book's language while the book has none), and proposes criteria added, changed and removed and a new method, reviewed criterion by criterion.
 */

const PROMPT = [
  "The author is on the Evaluation style page of the book: the criteria every evaluation of a chapter or a scene scores, each with its description, and the method and severity of an evaluation (evaluation-guidelines.md).",
  "To change it, call propose_evaluation_style_changes once with every change: the author reviews every criterion before and after and applies it.",
].join(" ");

export interface EvaluationDoc {
  frontmatter: Record<string, unknown>;
  criteria: Array<{ key: string; description: string }>;
  body: string;
  /** Its frontmatter is not YAML that can be read: it is never written over. */
  unreadable?: boolean;
}

/** The file as the page reads it: its criteria (`criteria: { key: { description } }`), the method (its body), and every other key, kept as it is. */
export function parseEvaluationDoc(raw: string): EvaluationDoc {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, criteria: [], body: raw.trim() };
  const document = parseDocument(match[1]);
  if (document.errors.length) return { frontmatter: {}, criteria: [], body: match[2].trim(), unreadable: true };
  const frontmatter = (document.toJSON() as Record<string, unknown> | null) ?? {};
  const raws = frontmatter.criteria;
  const criteria = raws && typeof raws === "object" && !Array.isArray(raws)
    ? Object.entries(raws as Record<string, unknown>).map(([key, value]) => ({ key, description: value && typeof value === "object" && typeof (value as Record<string, unknown>).description === "string" ? String((value as Record<string, unknown>).description) : String(value ?? "") }))
    : [];
  return { frontmatter, criteria, body: match[2].trim() };
}

export function renderEvaluationDoc(doc: EvaluationDoc): string {
  const frontmatter = { ...doc.frontmatter, criteria: Object.fromEntries(doc.criteria.map((entry) => [entry.key, { description: entry.description }])) };
  return `---\n${stringify(frontmatter).trim()}\n---\n\n${doc.body.trim()}\n`;
}

/** The key of a new criterion, as the page makes it from its name. */
export function criterionKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9à-ÿ]+/gi, "_").replace(/^_+|_+$/g, "");
}

async function loadStyle(env: PageEnv): Promise<{ doc: EvaluationDoc; exists: boolean; files: CurrentFiles }> {
  const files = await readPageFiles(env, [EVALUATION_GUIDELINES_PATH]);
  const file = files.get(EVALUATION_GUIDELINES_PATH) ?? null;
  return { doc: parseEvaluationDoc(file?.content ?? defaultEvaluationGuidelinesMarkdown(env.structure.language)), exists: Boolean(file), files };
}

function describe(doc: EvaluationDoc, exists: boolean): string {
  return [
    `Evaluation style${exists ? "" : " (the defaults: the book has no evaluation-guidelines.md yet)"}: ${doc.criteria.length} criteria.`,
    ...doc.criteria.map((entry) => `- ${entry.key}: ${entry.description.replace(/\s+/g, " ").slice(0, 300)}`),
    `Method and severity: ${doc.body.replace(/\s+/g, " ").slice(0, 1_500) || "-"}`,
  ].join("\n");
}

const criterion = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(2_000) }).strict();
export const evaluationStyleChangesSchema = z.object({
  summary: z.string().max(2_000).optional(),
  add: z.array(criterion).max(20).optional(),
  update: z.array(criterion).max(30).optional(),
  remove: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  method: z.string().max(20_000).optional(),
}).strict();
type StyleChanges = z.infer<typeof evaluationStyleChangesSchema>;

/** The style after the changes, with one row for every criterion (and the method when it changes). */
export function planEvaluationStyle(doc: EvaluationDoc, changes: StyleChanges): { doc: EvaluationDoc; rows: PageChangeRow[]; problems: string[] } {
  const problems: string[] = [];
  const find = (name: string) => doc.criteria.find((entry) => entry.key === name || matchKey(entry.key) === matchKey(criterionKey(name)) || matchKey(entry.key.replace(/_/g, " ")) === matchKey(name));
  const removed = new Set<string>();
  const edited = new Map<string, string>();
  const added: Array<{ key: string; description: string }> = [];
  for (const change of changes.update ?? []) {
    const found = find(change.name);
    if (!found) problems.push(`No criterion is called «${change.name}».`);
    else if (found.description.trim() !== change.description.trim()) edited.set(found.key, change.description.trim());
  }
  for (const name of changes.remove ?? []) {
    const found = find(name);
    if (!found) problems.push(`No criterion is called «${name}».`);
    else removed.add(found.key);
  }
  for (const change of changes.add ?? []) {
    const key = criterionKey(change.name);
    if (!key) continue;
    if (find(change.name) || added.some((entry) => entry.key === key)) {
      problems.push(`A criterion called «${change.name}» exists already: it was not added again.`);
      continue;
    }
    added.push({ key, description: change.description.trim() });
  }
  const rows: PageChangeRow[] = [];
  const criteria = doc.criteria.flatMap((entry) => {
    if (removed.has(entry.key)) {
      rows.push({ id: entry.key, name: entry.key, change: "removed", from: shortValue(entry.description) });
      return [];
    }
    const next = edited.get(entry.key);
    if (next !== undefined) {
      rows.push({ id: entry.key, name: entry.key, change: "edited", from: shortValue(entry.description), to: shortValue(next) });
      return [{ key: entry.key, description: next }];
    }
    rows.push({ id: entry.key, name: entry.key, change: "unchanged", to: shortValue(entry.description) });
    return [entry];
  });
  for (const entry of added) rows.push({ id: entry.key, name: entry.key, change: "created", to: shortValue(entry.description) });
  const method = changes.method !== undefined && changes.method.trim() !== doc.body.trim() ? changes.method.trim() : null;
  if (method !== null) rows.push({ id: "@method", name: "method", change: "edited", from: shortValue(doc.body), to: shortValue(method) });
  const rank: Record<PageChangeRow["change"], number> = { created: 0, edited: 1, "turned-on": 2, "turned-off": 3, removed: 4, unchanged: 5 };
  rows.sort((left, right) => rank[left.change] - rank[right.change]);
  return { doc: { ...doc, criteria: [...criteria, ...added], body: method ?? doc.body }, rows, problems: [...new Set(problems)] };
}

const readStyle: PageTool = {
  id: "read_evaluation_style",
  description: "the evaluation style of the book whole: every criterion with its description, and the method and severity",
  args: "{}",
  schema: z.object({}).strict() as never,
  async run(_args: Record<string, never>, env: PageEnv): Promise<ScopedToolOutcome> {
    const { doc, exists } = await loadStyle(env);
    return toolData("read_evaluation_style", `${describe(doc, exists)}\nThe whole method:\n${doc.body || "-"}`);
  },
};

const proposeStyle: PageTool = {
  id: "propose_evaluation_style_changes",
  description: "changes to the evaluation style, shown to the author criterion by criterion and applied only if the author confirms: \"add\" new criteria, \"update\" the description of a criterion, \"remove\" criteria by name, \"method\" the whole new method and severity",
  args: '{"summary"?:"one sentence for the author","add"?:[{"name":"…","description":"…"}],"update"?:[{"name":"…","description":"…"}],"remove"?:["…"],"method"?:"…"}',
  schema: evaluationStyleChangesSchema as never,
  async run(args: StyleChanges, env: PageEnv): Promise<ScopedToolOutcome> {
    const off = pageEditsRefusal(env.settings);
    if (off) return toolRefused("propose_evaluation_style_changes", off);
    const { doc, files } = await loadStyle(env);
    if (doc.unreadable) return toolRefused("propose_evaluation_style_changes", `${EVALUATION_GUIDELINES_PATH} has a frontmatter that cannot be read: the author corrects it on the page first.`);
    const plan = planEvaluationStyle(doc, unescapePromptDataDeep(args));
    if (!plan.rows.some((row) => row.change !== "unchanged")) return toolRefused("propose_evaluation_style_changes", plan.problems.length ? `Nothing to propose: ${plan.problems.join(" ")}` : "Nothing would change: the evaluation style is already as asked.");
    const message = pageProposal({ env, toolId: PAGE_TOOL, page: "evaluation-style", updates: [{ path: EVALUATION_GUIDELINES_PATH, content: renderEvaluationDoc(plan.doc), reason: "Evaluation style" }], current: files, rows: plan.rows, text: proposalHead({ en: "Proposed changes to the evaluation style", it: "Modifiche proposte allo stile di valutazione" }, plan.rows, env.italian, plan.problems) });
    return { tool: "propose_evaluation_style_changes", kind: "proposal", message, text: "Proposed to the author: the evaluation style. Nothing is applied until the author confirms." };
  },
};

const CRITERION = { type: "object", properties: { name: { type: "string" }, description: { type: "string" } } };

export const evaluationStylePage: PageCapability = {
  id: "evaluation-style",
  prompt: PROMPT,
  async state(env) {
    const { doc, exists } = await loadStyle(env);
    return describe(doc, exists);
  },
  tools: [readStyle, proposeStyle],
  proposeToolId: "propose_evaluation_style_changes",
  proposeParameters: { type: "object", properties: { summary: { type: "string" }, add: { type: "array", items: CRITERION }, update: { type: "array", items: CRITERION }, remove: { type: "array", items: { type: "string" } }, method: { type: "string" } } },
  fallbackToolId: pageChangeRule("evaluation-style"),
};

import { z } from "zod";
import { DIRECTOR_AUTONOMIES, DIRECTOR_FILE, defaultDirector, parseDirector, unescapePromptDataDeep, type DirectorProfile } from "narrarium-engine";
import { renderDirectorFile } from "@/narrarium/director";
import { toolData, toolRefused, type ScopedToolOutcome } from "@/assistant/scopedTools";
import { fieldRow, pageEditsRefusal, pageProposal, proposalHead, readPageFiles, type CurrentFiles } from "@/assistant/pages/proposal";
import type { PageCapability, PageEnv, PageTool } from "@/assistant/pages/types";
import { PAGE_TOOL, pageChangeRule } from "@/assistant/pages/registry";

/**
 * The Director page with the Copilot: it sees the director of the book (who it is, how it judges, what it cares about, the weight of each reader, its vision) and
 * proposes changes to its fields, reviewed field by field before `director.md` is written. A director the book has not saved yet is the default one.
 */

const PROMPT = [
  "The author is on the Director page of the book: the director is the author's stand-in who approves the plan, decides on every finding of readers and specialists, and scores each chapter (director.md).",
  "Its fields: name, persona, autonomy (full, ask-on-critical, ask-always), strictness (1-10), approvalScore (1-10, the score a chapter needs), maxReviewRounds (1-3), priorities, taste and redLines (lists), readerWeights (reader slug → 0-3) and the vision (Markdown).",
  "To change it, call propose_director_changes once with every field to set: the author reviews every field before and after and applies it.",
].join(" ");

const LABELS: Record<string, string> = { name: "Name", persona: "Persona", autonomy: "Autonomy", strictness: "Strictness", approvalScore: "Approval score", maxReviewRounds: "Review rounds", priorities: "Priorities", taste: "Taste", redLines: "Red lines", readerWeights: "Reader weights", body: "Vision" };
const KEYS = Object.keys(LABELS) as Array<keyof DirectorProfile>;

async function loadDirector(env: PageEnv): Promise<{ profile: DirectorProfile; exists: boolean; content: string | null; files: CurrentFiles }> {
  const files = await readPageFiles(env, [DIRECTOR_FILE]);
  const file = files.get(DIRECTOR_FILE) ?? null;
  return file ? { profile: parseDirector(file.content, env.structure.language), exists: true, content: file.content, files } : { profile: defaultDirector(env.structure.language), exists: false, content: null, files };
}

function describe(profile: DirectorProfile, exists: boolean): string {
  const list = (values: readonly string[]) => (values.length ? values.join("; ") : "-");
  const weights = Object.entries(profile.readerWeights).map(([slug, weight]) => `${slug} ${weight}`).join(", ");
  return [
    `Director: ${profile.name}${exists ? "" : " (the default: the book has no director.md yet)"}; autonomy ${profile.autonomy}; strictness ${profile.strictness}/10; approval score ${profile.approvalScore}/10; review rounds ${profile.maxReviewRounds}.`,
    `Persona: ${profile.persona || "-"}`,
    `Priorities: ${list(profile.priorities)}`,
    `Taste: ${list(profile.taste)}`,
    `Red lines: ${list(profile.redLines)}`,
    `Reader weights: ${weights || "every reader weighs 1"}`,
    `Vision: ${profile.body.trim().replace(/\s+/g, " ").slice(0, 1_500) || "-"}`,
  ].join("\n");
}

const list = z.array(z.string().max(400)).max(30);
export const directorChangesSchema = z.object({
  summary: z.string().max(2_000).optional(),
  set: z.object({
    name: z.string().trim().min(1).max(200).optional(), persona: z.string().max(4_000).optional(), autonomy: z.enum(DIRECTOR_AUTONOMIES as [string, ...string[]]).optional(),
    strictness: z.number().min(1).max(10).optional(), approvalScore: z.number().min(1).max(10).optional(), maxReviewRounds: z.number().int().min(1).max(3).optional(),
    priorities: list.optional(), taste: list.optional(), redLines: list.optional(), readerWeights: z.record(z.string().max(120), z.number().min(0).max(3)).optional(), body: z.string().max(30_000).optional(),
  }).strict(),
}).strict();
type DirectorChanges = z.infer<typeof directorChangesSchema>;

const readDirector: PageTool = {
  id: "read_director",
  description: "the director of the book whole: every field, and its vision",
  args: "{}",
  schema: z.object({}).strict() as never,
  async run(_args: Record<string, never>, env: PageEnv): Promise<ScopedToolOutcome> {
    const { profile, exists } = await loadDirector(env);
    return toolData("read_director", `${describe(profile, exists)}\nThe whole vision:\n${profile.body.trim() || "-"}`);
  },
};

const proposeDirectorChanges: PageTool = {
  id: "propose_director_changes",
  description: "changes to the fields of the director, shown to the author field by field (before and after) and applied only if the author confirms: \"set\" holds the fields to change, the others stay",
  args: '{"summary"?:"one sentence for the author","set":{"name"?:"…","persona"?:"…","autonomy"?:"full|ask-on-critical|ask-always","strictness"?:N,"approvalScore"?:N,"maxReviewRounds"?:N,"priorities"?:["…"],"taste"?:["…"],"redLines"?:["…"],"readerWeights"?:{"reader-slug":N},"body"?:"the vision"}}',
  schema: directorChangesSchema as never,
  async run(args: DirectorChanges, env: PageEnv): Promise<ScopedToolOutcome> {
    const off = pageEditsRefusal(env.settings);
    if (off) return toolRefused("propose_director_changes", off);
    const { profile, content, files } = await loadDirector(env);
    if (profile.warnings?.length) return toolRefused("propose_director_changes", `director.md has problems the page shows (${profile.warnings.join("; ")}): the author corrects them on the page first.`);
    const set = unescapePromptDataDeep(args.set) as Partial<DirectorProfile>;
    const next: DirectorProfile = { ...profile, ...set, readerWeights: set.readerWeights ? { ...profile.readerWeights, ...set.readerWeights } : profile.readerWeights };
    const file = renderDirectorFile(next, content);
    // What is written is what the engine reads back: a value it would not take is not proposed.
    const written = parseDirector(file, env.structure.language);
    const rows = KEYS.map((key) => fieldRow(String(key), LABELS[key as string], profile[key], written[key]));
    if (!rows.some((row) => row.change === "edited")) return toolRefused("propose_director_changes", "Nothing would change: the director is already as asked.");
    const message = pageProposal({ env, toolId: PAGE_TOOL, page: "director", updates: [{ path: DIRECTOR_FILE, content: file, reason: written.name }], current: files, rows, text: proposalHead({ en: "Proposed changes to the director", it: "Modifiche proposte al direttore" }, rows, env.italian) });
    return { tool: "propose_director_changes", kind: "proposal", message, text: `Proposed to the author: ${rows.filter((row) => row.change === "edited").map((row) => row.id).join(", ")}. Nothing is applied until the author confirms.` };
  },
};

const STRING_LIST = { type: "array", items: { type: "string" } };

export const directorPage: PageCapability = {
  id: "director",
  prompt: PROMPT,
  async state(env) {
    const { profile, exists } = await loadDirector(env);
    return describe(profile, exists);
  },
  tools: [readDirector, proposeDirectorChanges],
  proposeToolId: "propose_director_changes",
  proposeParameters: { type: "object", properties: { summary: { type: "string" }, set: { type: "object", properties: { name: { type: "string" }, persona: { type: "string" }, autonomy: { type: "string", enum: DIRECTOR_AUTONOMIES }, strictness: { type: "number" }, approvalScore: { type: "number" }, maxReviewRounds: { type: "integer" }, priorities: STRING_LIST, taste: STRING_LIST, redLines: STRING_LIST, readerWeights: { type: "object" }, body: { type: "string" } } } }, required: ["set"] },
  fallbackToolId: pageChangeRule("director"),
};

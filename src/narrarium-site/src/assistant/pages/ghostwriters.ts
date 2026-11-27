import { stringify, parseDocument } from "yaml";
import { z } from "zod";
import { unescapePromptDataDeep } from "narrarium-engine";
import { canDeleteGhostwriter, emptyGhostwriter, ghostwriterReferencePaths, parseGhostwriter, serializeGhostwriter, type GhostwriterProfile } from "@/narrarium/ghostwriter";
import { slugifyAny } from "@/narrarium/canon";
import { matchKey } from "@/lib/matchText";
import { toolData, toolRefused, type ScopedToolOutcome } from "@/assistant/scopedTools";
import type { AssistantFileUpdate, PageChangeRow } from "@/assistant/store";
import { pageViewText } from "@/assistant/pages/view";
import { pageEditsRefusal, pageProposal, proposalHead, readPageFiles } from "@/assistant/pages/proposal";
import type { PageCapability, PageEnv, PageTool } from "@/assistant/pages/types";
import { PAGE_TOOL, pageChangeRule } from "@/assistant/pages/registry";

/**
 * The Ghostwriters page with the Copilot: it sees every ghostwriter of the book (the book's default first) with its voice in a line, reads one whole, and proposes
 * a batch: ghostwriters created, edited, removed. The book's default ghostwriter, and its last one, are never removed.
 */

const FIELDS = ["name", "language", "tone", "voice", "povDefault", "tenseDefault", "sentenceRhythm", "dialogueStyle", "vocabulary", "writingStyle", "punctuationStyle", "influences", "strengths", "avoid", "temperature", "body"] as const;
type Field = (typeof FIELDS)[number];
/** The keys of the file the profile writes: the author's other keys stay. */
const MANAGED = ["type", "id", "name", "language", "tone", "voice", "pov_default", "tense_default", "sentence_rhythm", "dialogue_style", "vocabulary", "writing_style", "punctuation_style", "influences", "strengths", "avoid", "temperature"];

const PROMPT = [
  "The author is on the Ghostwriters page of the book: the profiles of the voices that write its prose (tone, voice, point of view, tense, rhythm, dialogue, vocabulary, style, influences, strengths, what to avoid, temperature, and notes).",
  "The book has a default ghostwriter; a chapter or a scene may name another.",
  "To change them, call propose_ghostwriter_changes once with every change of the request: the author reviews every ghostwriter with its resulting state and applies it. The default ghostwriter, and the last one, are never removed.",
].join(" ");

interface LoadedGhostwriter {
  profile: GhostwriterProfile;
  path: string;
}

async function loadGhostwriters(env: PageEnv): Promise<LoadedGhostwriter[]> {
  const files = await readPageFiles(env, env.structure.ghostwriters.map((entry) => entry.path));
  return env.structure.ghostwriters.map((entry) => ({ path: entry.path, profile: parseGhostwriter(entry.slug, files.get(entry.path)?.content ?? `---\nname: ${entry.name}\n---\n`) }));
}

function line(entry: LoadedGhostwriter, defaultSlug: string | undefined): string {
  const { profile } = entry;
  const voice = [profile.tone, profile.voice, profile.povDefault && `POV ${profile.povDefault}`, profile.tenseDefault && `tense ${profile.tenseDefault}`].filter(Boolean).join("; ");
  return `- ${profile.name} · ${profile.slug}${profile.slug === defaultSlug ? " · the book's default" : ""}${voice ? ` · ${voice}` : ""}`;
}

function details(entry: LoadedGhostwriter, defaultSlug: string | undefined): string {
  const { profile } = entry;
  const list = (values: readonly string[]) => (values.length ? values.join(", ") : "-");
  return [
    line(entry, defaultSlug),
    `  language: ${profile.language || "-"}; tone: ${profile.tone || "-"}; voice: ${profile.voice || "-"}; povDefault: ${profile.povDefault || "-"}; tenseDefault: ${profile.tenseDefault || "-"}`,
    `  sentenceRhythm: ${profile.sentenceRhythm || "-"}; dialogueStyle: ${profile.dialogueStyle || "-"}; vocabulary: ${profile.vocabulary || "-"}; punctuationStyle: ${profile.punctuationStyle || "-"}`,
    `  writingStyle: ${profile.writingStyle || "-"}`,
    `  influences: ${list(profile.influences)}; strengths: ${list(profile.strengths)}; avoid: ${list(profile.avoid)}; temperature: ${profile.temperature}`,
    `  notes: ${profile.body.trim().replace(/\s+/g, " ").slice(0, 600) || "-"}`,
  ].join("\n");
}

/** The file of a ghostwriter: what the profile says, over the keys of the file that only the file has. */
export function ghostwriterFileContent(profile: GhostwriterProfile, existing: string | null): string {
  const generated = serializeGhostwriter(profile);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(generated)!;
  const managed = (parseDocument(match[1]).toJSON() as Record<string, unknown>) ?? {};
  const current = existing ? /^---\r?\n([\s\S]*?)\r?\n---/.exec(existing) : null;
  let kept: Record<string, unknown> = {};
  try {
    kept = current ? (parseDocument(current[1]).toJSON() as Record<string, unknown>) ?? {} : {};
  } catch {
    kept = {};
  }
  const frontmatter = { ...Object.fromEntries(Object.entries(kept).filter(([key]) => !MANAGED.includes(key))), ...managed };
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${match[2].trim()}\n`;
}

const text = z.string().max(4_000);
const list = z.array(z.string().max(300)).max(30);
const fields = z.object({
  name: z.string().trim().min(1).max(200).optional(), language: text.optional(), tone: text.optional(), voice: text.optional(), povDefault: text.optional(), tenseDefault: text.optional(),
  sentenceRhythm: text.optional(), dialogueStyle: text.optional(), vocabulary: text.optional(), writingStyle: text.optional(), punctuationStyle: text.optional(),
  influences: list.optional(), strengths: list.optional(), avoid: list.optional(), temperature: z.number().min(0).max(2).optional(), body: z.string().max(20_000).optional(),
}).strict();
type Fields = z.infer<typeof fields>;
const selector = z.string().trim().min(1).max(200);

export const ghostwriterChangesSchema = z.object({
  summary: z.string().max(2_000).optional(),
  create: z.array(fields.extend({ name: z.string().trim().min(1).max(200) })).max(10).optional(),
  update: z.array(z.object({ ghostwriter: selector, set: fields }).strict()).max(30).optional(),
  remove: z.array(selector).max(30).optional(),
}).strict();
type GhostwriterChanges = z.infer<typeof ghostwriterChangesSchema>;

const ARGS = '{"summary"?:"one sentence for the author","create"?:[{"name":"…","tone"?:"…","voice"?:"…","povDefault"?:"…","tenseDefault"?:"…","writingStyle"?:"…","influences"?:["…"],"avoid"?:["…"],"temperature"?:0.7,"body"?:"notes"}],"update"?:[{"ghostwriter":"name or slug","set":{…the same fields}}],"remove"?:["name or slug"]}';

function find(selectorText: string, entries: readonly LoadedGhostwriter[]): LoadedGhostwriter | undefined {
  const key = matchKey(selectorText);
  return entries.find((entry) => entry.profile.slug === selectorText || matchKey(entry.profile.name) === key) ?? (entries.filter((entry) => matchKey(entry.profile.name).includes(key)).length === 1 ? entries.find((entry) => matchKey(entry.profile.name).includes(key)) : undefined);
}

function apply(profile: GhostwriterProfile, set: Fields): Field[] {
  const changed: Field[] = [];
  for (const key of FIELDS) {
    const value = set[key];
    if (value === undefined) continue;
    const next = Array.isArray(value) ? [...new Set(value.map((item) => item.trim()).filter(Boolean))] : typeof value === "string" ? value.trim() : value;
    if (JSON.stringify((profile as unknown as Record<string, unknown>)[key]) === JSON.stringify(next)) continue;
    (profile as unknown as Record<string, unknown>)[key] = next;
    changed.push(key);
  }
  return changed;
}

/**
 * The ghostwriters the book, a chapter, a scene, a draft or a script names (`ghostwriter:` in its frontmatter), as the page checks them before it removes one;
 * `null` when a file cannot be read: then none is removed.
 */
export async function ghostwritersInUse(env: Pick<PageEnv, "token" | "book" | "branch" | "structure">): Promise<Set<string> | null> {
  const files = await readPageFiles(env, ghostwriterReferencePaths(env.structure.searchableFiles ?? []));
  const used = new Set<string>();
  for (const file of files.values()) {
    if (!file) continue;
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(file.content);
    if (!match) return null;
    const document = parseDocument(match[1]);
    if (document.errors.length) return null;
    const named = (document.toJSON() as Record<string, unknown> | null)?.ghostwriter;
    if (typeof named === "string") used.add(named);
  }
  return used;
}

/**
 * The batch for the ghostwriters: every ghostwriter with its resulting state, and the files that make it. A profile the engine cannot read whole is not edited
 * (the page shows what is wrong with it); the book's default, its last ghostwriter and one still in use (`inUse`, `null`: unknown) are not removed.
 */
export function planGhostwriterChanges(entries: readonly LoadedGhostwriter[], changes: GhostwriterChanges, defaultSlug: string | undefined, inUse: ReadonlySet<string> | null = new Set()): { rows: PageChangeRow[]; write: LoadedGhostwriter[]; remove: LoadedGhostwriter[]; problems: string[] } {
  const problems: string[] = [];
  const next = entries.map((entry) => ({ path: entry.path, profile: { ...entry.profile } }));
  const changedFields = new Map<string, Field[]>();
  const removed = new Set<string>();
  const slugs = new Set(entries.map((entry) => entry.profile.slug));
  const created: LoadedGhostwriter[] = [];
  for (const draft of changes.create ?? []) {
    if ([...next, ...created].some((entry) => matchKey(entry.profile.name) === matchKey(draft.name))) {
      problems.push(`A ghostwriter named «${draft.name}» already exists: it was not created again.`);
      continue;
    }
    const base = slugifyAny(draft.name, "ghostwriter", true);
    let slug = base;
    for (let index = 2; slugs.has(slug); index += 1) slug = `${base}-${index}`;
    slugs.add(slug);
    const profile: GhostwriterProfile = { ...emptyGhostwriter(draft.name), slug };
    apply(profile, draft);
    created.push({ path: `ghostwriters/${slug}.md`, profile });
  }
  for (const change of changes.update ?? []) {
    const target = find(change.ghostwriter, [...next, ...created]);
    if (!target) {
      problems.push(`No ghostwriter is called «${change.ghostwriter}».`);
      continue;
    }
    if (target.profile.warnings?.length) {
      problems.push(`«${target.profile.name}» has problems its page shows (${target.profile.warnings.join("; ")}): the author corrects them there first.`);
      continue;
    }
    if (change.set.name && [...next, ...created].some((entry) => entry !== target && matchKey(entry.profile.name) === matchKey(change.set.name!))) {
      problems.push(`«${target.profile.name}» cannot be renamed «${change.set.name}»: another ghostwriter has that name.`);
      continue;
    }
    const fieldsChanged = apply(target.profile, change.set);
    if (!created.includes(target) && fieldsChanged.length) changedFields.set(target.profile.slug, [...new Set([...(changedFields.get(target.profile.slug) ?? []), ...fieldsChanged])]);
  }
  for (const selectorText of changes.remove ?? []) {
    const target = find(selectorText, next);
    if (!target) {
      problems.push(`No ghostwriter is called «${selectorText}».`);
      continue;
    }
    if (!canDeleteGhostwriter(target.profile.slug, defaultSlug, next.length - removed.size + created.length)) {
      problems.push(target.profile.slug === defaultSlug ? `«${target.profile.name}» is the book's default ghostwriter: it is never removed.` : `«${target.profile.name}» is the book's last ghostwriter: it is never removed.`);
      continue;
    }
    if (!inUse || inUse.has(target.profile.slug)) {
      problems.push(inUse ? `«${target.profile.name}» still writes the book, a chapter, a scene, a draft or a script: it is not removed.` : `It could not be checked which ghostwriters the chapters use: «${target.profile.name}» is not removed.`);
      continue;
    }
    removed.add(target.profile.slug);
  }
  const rows: PageChangeRow[] = [];
  const write: LoadedGhostwriter[] = [];
  const remove: LoadedGhostwriter[] = [];
  next.forEach((entry, index) => {
    const before = entries[index].profile;
    const kind = before.slug === defaultSlug ? "default" : undefined;
    if (removed.has(before.slug)) {
      rows.push({ id: before.slug, name: before.name, ...(kind ? { kind } : {}), change: "removed" });
      remove.push(entries[index]);
      return;
    }
    const fieldsChanged = changedFields.get(before.slug) ?? [];
    rows.push({ id: before.slug, name: entry.profile.name, ...(kind ? { kind } : {}), change: fieldsChanged.length ? "edited" : "unchanged", ...(fieldsChanged.length ? { fields: fieldsChanged } : {}) });
    if (fieldsChanged.length) write.push(entry);
  });
  for (const entry of created) {
    rows.push({ id: entry.profile.slug, name: entry.profile.name, change: "created" });
    write.push(entry);
  }
  const rank: Record<PageChangeRow["change"], number> = { created: 0, edited: 1, "turned-on": 2, "turned-off": 3, removed: 4, unchanged: 5 };
  rows.sort((left, right) => rank[left.change] - rank[right.change]);
  return { rows, write, remove, problems: [...new Set(problems)] };
}

const readGhostwriters: PageTool = {
  id: "read_ghostwriters",
  description: "every ghostwriter of the book whole (its voice, style, influences, what to avoid, temperature and notes), or one by name or slug",
  args: '{"ghostwriter"?:"name or slug"}',
  schema: z.object({ ghostwriter: selector.optional() }).strict() as never,
  async run(args: { ghostwriter?: string }, env: PageEnv): Promise<ScopedToolOutcome> {
    const entries = await loadGhostwriters(env);
    const chosen = args.ghostwriter ? find(args.ghostwriter, entries) : undefined;
    if (args.ghostwriter && !chosen) return toolData("read_ghostwriters", `No ghostwriter is called «${args.ghostwriter}». The ghostwriters are: ${entries.map((entry) => entry.profile.name).join(", ")}.`);
    return toolData("read_ghostwriters", (chosen ? [chosen] : entries).map((entry) => details(entry, env.structure.ghostwriter)).join("\n"));
  },
};

const proposeGhostwriterChanges: PageTool = {
  id: "propose_ghostwriter_changes",
  description: "one batch of changes to the ghostwriters, shown to the author as the list of every ghostwriter with its resulting state and applied only if the author confirms: \"create\" makes new ghostwriters with their fields, \"update\" sets fields of one, \"remove\" deletes one (never the book's default, nor the last). The fields are name, language, tone, voice, povDefault, tenseDefault, sentenceRhythm, dialogueStyle, vocabulary, writingStyle, punctuationStyle, influences, strengths, avoid (lists), temperature (0-2) and body (notes)",
  args: ARGS,
  schema: ghostwriterChangesSchema as never,
  async run(args: GhostwriterChanges, env: PageEnv): Promise<ScopedToolOutcome> {
    const off = pageEditsRefusal(env.settings);
    if (off) return toolRefused("propose_ghostwriter_changes", off);
    const entries = await loadGhostwriters(env);
    const inUse = args.remove?.length ? await ghostwritersInUse(env) : new Set<string>();
    const plan = planGhostwriterChanges(entries, unescapePromptDataDeep(args), env.structure.ghostwriter, inUse);
    if (!plan.write.length && !plan.remove.length) return toolRefused("propose_ghostwriter_changes", plan.problems.length ? `Nothing to propose: ${plan.problems.join(" ")}` : "Nothing would change: every ghostwriter is already as asked.");
    const current = await readPageFiles(env, [...plan.write, ...plan.remove].map((entry) => entry.path));
    const updates: AssistantFileUpdate[] = [
      ...plan.write.map((entry) => ({ path: entry.path, content: ghostwriterFileContent(entry.profile, current.get(entry.path)?.content ?? null), reason: entry.profile.name })),
      ...plan.remove.map((entry) => ({ path: entry.path, content: null, reason: entry.profile.name })),
    ];
    const message = pageProposal({ env, toolId: PAGE_TOOL, page: "ghostwriters", updates, current, rows: plan.rows, text: proposalHead({ en: "Proposed changes to the ghostwriters", it: "Modifiche proposte ai ghostwriter" }, plan.rows, env.italian, plan.problems) });
    return { tool: "propose_ghostwriter_changes", kind: "proposal", message, text: `Proposed to the author: ${plan.rows.filter((row) => row.change !== "unchanged").length} ghostwriter(s) changed. Nothing is applied until the author confirms.` };
  },
};

const STRING_LIST = { type: "array", items: { type: "string" } };
const FIELD_PARAMETERS = { type: "object", properties: Object.fromEntries(FIELDS.map((key) => [key, key === "temperature" ? { type: "number" } : ["influences", "strengths", "avoid"].includes(key) ? STRING_LIST : { type: "string" }])) };

export const ghostwritersPage: PageCapability = {
  id: "ghostwriters",
  prompt: PROMPT,
  async state(env) {
    const entries = await loadGhostwriters(env);
    const selected = typeof env.view?.selected === "string" ? entries.find((entry) => entry.profile.slug === env.view!.selected) : undefined;
    const looking = pageViewText(selected && env.view ? { ...env.view, selected: `${selected.profile.name} (${selected.profile.slug})` } : env.view);
    return [
      `Ghostwriters: ${entries.length}; the book's default is ${entries.find((entry) => entry.profile.slug === env.structure.ghostwriter)?.profile.name ?? env.structure.ghostwriter ?? "none"}.`,
      looking ? `On the page now: ${looking}.` : "",
      "Every ghostwriter (name · slug · voice):",
      ...entries.map((entry) => line(entry, env.structure.ghostwriter)),
    ].filter(Boolean).join("\n");
  },
  tools: [readGhostwriters, proposeGhostwriterChanges],
  proposeToolId: "propose_ghostwriter_changes",
  proposeParameters: { type: "object", properties: { summary: { type: "string" }, create: { type: "array", items: FIELD_PARAMETERS }, update: { type: "array", items: { type: "object", properties: { ghostwriter: { type: "string" }, set: FIELD_PARAMETERS } } }, remove: STRING_LIST } },
  fallbackToolId: pageChangeRule("ghostwriters"),
};

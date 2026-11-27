import { parseDocument } from "yaml";
import { z } from "zod";
import { unescapePromptDataDeep } from "narrarium-engine";
import { matchKey } from "@/lib/matchText";
import { PROTECTED_CANON_FIELDS, canonExtraFields, type CanonEntityKind } from "@/narrarium/canonFrontmatter";
import { toolData, toolRefused, type ScopedToolOutcome } from "@/assistant/scopedTools";
import type { PageChangeRow } from "@/assistant/store";
import { fieldRow, pageEditsRefusal, pageProposal, proposalHead, readPageFiles } from "@/assistant/pages/proposal";
import type { PageCapability, PageEnv, PageTool } from "@/assistant/pages/types";
import { CANON_PAGE_SECTIONS, PAGE_TOOL, pageChangeRule } from "@/assistant/pages/registry";

/**
 * The page of an entry of the canon (a character, a location, a faction, an item) with the Copilot: it sees the entry (its facts and its description) and the
 * names of the other entries of its kind, reads another entry, and proposes changes to the entry's facts and description, reviewed field by field. Secrets are
 * not part of it: their pages have no contract, and the fields that point to them or keep the author's private notes (`secret_refs`, `private_notes`,
 * `reveal_in`, `known_from`) are never shown here, nor written.
 */

type Section = (typeof CANON_PAGE_SECTIONS)[number];
const SINGULAR: Record<Section, CanonEntityKind> = { characters: "character", locations: "location", factions: "faction", items: "item" };
/** What points to the secrets of the book, or holds the author's private notes: never shown to the Copilot here, never written by it. */
export const SECRET_CANON_KEYS: ReadonlySet<string> = new Set(["secret_refs", "private_notes", "reveal_in", "known_from"]);
/** What the file is: not a fact of the entry. */
const FILE_KEYS = new Set(["type", "id"]);

/** The fields of an entry the Copilot may set: those of its kind, never what makes the entry what it is (its name, its id, its state), nor the secret ones. */
export function writableCanonFields(kind: CanonEntityKind): Set<string> {
  return new Set(canonExtraFields(kind).filter((key) => !SECRET_CANON_KEYS.has(key) && !(PROTECTED_CANON_FIELDS as readonly string[]).includes(key)));
}

const PROMPT = [
  "The author is on the page of an entry of the canon of the book (a character, a location, a faction or an item): its facts (the fields of its file) and its description (the body).",
  "«This character», «this place» and «here» mean this entry. To change it, call propose_canon_entry_changes with the facts to set (null removes one) and, if asked, the whole new description: the author reviews every field before and after and applies it.",
].join(" ");

interface Entry {
  section: Section;
  path: string;
  name: string;
}

function entries(env: PageEnv): Entry[] {
  return CANON_PAGE_SECTIONS.flatMap((section) => env.structure[section].map((file) => ({ section, path: file.path, name: file.name ?? file.path.split("/").pop()!.replace(/\.md$/i, "") })));
}

/** The entry the page shows: its route's. */
function openEntry(env: PageEnv): Entry | null {
  const route = env.context.route;
  if (route.kind !== "canon" || !(CANON_PAGE_SECTIONS as readonly string[]).includes(route.section)) return null;
  return entries(env).find((entry) => entry.path === `${route.section}/${route.slug}.md`) ?? null;
}

function findEntry(env: PageEnv, name: string | undefined): Entry | null {
  if (!name) return openEntry(env);
  const key = matchKey(name);
  const all = entries(env);
  return all.find((entry) => entry.path === name || matchKey(entry.name) === key) ?? (all.filter((entry) => matchKey(entry.name).includes(key)).length === 1 ? all.find((entry) => matchKey(entry.name).includes(key))! : null);
}

interface EntryFile {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Its frontmatter is not YAML that can be read: it is never written over. */
  unreadable?: boolean;
}

export function parseEntryFile(raw: string): EntryFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw.trim(), unreadable: true };
  const document = parseDocument(match[1]);
  if (document.errors.length) return { frontmatter: {}, body: match[2].trim(), unreadable: true };
  return { frontmatter: (document.toJSON() as Record<string, unknown> | null) ?? {}, body: match[2].trim() };
}

/** The facts of an entry as the Copilot may see them: every field but what the file is and the secret ones. */
export function visibleFacts(frontmatter: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !FILE_KEYS.has(key) && !SECRET_CANON_KEYS.has(key)));
}

function describeEntry(entry: Entry, file: EntryFile, bodyChars: number): string {
  const facts = Object.entries(visibleFacts(file.frontmatter)).map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(", ") : value && typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  return [
    `${SINGULAR[entry.section]} «${entry.name}» (${entry.path})`,
    ...facts,
    `Description: ${file.body.replace(/\s+/g, " ").slice(0, bodyChars) || "-"}`,
    `Fields that can be set on a ${SINGULAR[entry.section]}: ${[...writableCanonFields(SINGULAR[entry.section])].join(", ")}.`,
  ].join("\n");
}

const value = z.union([z.string().max(4_000), z.number(), z.boolean(), z.array(z.string().max(400)).max(40), z.null()]);
export const canonChangesSchema = z.object({
  summary: z.string().max(2_000).optional(),
  entry: z.string().trim().min(1).max(200).optional(),
  set: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,60}$/), value).optional(),
  body: z.string().max(40_000).optional(),
}).strict();
type CanonChanges = z.infer<typeof canonChangesSchema>;

/** A text for a field that holds a number or a yes/no stays a number or a yes/no when it says one («35» for an age of 34). */
function sameKind(current: unknown, next: string): string | number | boolean {
  if (typeof current === "number" && /^-?\d+(?:\.\d+)?$/.test(next)) return Number(next);
  if (typeof current === "boolean" && /^(?:true|false)$/i.test(next)) return next.toLowerCase() === "true";
  return next;
}

/** The entry after the changes: the facts it sets (only the fields of its kind the Copilot may set), the description, and one row for every visible field. */
export function planCanonChanges(kind: CanonEntityKind, file: EntryFile, changes: CanonChanges): { file: EntryFile; rows: PageChangeRow[]; problems: string[] } {
  const problems: string[] = [];
  const frontmatter = { ...file.frontmatter };
  const writable = writableCanonFields(kind);
  for (const [key, next] of Object.entries(changes.set ?? {})) {
    if (!writable.has(key)) {
      problems.push(FILE_KEYS.has(key) || SECRET_CANON_KEYS.has(key) || (PROTECTED_CANON_FIELDS as readonly string[]).includes(key) ? `«${key}» is not changed by the Copilot.` : `«${key}» is not a field of a ${kind}.`);
      continue;
    }
    if (next === null) delete frontmatter[key];
    else frontmatter[key] = Array.isArray(next) ? [...new Set(next.map((item) => item.trim()).filter(Boolean))] : typeof next === "string" ? sameKind(file.frontmatter[key], next.trim()) : next;
  }
  const body = changes.body !== undefined ? changes.body.trim() : file.body;
  const keys = [...new Set([...Object.keys(visibleFacts(file.frontmatter)), ...Object.keys(visibleFacts(frontmatter))])];
  const rows = [...keys.map((key) => fieldRow(key, key, file.frontmatter[key], frontmatter[key])), fieldRow("@body", "description", file.body, body)].map((row) => (row.change === "edited" && row.to === "—" && row.id !== "@body" ? { ...row, change: "removed" as const } : row));
  const rank: Record<PageChangeRow["change"], number> = { created: 0, edited: 1, "turned-on": 2, "turned-off": 3, removed: 4, unchanged: 5 };
  // A field the entry did not have is new.
  const sorted = rows.map((row) => (row.change === "edited" && row.from === "—" ? { ...row, change: "created" as const } : row)).sort((left, right) => rank[left.change] - rank[right.change]);
  return { file: { frontmatter, body }, rows: sorted, problems };
}

/** The file after the changes: the fields that change are set or deleted in its frontmatter, which keeps everything else as the author wrote it. */
export function renderEntryFile(raw: string, file: EntryFile): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const doc = parseDocument(match ? match[1] : "");
  const before = parseEntryFile(raw).frontmatter;
  for (const key of new Set([...Object.keys(before), ...Object.keys(file.frontmatter)])) {
    if (!(key in file.frontmatter)) doc.delete(key);
    else if (JSON.stringify(before[key]) !== JSON.stringify(file.frontmatter[key])) doc.set(key, file.frontmatter[key]);
  }
  return `---\n${String(doc).trimEnd()}\n---\n\n${file.body.trim()}\n`;
}

const readEntry: PageTool = {
  id: "read_canon_entry",
  description: "an entry of the canon whole (a character, a location, a faction or an item): this page's, or another by its name (never a secret)",
  args: '{"name"?:"…"}',
  schema: z.object({ name: z.string().trim().min(1).max(200).optional() }).strict() as never,
  async run(args: { name?: string }, env: PageEnv): Promise<ScopedToolOutcome> {
    const entry = findEntry(env, args.name);
    if (!entry) return toolData("read_canon_entry", `No character, location, faction or item is called «${args.name ?? "(this page)"}». The canon has: ${entries(env).map((item) => item.name).slice(0, 60).join(", ")}.`);
    const files = await readPageFiles(env, [entry.path]);
    const content = files.get(entry.path)?.content;
    return toolData("read_canon_entry", content ? describeEntry(entry, parseEntryFile(content), 12_000) : `${entry.path} cannot be read here.`);
  },
};

const proposeEntry: PageTool = {
  id: "propose_canon_entry_changes",
  description: "changes to an entry of the canon (this page's, or another named in \"entry\"), shown to the author field by field and applied only if the author confirms: \"set\" holds the facts to set (the fields of its kind that the page lists as settable, a text, a number, a yes/no or a list; null removes one), \"body\" the whole new description",
  args: '{"summary"?:"one sentence for the author","entry"?:"name of another entry","set"?:{"story_role":"…","aliases":["…"],"age":"34"},"body"?:"the whole new description"}',
  schema: canonChangesSchema as never,
  async run(args: CanonChanges, env: PageEnv): Promise<ScopedToolOutcome> {
    const off = pageEditsRefusal(env.settings);
    if (off) return toolRefused("propose_canon_entry_changes", off);
    const entry = findEntry(env, args.entry);
    if (!entry) return toolRefused("propose_canon_entry_changes", `There is no entry «${args.entry ?? "(this page)"}» to change: name a character, a location, a faction or an item of the canon.`);
    const current = await readPageFiles(env, [entry.path]);
    const content = current.get(entry.path)?.content;
    if (!content) return toolRefused("propose_canon_entry_changes", `${entry.path} cannot be read here.`);
    const file = parseEntryFile(content);
    if (file.unreadable) return toolRefused("propose_canon_entry_changes", `${entry.path} has a frontmatter that cannot be read: the author corrects it on its page first.`);
    const plan = planCanonChanges(SINGULAR[entry.section], file, unescapePromptDataDeep(args));
    if (!plan.rows.some((row) => row.change !== "unchanged")) return toolRefused("propose_canon_entry_changes", plan.problems.length ? `Nothing to propose: ${plan.problems.join(" ")}` : "Nothing would change: the entry is already as asked.");
    const message = pageProposal({ env, toolId: PAGE_TOOL, page: "canon", updates: [{ path: entry.path, content: renderEntryFile(content, plan.file), reason: entry.name }], current, rows: plan.rows, text: proposalHead({ en: `Proposed changes to «${entry.name}»`, it: `Modifiche proposte a «${entry.name}»` }, plan.rows, env.italian, plan.problems) });
    return { tool: "propose_canon_entry_changes", kind: "proposal", message, text: `Proposed to the author: changes to ${entry.path}. Nothing is applied until the author confirms.` };
  },
};

export const canonPage: PageCapability = {
  id: "canon",
  prompt: PROMPT,
  async state(env) {
    const entry = openEntry(env);
    if (!entry) return "";
    const files = await readPageFiles(env, [entry.path]);
    const content = files.get(entry.path)?.content;
    const others = env.structure[entry.section].map((file) => file.name ?? file.path).filter((name) => name !== entry.name);
    return [content ? describeEntry(entry, parseEntryFile(content), 3_000) : `${entry.path} cannot be read here.`, others.length ? `The other ${entry.section}: ${others.slice(0, 60).join(", ")}${others.length > 60 ? ", …" : ""}.` : ""].filter(Boolean).join("\n");
  },
  tools: [readEntry, proposeEntry],
  proposeToolId: "propose_canon_entry_changes",
  proposeParameters: { type: "object", properties: { summary: { type: "string" }, entry: { type: "string" }, set: { type: "object" }, body: { type: "string" } } },
  fallbackToolId: pageChangeRule("canon"),
};

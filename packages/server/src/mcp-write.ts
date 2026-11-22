import { CANON_DIRECTORIES, canonPath, canonSlug, chapterFilePath, chapterId, chapterSlug, keepChapterFreeze, paragraphFilePath, paragraphId, paragraphSlug, parseChapterFilePath, renderMarkdown, sha256Hex, type BookFileContent, type BookSnapshot, type CanonKind, type ChapterInfo, type MarkdownDocument } from "narrarium-engine";
import { judgePath } from "./mcp-policy.js";
import { choice, free, integer, list, shape, string, type JsonSchema } from "./mcp-schema.js";
import { asString, changesNothing, checkSeen, composeDocument, conflictError, expectedHashOf, findCanon, findChapter, findScene, json, openForEdit, pick, plain, replacePassage, shorten, ToolError, type McpTool, type ToolContext, type ToolResult } from "./mcp-kit.js";

const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
/** An update replaces what is there (so it is destructive, in the word's own sense) and, said again, changes nothing more. */
const UPDATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

/** The most characters of one text of a call (a scene, a file): a request is at most a mebibyte, and a book's file is at most eight. */
export const MAX_TEXT_CHARACTERS = 400_000;
const CANON_KINDS = Object.keys(CANON_DIRECTORIES) as CanonKind[];

const text = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => string(description, { maxLength: MAX_TEXT_CHARACTERS, ...extra });
const expectedHash = (what: string): JsonSchema => string(`The hash that ${what} gave for this file. It is required when you replace a whole text, and with any change it makes sure the file has not changed since you read it.`, { maxLength: 128 });
const characterList = (description: string): JsonSchema => list(description, string("A name or a slug.", { minLength: 1, maxLength: 120 }), 20);

const pathTaken = (snapshot: BookSnapshot, path: string): boolean => [...snapshot.files.keys()].some((known) => known.toLowerCase() === path.toLowerCase());

/** A ghostwriter that is in the book (`ghostwriters/<slug>.md`). */
function ghostwriterOf(snapshot: BookSnapshot, value: unknown): string | undefined {
  const slug = asString(value)?.trim();
  if (slug === undefined) return undefined;
  if (!snapshot.ghostwriterSlugs.includes(slug)) throw new ToolError("invalid_input", `There is no ghostwriter "${shorten(slug)}". The book's ghostwriters are: ${snapshot.ghostwriterSlugs.join(", ") || "none"}.`);
  return slug;
}

const trimmed = (value: unknown): string | undefined => asString(value)?.trim();

/** A title or a name that is given: never empty (an empty one would take the key out of the file). */
function named(value: unknown, what: string): string {
  const text = trimmed(value) ?? "";
  if (!text) throw new ToolError("invalid_input", `The ${what} is empty.`);
  return text;
}

// ─── Chapters and scenes ─────────────────────────────────────────────────────

const createChapter: McpTool = {
  name: "create_chapter",
  title: "Create a chapter",
  description: "Adds a chapter to the book: a folder `chapters/NNN-title/` with its chapter.md (frontmatter: number, title, summary, point of view, ghostwriter), as one commit. The number defaults to the next one; a number that is taken is refused. The prose goes in scenes: add them with create_paragraph.",
  scope: "write",
  annotations: CREATE,
  inputSchema: shape({
    title: string("The chapter's title.", { minLength: 1, maxLength: 200 }),
    number: integer("The chapter's number (default: the next one). A number is used by one chapter only.", 1, 9999),
    summary: string("A short summary of the chapter.", { maxLength: 4000 }),
    pov: characterList("The point-of-view characters of the chapter."),
    ghostwriter: string("The slug of the ghostwriter who writes it (one of the book's ghostwriters; default: the book's own).", { minLength: 1, maxLength: 120 }),
    body: text("The text of chapter.md (default: a heading with the title)."),
  }, ["title"]),
  async run(context, args) {
    const snapshot = await context.snapshot();
    const title = named(args.title, "title");
    const number = typeof args.number === "number" ? args.number : Math.max(0, ...snapshot.chapters.map((chapter) => chapter.number)) + 1;
    const clash = snapshot.chapters.find((chapter) => chapter.number === number);
    if (clash) throw new ToolError("already_exists", `Chapter ${number} already exists (${clash.slug}): use update_chapter to change it, or choose another number.`);
    const slug = chapterSlug(number, title);
    const path = chapterFilePath(slug);
    if (pathTaken(snapshot, path)) throw new ToolError("already_exists", `${path} already exists: use update_chapter to change it, or choose another title or number.`);
    const frontmatter = { type: "chapter", id: chapterId(slug), number, title, summary: trimmed(args.summary), pov: args.pov, ghostwriter: ghostwriterOf(snapshot, args.ghostwriter), canon: "draft" };
    const content = renderMarkdown(frontmatter, asString(args.body) ?? `# ${title}`);
    context.touch(path);
    const commit = await context.commit([{ path, content, expectedHash: null }], `create chapter ${slug}`);
    return json({ created: true, path, slug, number, hash: await sha256Hex(content), commit });
  },
};

const updateChapter: McpTool = {
  name: "update_chapter",
  title: "Update a chapter",
  description: "Changes a chapter's title, summary, point of view, ghostwriter or the text of its chapter.md, as one commit. The frontmatter keys you do not name stay as they are; the folder keeps its name. To replace the text (body) pass expectedHash, the hash that read_chapter gave: a chapter that changed since is never overwritten.",
  scope: "write",
  annotations: UPDATE,
  inputSchema: shape({
    chapter: string("The chapter: its slug (`001-arrival`), its number (`1`) or its id.", { minLength: 1, maxLength: 200 }),
    title: string("The new title.", { minLength: 1, maxLength: 200 }),
    summary: string("The new summary.", { maxLength: 4000 }),
    pov: characterList("The point-of-view characters (replaces the list)."),
    ghostwriter: string("The slug of the ghostwriter (one of the book's).", { minLength: 1, maxLength: 120 }),
    body: text("The new text of chapter.md. It replaces the whole text: pass expectedHash."),
    expectedHash: expectedHash("read_chapter"),
  }, ["chapter"]),
  async run(context, args) {
    const snapshot = await context.snapshot();
    const chapter = findChapter(snapshot, args.chapter as string);
    const patch = { ...pick(args, ["summary", "pov"]), ...(args.title !== undefined ? { title: named(args.title, "title") } : {}), ...(args.ghostwriter !== undefined ? { ghostwriter: ghostwriterOf(snapshot, args.ghostwriter) } : {}) };
    const body = asString(args.body);
    if (body === undefined && !Object.keys(patch).length) throw new ToolError("invalid_input", "There is nothing to change: pass a title, summary, pov, ghostwriter or body.");
    const expected = expectedHashOf(args.expectedHash);
    const { file, document } = await openForEdit(context, chapter.path, snapshot.book.language);
    checkSeen(chapter.path, file, expected, body === undefined ? undefined : { readWith: "read_chapter" });
    return rewrite(context, { path: chapter.path, file, document, patch, body: body ?? document.body, what: `update chapter ${chapter.slug}` });
  },
};

const createParagraph: McpTool = {
  name: "create_paragraph",
  title: "Create a scene",
  description: "Adds a scene (a paragraph file) to a chapter: `chapters/<chapter>/NNN-title.md` with its frontmatter (number, title, summary, point of view) and the prose you give, as one commit. The number defaults to the next one in the chapter. The chapter must exist: create_chapter makes it.",
  scope: "write",
  annotations: CREATE,
  inputSchema: shape({
    chapter: string("The chapter: its slug (`001-arrival`), its number (`1`) or its id.", { minLength: 1, maxLength: 200 }),
    title: string("The scene's title.", { minLength: 1, maxLength: 200 }),
    body: text("The prose of the scene.", { minLength: 1 }),
    number: integer("The scene's number in the chapter (default: the next one).", 1, 999),
    summary: string("A short summary of the scene.", { maxLength: 4000 }),
    viewpoint: string("The point-of-view character of the scene.", { minLength: 1, maxLength: 120 }),
    ghostwriter: string("The slug of the ghostwriter (one of the book's; default: the chapter's or the book's).", { minLength: 1, maxLength: 120 }),
  }, ["chapter", "title", "body"]),
  async run(context, args) {
    const snapshot = await context.snapshot();
    let chapter: ChapterInfo;
    try {
      chapter = findChapter(snapshot, args.chapter as string);
    } catch (error) {
      if (error instanceof ToolError && error.code === "not_found") throw new ToolError("not_found", `${error.message} A scene goes in a chapter that exists: create it first with create_chapter.`);
      throw error;
    }
    const title = named(args.title, "title");
    const number = typeof args.number === "number" ? args.number : Math.max(0, ...chapter.paragraphs.map((scene) => scene.number)) + 1;
    const clash = chapter.paragraphs.find((scene) => scene.number === number);
    if (clash) throw new ToolError("already_exists", `Scene ${number} of chapter ${chapter.slug} already exists (${clash.slug}): use update_paragraph to change it, or choose another number.`);
    const slug = paragraphSlug(number, title);
    const path = paragraphFilePath(chapter.slug, slug);
    if (pathTaken(snapshot, path)) throw new ToolError("already_exists", `${path} already exists: use update_paragraph to change it, or choose another title or number.`);
    const frontmatter = { type: "paragraph", id: paragraphId(chapter.slug, slug), chapter: `chapter:${chapter.slug}`, number, title, summary: trimmed(args.summary), viewpoint: trimmed(args.viewpoint), ghostwriter: ghostwriterOf(snapshot, args.ghostwriter), canon: "draft" };
    const content = renderMarkdown(frontmatter, args.body as string);
    context.touch(path);
    const commit = await context.commit([{ path, content, expectedHash: null }], `create scene ${chapter.slug}/${slug}`);
    return json({ created: true, path, slug, number, hash: await sha256Hex(content), commit });
  },
};

const updateParagraph: McpTool = {
  name: "update_paragraph",
  title: "Update a scene",
  description: "Changes a scene, as one commit: replace one passage of its text with `replace` (the passage must be in the scene exactly once), or replace the whole text with `body` (pass expectedHash: the hash that read_paragraph gave, so that a scene that changed since is never overwritten), and/or change its title, summary, viewpoint or ghostwriter. What you do not name stays as it is, the frontmatter keys too.",
  scope: "write",
  annotations: UPDATE,
  inputSchema: shape({
    chapter: string("The chapter: its slug (`001-arrival`), its number (`1`) or its id.", { minLength: 1, maxLength: 200 }),
    paragraph: string("The scene: its slug (`001-the-quay`) or its number in the chapter.", { minLength: 1, maxLength: 200 }),
    body: text("The new text of the whole scene. It replaces everything: pass expectedHash. To change a passage only, use replace."),
    replace: shape({
      find: text("The passage to replace, exactly as it stands in the scene (with its punctuation). It must be there once: if it is not, or is there more than once, nothing changes.", { minLength: 1 }),
      with: text("What to put in its place (empty to take the passage out)."),
    }, ["find", "with"], "Replace one passage of the scene's text with another."),
    title: string("The new title.", { minLength: 1, maxLength: 200 }),
    summary: string("The new summary.", { maxLength: 4000 }),
    viewpoint: string("The new point-of-view character.", { minLength: 1, maxLength: 120 }),
    ghostwriter: string("The slug of the ghostwriter (one of the book's).", { minLength: 1, maxLength: 120 }),
    expectedHash: expectedHash("read_paragraph"),
  }, ["chapter", "paragraph"]),
  async run(context, args) {
    const snapshot = await context.snapshot();
    const chapter = findChapter(snapshot, args.chapter as string);
    const scene = findScene(chapter, args.paragraph as string);
    const patch = { ...pick(args, ["summary", "viewpoint"]), ...(args.title !== undefined ? { title: named(args.title, "title") } : {}), ...(args.ghostwriter !== undefined ? { ghostwriter: ghostwriterOf(snapshot, args.ghostwriter) } : {}) };
    const body = asString(args.body);
    const replace = args.replace as { find: string; with: string } | undefined;
    if (body !== undefined && replace) throw new ToolError("invalid_input", "Send body or replace, not both: body is the whole new text, replace changes one passage.");
    if (body === undefined && !replace && !Object.keys(patch).length) throw new ToolError("invalid_input", "There is nothing to change: pass body, replace, title, summary, viewpoint or ghostwriter.");
    const expected = expectedHashOf(args.expectedHash);
    const { file, document } = await openForEdit(context, scene.path, snapshot.book.language);
    checkSeen(scene.path, file, expected, body === undefined ? undefined : { readWith: "read_paragraph" });
    const next = replace ? replacePassage(document.body, replace.find, replace.with) : body ?? document.body;
    return rewrite(context, { path: scene.path, file, document, patch, body: next, what: `update scene ${chapter.slug}/${scene.slug}` });
  },
};

/** Commit a changed file (frontmatter patched, body replaced), unless it would change nothing. */
async function rewrite(context: ToolContext, change: { path: string; file: BookFileContent; document: MarkdownDocument; patch: Record<string, unknown>; body: string; what: string }): Promise<ToolResult> {
  const { path, file, document, patch, body, what } = change;
  if (changesNothing(document, patch, body)) return json({ updated: false, path, hash: file.hash, message: "Nothing to change: the file already says this." });
  const content = composeDocument(document, patch, body);
  if (content === file.content) return json({ updated: false, path, hash: file.hash, message: "Nothing to change: the file already says this." });
  const commit = await context.commit([{ path, content, expectedHash: file.hash }], what);
  return json({ updated: true, path, hash: await sha256Hex(content), previousHash: file.hash, commit });
}

// ─── Canon ───────────────────────────────────────────────────────────────────

type FieldType = { kind: "text" } | { kind: "list" } | { kind: "integer" } | { kind: "boolean" } | { kind: "choice"; values: readonly string[] } | { kind: "ages" };
const TEXT: FieldType = { kind: "text" };
const LIST: FieldType = { kind: "list" };
const INTEGER: FieldType = { kind: "integer" };
const BOOLEAN: FieldType = { kind: "boolean" };
const oneOf = (...values: string[]): FieldType => ({ kind: "choice", values });

/** The fields of the frontmatter that every kind of entry has (the hidden-canon ones among them). */
const COMMON_FIELDS: Record<string, FieldType> = {
  aliases: LIST, tags: LIST, refs: LIST, sources: LIST, status: TEXT, historical: BOOLEAN, canon: oneOf("draft", "canon", "deprecated"),
  pronunciation: TEXT, spoken_name: TEXT, tts_label: TEXT,
  known_from: TEXT, reveal_in: TEXT, private_notes: TEXT, secret_refs: LIST,
};

/**
 * The fields of each kind of entry, as the core's schemas (`characterSchema`…) name them. The core makes these files through functions that write
 * to a folder on disk and cannot be used here (its entry point carries the whole of its dependencies), and its schemas are not exported on their
 * own: this table is the part of them these tools need, kept next to the code that uses it.
 */
const KIND_FIELDS: Record<CanonKind, Record<string, FieldType>> = {
  character: {
    role_tier: oneOf("main", "supporting", "secondary", "minor", "background"),
    story_role: oneOf("protagonist", "deuteragonist", "antagonist", "mentor", "ally", "love-interest", "foil", "comic-relief", "other"),
    former_names: LIST, current_identity: TEXT, identity_shifts: LIST, identity_arc: TEXT, speaking_style: TEXT, background_summary: TEXT, function_in_book: TEXT,
    age: INTEGER, occupation: TEXT, origin: TEXT, first_impression: TEXT, arc: TEXT, internal_conflict: TEXT, external_conflict: TEXT,
    traits: LIST, mannerisms: LIST, desires: LIST, fears: LIST, relationships: LIST, factions: LIST, home_location: TEXT, introduced_in: TEXT, timeline_ages: { kind: "ages" },
  },
  location: { location_kind: TEXT, region: TEXT, atmosphere: TEXT, function_in_book: TEXT, landmarks: LIST, risks: LIST, factions_present: LIST, based_on_real_place: BOOLEAN, timeline_ref: TEXT },
  faction: { faction_kind: TEXT, mission: TEXT, ideology: TEXT, function_in_book: TEXT, public_image: TEXT, hidden_agenda: TEXT, leaders: LIST, allies: LIST, enemies: LIST, methods: LIST, base_location: TEXT },
  item: { item_kind: TEXT, appearance: TEXT, purpose: TEXT, function_in_book: TEXT, significance: TEXT, origin_story: TEXT, powers: LIST, limitations: LIST, owner: TEXT, introduced_in: TEXT },
  secret: { secret_kind: TEXT, function_in_book: TEXT, stakes: TEXT, protected_by: LIST, false_beliefs: LIST, reveal_strategy: TEXT, holders: LIST, timeline_ref: TEXT },
  "timeline-event": { date: TEXT, participants: LIST, significance: TEXT, function_in_book: TEXT, consequences: LIST },
};

/** Secrets and events have a `title`; the other kinds a `name`. */
const titleKey = (kind: CanonKind): "title" | "name" => (kind === "secret" || kind === "timeline-event" ? "title" : "name");

const describeField = (type: FieldType): string => (type.kind === "choice" ? type.values.join("|") : type.kind === "list" ? "list of text" : type.kind === "ages" ? "name → age" : type.kind === "integer" ? "whole number" : type.kind === "boolean" ? "true/false" : "text");

const FIELDS_HELP = (Object.keys(KIND_FIELDS) as CanonKind[]).map((kind) => `${kind}: ${Object.entries(KIND_FIELDS[kind]).map(([key, type]) => (type.kind === "text" ? key : `${key} (${describeField(type)})`)).join(", ")}`).join("; ");
const COMMON_HELP = Object.entries(COMMON_FIELDS).map(([key, type]) => (type.kind === "text" ? key : `${key} (${describeField(type)})`)).join(", ");
const FIELDS_DESCRIPTION = `Other keys of the entry's frontmatter, as they are stored (snake_case); a key set to null is taken out. Text is a string, lists are arrays of strings. Fields of each kind — ${FIELDS_HELP}. Every kind also has: ${COMMON_HELP}. Anything else is refused.`;

function validValue(type: FieldType, value: unknown): boolean {
  switch (type.kind) {
    case "text": return typeof value === "string" && value.length <= 4000;
    case "list": return Array.isArray(value) && value.length <= 60 && value.every((entry) => typeof entry === "string" && entry.length <= 400);
    case "integer": return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000;
    case "boolean": return typeof value === "boolean";
    case "choice": return typeof value === "string" && type.values.includes(value);
    case "ages": return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((age) => typeof age === "number" && Number.isInteger(age) && age >= 0);
  }
}

/** The fields of a call, checked against the kind: a key that does not exist, or a value of the wrong kind, is refused with what is allowed. */
function checkFields(kind: CanonKind, fields: unknown): Record<string, unknown> {
  if (fields === undefined) return {};
  const allowed = { ...COMMON_FIELDS, ...KIND_FIELDS[kind] };
  const refuse = (problem: string): never => {
    throw new ToolError("invalid_fields", `${problem} The fields of a ${kind} are: ${Object.entries(allowed).map(([key, type]) => (type.kind === "text" ? key : `${key} (${describeField(type)})`)).join(", ")}.`);
  };
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return refuse("`fields` must be an object.");
  const checked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const type = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
    if (!type) return refuse(`\`${shorten(key, 40)}\` is not a field you can set on a ${kind} (the tool sets type, id and ${titleKey(kind)} itself).`);
    if (value !== null && !validValue(type, value)) return refuse(`The value of \`${key}\` must be ${describeField(type)}.`);
    checked[key] = value;
  }
  return checked;
}

const createCanonEntry: McpTool = {
  name: "create_canon_entry",
  title: "Create a canon entry",
  description: "Adds an entry to the book's canon (a character, location, faction, item, secret or timeline event) as one commit: a file in its folder, named from the entry's name, with the frontmatter of its kind (type, id, name or title, summary and the fields you give) and a text. An entry that already exists (by file, name or alias) is refused: use update_canon_entry.",
  scope: "write",
  annotations: CREATE,
  inputSchema: shape({
    kind: choice("The kind of entry.", CANON_KINDS),
    name: string("The entry's name (for a secret or an event: its title). Its file is named from it.", { minLength: 1, maxLength: 200 }),
    summary: string("One or two lines about it, shown in lists. For a secret, keep the truth out of the summary: put it in the body.", { maxLength: 2000 }),
    body: text("The text of the file (default: a heading with the name, then the summary)."),
    fields: free(FIELDS_DESCRIPTION),
  }, ["kind", "name"]),
  async run(context, args) {
    const kind = args.kind as CanonKind;
    const snapshot = await context.snapshot();
    const name = named(args.name, "name");
    const fields = checkFields(kind, args.fields);
    const slug = canonSlug(kind, name);
    const path = canonPath(kind, slug);
    const same = snapshot.canon.find((entry) => entry.kind === kind && (entry.path.toLowerCase() === path.toLowerCase() || [entry.name, ...entry.aliases].some((known) => plain(known) === plain(name))));
    if (same) throw new ToolError("already_exists", `${same.path} already exists (${same.name}): use update_canon_entry to change it, or give this one another name.`);
    if (pathTaken(snapshot, path)) throw new ToolError("already_exists", `${path} already exists: use update_canon_entry to change it, or give this one another name.`);
    const summary = trimmed(args.summary);
    const frontmatter = { type: kind, id: `${kind}:${slug}`, [titleKey(kind)]: name, summary, canon: "draft", ...fields };
    const content = renderMarkdown(frontmatter, asString(args.body) ?? `# ${name}${summary ? `\n\n${summary}` : ""}`);
    context.touch(path);
    const commit = await context.commit([{ path, content, expectedHash: null }], `create ${kind} ${slug}`);
    return json({ created: true, path, slug, hash: await sha256Hex(content), commit });
  },
};

const updateCanonEntry: McpTool = {
  name: "update_canon_entry",
  title: "Update a canon entry",
  description: "Changes a canon entry as one commit: its name (or title), summary, any field of its kind (null takes a field out) and/or its text. What you do not name stays as it is. To replace the text (body) pass expectedHash, the hash that read_canon_entry gave: an entry that changed since is never overwritten. The file keeps its name.",
  scope: "write",
  annotations: UPDATE,
  inputSchema: shape({
    kind: choice("The kind of entry.", CANON_KINDS),
    entry: string("The entry's slug (`mira`), name or alias. list_canon gives them.", { minLength: 1, maxLength: 200 }),
    name: string("The new name (for a secret or an event: the new title).", { minLength: 1, maxLength: 200 }),
    summary: string("The new summary.", { maxLength: 2000 }),
    body: text("The new text of the file. It replaces the whole text: pass expectedHash."),
    fields: free("Fields of the frontmatter to change, as in create_canon_entry (snake_case keys of the entry's kind); a key set to null is taken out. A key that does not exist is refused with the list of the ones that do."),
    expectedHash: expectedHash("read_canon_entry"),
  }, ["kind", "entry"]),
  async run(context, args) {
    const kind = args.kind as CanonKind;
    const snapshot = await context.snapshot();
    const entry = findCanon(snapshot, kind, args.entry as string);
    const fields = checkFields(kind, args.fields);
    const patch = { ...(args.name !== undefined ? { [titleKey(kind)]: named(args.name, "name") } : {}), ...pick(args, ["summary"]), ...fields };
    const body = asString(args.body);
    if (body === undefined && !Object.keys(patch).length) throw new ToolError("invalid_input", "There is nothing to change: pass a name, summary, fields or body.");
    const expected = expectedHashOf(args.expectedHash);
    const { file, document } = await openForEdit(context, entry.path, snapshot.book.language);
    checkSeen(entry.path, file, expected, body === undefined ? undefined : { readWith: "read_canon_entry" });
    return rewrite(context, { path: entry.path, file, document, patch, body: body ?? document.body, what: `update ${kind} ${entry.slug}` });
  },
};

// ─── Any file ────────────────────────────────────────────────────────────────

const writeFileTool: McpTool = {
  name: "write_file",
  title: "Write a file",
  description: "Writes a text file of the book that no other tool is for (notes, plot, outline, guidelines, resumes…), as one commit. A file that exists is replaced only with expectedHash, the hash that read_file gave: a file that changed since is never overwritten. A new file needs no hash. Not for hidden files and folders, for the autopilot's own files or for anything outside the book's folders; chapters, scenes and canon have their own tools. A chapter.md written here keeps the chapter's freeze (`frozen`) as it is: only the app and the autopilot freeze a chapter.",
  scope: "write",
  annotations: UPDATE,
  inputSchema: shape({
    path: string("The file's path in the book, with `/` (for example `notes.md` or `outline/act-two.md`).", { minLength: 1, maxLength: 300 }),
    content: text("The whole new text of the file."),
    expectedHash: expectedHash("read_file"),
  }, ["path", "content"]),
  async run(context, args) {
    // The audit says which file was asked for, also when the answer is no.
    context.touch(args.path as string);
    const verdict = judgePath(args.path as string);
    if (!verdict.ok) throw new ToolError(verdict.code, verdict.message);
    if (!verdict.writable) throw new ToolError("forbidden", `${verdict.path} cannot be written here: the autopilot's files change only through the autopilot tools, and the exports of conversations are a record.`);
    const expected = expectedHashOf(args.expectedHash);
    const current = await context.runtime.store.read(verdict.path);
    // A model never freezes a chapter or takes its freeze away: the record stays the one chapter.md holds, and a change of a frozen chapter is noticed.
    const content = parseChapterFilePath(verdict.path) ? keepChapterFreeze(args.content as string, current?.content ?? null) : (args.content as string);
    if (current) {
      if (expected === undefined) throw new ToolError("expected_hash_required", `${verdict.path} exists: read it with read_file and pass its hash as expectedHash to replace it, so that a change made meanwhile is never overwritten.`);
      if (expected !== current.hash) throw conflictError(verdict.path);
      if (current.content === content) return json({ written: false, created: false, path: verdict.path, hash: current.hash, message: "Nothing to change: the file already says this." });
    } else if (expected !== undefined) {
      throw conflictError(verdict.path);
    }
    const commit = await context.commit([{ path: verdict.path, content, expectedHash: current ? current.hash : null }], `write ${verdict.path}`);
    return json({ written: true, created: !current, path: verdict.path, hash: await sha256Hex(content), commit });
  },
};

export const WRITE_TOOLS: McpTool[] = [createChapter, updateChapter, createParagraph, updateParagraph, createCanonEntry, updateCanonEntry, writeFileTool];

import matter from "./frontmatter.js";
import { scriptSchema, type ScriptFrontmatter } from "./schemas.js";
import { renderMarkdown } from "./templates.js";

export const SCRIPT_LEDGER_PATH = "state/script-ledger.md";
const SCHEMA_VERSION = 1 as const;
const SECRET_MODES = ["protect", "seed", "partial", "misdirect", "reveal"] as const;
const COMMAND_PATTERN = /^@([a-z][a-z0-9_]*)\{(.*)\}$/;
const DIRECTIVE_PATTERN = /^@[a-z][a-z0-9_]*\{.*\}$/;
const VARIABLE_PATTERN = /^[a-z][a-z0-9_.-]*$/i;
const KNOWN_COMMANDS = new Set(["allowed_clue", "allowed_clues", "assert", "blind_spot", "condition_change", "continuity_in", "continuity_out", "cost", "dialogue_constraint", "dialogue_hidden", "dialogue_surface", "distance", "dramatic_question", "end_secret", "false_history", "focus", "forbidden", "forbidden_on_page", "inventory_change", "knowledge_change", "lens", "location", "location_change", "misdirect", "narration", "open_loop", "pace", "payoff_later", "payoff_now", "pov", "reader_belief", "reader_surface", "relationship_change", "reveal", "reveal_limit", "scene_goal", "secret", "set", "stakes", "state_change", "subtext", "tone", "track", "transition_in", "transition_out", "turning_point", "unset", "var", "voice", "writer_truth"]);
const SECRET_FIELDS = new Set(["allowed_clue", "allowed_clues", "dialogue_hidden", "dialogue_surface", "forbidden", "forbidden_on_page", "misdirect", "reader_belief", "reader_surface", "reveal", "reveal_limit", "writer_truth"]);
const VARIABLE_COMMANDS = new Set(["assert", "set", "track", "unset", "var"]);
const CONTINUITY_COMMANDS = new Set(["condition_change", "false_history", "inventory_change", "knowledge_change", "location_change", "open_loop", "payoff_later", "payoff_now", "relationship_change", "state_change"]);

export type ScriptLedgerSourceFile = { path: string; content: string };
export type ScriptSecretMode = (typeof SECRET_MODES)[number];
export type ScriptCommand = { command: string; content: string; line: number; raw: string };
export type ScriptLedgerCheck = { severity: "error" | "warning"; code: string; path: string; line?: number; message: string };
export type ParsedScriptSecretOccurrence = {
  ref: string; mode: ScriptSecretMode; line: number; raw: string;
  writer_truth: string[]; reader_surface: string[]; reader_belief: string[]; allowed_clues: string[];
  forbidden: string[]; forbidden_on_page: string[]; misdirect: string[]; reveal_limit: string[];
  reveal: string[]; dialogue_surface: string[]; dialogue_hidden: string[];
};
export type ScriptVariableOccurrence = { name: string; operation: "assert" | "set" | "track" | "unset" | "var"; value?: string; line: number; raw: string };
export type ScriptContinuityOccurrence = { kind: string; target?: string; fields: Record<string, string>; text: string; line: number; raw: string };
export type ParsedScriptBody = { commands: ScriptCommand[]; sceneDirectives: ScriptCommand[]; secrets: ParsedScriptSecretOccurrence[]; variables: ScriptVariableOccurrence[]; continuity: ScriptContinuityOccurrence[]; checks: ScriptLedgerCheck[] };
export type ScriptLedgerSecretOccurrence = ParsedScriptSecretOccurrence & { script_path: string; chapter: string; chapter_number: number | null; paragraph: string; paragraph_number: number; title: string; canonical_secret: { exists: boolean; path?: string; title?: string; known_from?: string; reveal_in?: string; false_beliefs?: string[]; reveal_strategy?: string } };
export type ScriptLedgerVariableOccurrence = ScriptVariableOccurrence & { script_path: string; chapter: string; chapter_number: number | null; paragraph: string; paragraph_number: number };
export type ScriptLedgerContinuityOccurrence = ScriptContinuityOccurrence & { script_path: string; chapter: string; chapter_number: number | null; paragraph: string; paragraph_number: number };
export type ScriptLedger = {
  schema_version: typeof SCHEMA_VERSION; generated_at: string;
  scripts: Array<{ path: string; chapter: string; chapter_number: number | null; paragraph: string; paragraph_number: number; title: string; location?: string; pov?: string; scene_goal?: string; commands: ScriptCommand[]; directives: ScriptCommand[] }>;
  secrets: ScriptLedgerSecretOccurrence[];
  variables: { timeline: ScriptLedgerVariableOccurrence[]; latest_by_name: Record<string, { value?: string; script_path: string; line: number }> };
  continuity: { state_changes: ScriptLedgerContinuityOccurrence[]; open_loops: ScriptLedgerContinuityOccurrence[]; payoffs_later: ScriptLedgerContinuityOccurrence[]; payoffs_now: ScriptLedgerContinuityOccurrence[]; false_history: ScriptLedgerContinuityOccurrence[]; other: ScriptLedgerContinuityOccurrence[] };
  checks: ScriptLedgerCheck[];
};

type CanonicalSecret = { path: string; title: string; known_from?: string; reveal_in?: string; false_beliefs: string[]; reveal_strategy?: string };

function check(checks: ScriptLedgerCheck[], severity: ScriptLedgerCheck["severity"], code: string, path: string, message: string, line?: number) {
  checks.push({ severity, code, path, message, ...(line ? { line } : {}) });
}
function optional(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function list(value: string): string[] { return value.split(";").map((part) => part.trim()).filter(Boolean); }
function fields(content: string): { target?: string; fields: Record<string, string> } {
  const out: Record<string, string> = {}; let target: string | undefined;
  for (const token of content.split(/\s+/).filter(Boolean)) { const i = token.indexOf("="); if (i > 0) out[token.slice(0, i).trim()] = token.slice(i + 1).trim(); else target ??= token.trim(); }
  return { target, fields: out };
}
function blankSecret(ref: string, mode: ScriptSecretMode, line: number, raw: string): ParsedScriptSecretOccurrence {
  return { ref, mode, line, raw, writer_truth: [], reader_surface: [], reader_belief: [], allowed_clues: [], forbidden: [], forbidden_on_page: [], misdirect: [], reveal_limit: [], reveal: [], dialogue_surface: [], dialogue_hidden: [] };
}
function completeSecret(secret: ParsedScriptSecretOccurrence, checks: ScriptLedgerCheck[], path: string) {
  if (!secret.writer_truth.length) check(checks, "warning", "secret-block-missing-writer-truth", path, `${secret.ref || "@secret"} has no @writer_truth.`, secret.line);
  if (!secret.reader_surface.length) check(checks, "warning", "secret-block-missing-reader-surface", path, `${secret.ref || "@secret"} has no @reader_surface.`, secret.line);
  if (["protect", "seed", "misdirect"].includes(secret.mode) && !secret.forbidden.length && !secret.forbidden_on_page.length) check(checks, "warning", "secret-block-missing-forbidden", path, `${secret.ref || "@secret"} has no @forbidden_on_page.`, secret.line);
  if (secret.mode === "seed" && !secret.allowed_clues.length) check(checks, "warning", "seed-secret-missing-allowed-clue", path, `${secret.ref} is mode=seed but has no @allowed_clue.`, secret.line);
  if (secret.mode === "misdirect" && !secret.misdirect.length) check(checks, "warning", "misdirect-secret-missing-misdirect", path, `${secret.ref} is mode=misdirect but has no @misdirect.`, secret.line);
  if (secret.mode === "partial" && !secret.reveal_limit.length) check(checks, "warning", "partial-secret-missing-reveal-limit", path, `${secret.ref} is mode=partial but has no @reveal_limit.`, secret.line);
  if (secret.mode === "reveal" && !secret.reveal.length) check(checks, "warning", "reveal-secret-missing-reveal", path, `${secret.ref} is mode=reveal but has no @reveal.`, secret.line);
}
function appendSecret(secret: ParsedScriptSecretOccurrence, command: string, content: string) {
  if (command === "allowed_clue" || command === "allowed_clues") secret.allowed_clues.push(...list(content));
  else if (command === "forbidden" || command === "forbidden_on_page") secret[command].push(...list(content));
  else if (command === "writer_truth" || command === "reader_surface" || command === "reader_belief" || command === "misdirect" || command === "reveal_limit" || command === "reveal" || command === "dialogue_surface" || command === "dialogue_hidden") secret[command].push(content);
}

function parseLegacy(body: string, sourcePath: string): ParsedScriptBody {
  const commands: ScriptCommand[] = [], sceneDirectives: ScriptCommand[] = [], secrets: ParsedScriptSecretOccurrence[] = [], variables: ScriptVariableOccurrence[] = [], continuity: ScriptContinuityOccurrence[] = [], checks: ScriptLedgerCheck[] = [];
  let current: ParsedScriptSecretOccurrence | null = null;
  for (const [index, rawLine] of body.split(/\r?\n/).entries()) {
    const line = index + 1, trimmed = rawLine.trim(); if (!trimmed) continue;
    if (/^#\s*@/.test(trimmed)) { check(checks, "error", "commented-directive", sourcePath, `Commands must use @command{...} as real lines, not comments: ${trimmed}`, line); continue; }
    if (!trimmed.startsWith("@")) continue;
    const match = COMMAND_PATTERN.exec(trimmed); if (!match) { check(checks, "error", "invalid-command-syntax", sourcePath, `Invalid script command syntax: ${trimmed}`, line); continue; }
    const command = match[1].toLowerCase(), content = match[2].trim(); const entry = { command, content, line, raw: trimmed }; commands.push(entry);
    if (!KNOWN_COMMANDS.has(command)) { check(checks, "warning", "unknown-command", sourcePath, `Unknown script command @${command}.`, line); sceneDirectives.push(entry); continue; }
    if (command === "secret") {
      const parsed = fields(content), ref = optional(parsed.fields.ref) ?? optional(parsed.target) ?? "", modeValue = optional(parsed.fields.mode); let mode: ScriptSecretMode = "protect";
      if (!ref) check(checks, "error", "missing-secret-ref", sourcePath, "@secret requires a secret:id reference.", line); else if (!/^secret:[a-z0-9-]+$/i.test(ref)) check(checks, "error", "invalid-secret-ref", sourcePath, `@secret reference must look like secret:slug, got ${ref}.`, line);
      if (!modeValue) check(checks, "warning", "missing-secret-mode", sourcePath, "@secret has no mode; using protect.", line); else if ((SECRET_MODES as readonly string[]).includes(modeValue)) mode = modeValue as ScriptSecretMode; else check(checks, "error", "unknown-secret-mode", sourcePath, `Unknown secret mode ${modeValue}. Use protect, seed, partial, misdirect, or reveal.`, line);
      current = blankSecret(ref, mode, line, trimmed); secrets.push(current); continue;
    }
    if (command === "end_secret") { if (!current) check(checks, "warning", "end-secret-without-secret", sourcePath, "@end_secret was used without an open @secret block.", line); current = null; continue; }
    if (SECRET_FIELDS.has(command)) { if (!current) check(checks, "warning", "secret-field-without-secret", sourcePath, `@${command} must follow an @secret block.`, line); else appendSecret(current, command, content); continue; }
    if (VARIABLE_COMMANDS.has(command)) {
      if (command === "unset" || command === "track") { if (!VARIABLE_PATTERN.test(content)) check(checks, "error", "invalid-variable-name", sourcePath, `Invalid variable name: ${content}`, line); else variables.push({ name: content, operation: command, line, raw: trimmed }); }
      else { const i = content.indexOf("="); if (i <= 0) check(checks, "error", "invalid-variable-assignment", sourcePath, `@${command} requires name=value.`, line); else { const name = content.slice(0, i).trim(), value = content.slice(i + 1).trim(); if (!VARIABLE_PATTERN.test(name)) check(checks, "error", "invalid-variable-name", sourcePath, `Invalid variable name: ${name}`, line); else if (!value) check(checks, "error", "invalid-variable-assignment", sourcePath, `@${command} requires a non-empty value.`, line); else variables.push({ name, operation: command as ScriptVariableOccurrence["operation"], value, line, raw: trimmed }); } }
      continue;
    }
    if (CONTINUITY_COMMANDS.has(command)) { const parsed = fields(content); continuity.push({ kind: command, ...parsed, text: content, line, raw: trimmed }); continue; }
    sceneDirectives.push(entry);
  }
  secrets.forEach((secret) => completeSecret(secret, checks, sourcePath));
  return { commands, sceneDirectives, secrets, variables, continuity, checks };
}

type Node = { kind: string; attrs: Record<string, string>; text?: string; line: number; children: Node[] };
function attrs(raw: string): Record<string, string> { const out: Record<string, string> = {}; const regex = /([a-zA-Z_][\w.-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g; let match: RegExpExecArray | null; while ((match = regex.exec(raw))) out[match[1]] = (match[2] ?? match[3] ?? match[4] ?? "").trim(); return out; }
function tree(body: string): Node[] {
  const root: Node = { kind: "root", attrs: {}, line: 0, children: [] }, stack = [root];
  for (const [index, raw] of body.split(/\r?\n/).entries()) { const line = raw.trim(); if (!line) continue; if (line === "}" || /^\{\/[a-z]+\}$/i.test(line)) { if (stack.length > 1) stack.pop(); continue; } if (line.startsWith("{")) { const inner = line.replace(/^\{/, "").replace(/\}\s*$/, "").trim(), first = inner.split(/\s+/)[0] ?? "section", node: Node = { kind: first.toLowerCase(), attrs: attrs(inner.slice(first.length)), line: index + 1, children: [] }; stack.at(-1)!.children.push(node); if (!/\}\s*$/.test(line)) stack.push(node); continue; } const primitive = /^\[([a-zA-Z_][\w-]*)([^\]]*)\]\s*(.*)$/.exec(line); stack.at(-1)!.children.push(primitive ? { kind: primitive[1].toLowerCase(), attrs: attrs(primitive[2]), text: primitive[3].trim(), line: index + 1, children: [] } : { kind: "tell", attrs: {}, text: line, line: index + 1, children: [] }); }
  return root.children;
}
function parseNested(body: string, sourcePath: string): ParsedScriptBody {
  const commands: ScriptCommand[] = [], sceneDirectives: ScriptCommand[] = [], secrets: ParsedScriptSecretOccurrence[] = [], checks: ScriptLedgerCheck[] = [];
  const directive = (command: string, content: string, line: number) => { const entry = { command, content, line, raw: `${command}=${content}` }; commands.push(entry); sceneDirectives.push(entry); };
  const walk = (nodes: Node[]) => nodes.forEach((node) => {
    if (node.kind === "section") { if (node.attrs.goal) directive("scene_goal", node.attrs.goal, node.line); if (node.attrs.pov) directive("pov", node.attrs.pov, node.line); if (node.attrs.location) directive("location", node.attrs.location, node.line); walk(node.children); }
    else if (node.kind === "dialogue") { if (node.attrs.speaker) directive("pov", node.attrs.speaker, node.line); walk(node.children); }
    else if (node.kind === "location" || node.kind === "character") { if (node.attrs.ref) directive(node.kind === "location" ? "location" : "pov", node.attrs.ref, node.line); walk(node.children); }
    else if (node.kind === "timeline") { directive("track", [node.attrs.ref, node.attrs.date].filter(Boolean).join(" | "), node.line); walk(node.children); }
    else if (node.kind === "item" || node.kind === "faction") { if (node.attrs.ref) directive(node.kind, node.attrs.ref, node.line); walk(node.children); }
    else if (node.kind === "secret") { const ref = node.attrs.ref ?? "", modeValue = (node.attrs.mode ?? "").toLowerCase(), mode = (SECRET_MODES as readonly string[]).includes(modeValue) ? modeValue as ScriptSecretMode : "protect"; if (!ref) check(checks, "error", "missing-secret-ref", sourcePath, "{secret} requires a ref=secret:slug attribute.", node.line); else if (!/^secret:[a-z0-9-]+$/i.test(ref)) check(checks, "error", "invalid-secret-ref", sourcePath, `{secret} ref must look like secret:slug, got ${ref}.`, node.line); if (!node.attrs.mode) check(checks, "warning", "missing-secret-mode", sourcePath, "{secret} has no mode; using protect.", node.line); else if (!(SECRET_MODES as readonly string[]).includes(modeValue)) check(checks, "error", "unknown-secret-mode", sourcePath, `Unknown secret mode ${modeValue}. Use protect, seed, partial, misdirect, or reveal.`, node.line); const secret = blankSecret(ref, mode, node.line, `{secret ref=${ref} mode=${mode}}`); for (const child of node.children) { const value = child.text?.trim(); if (!value) continue; if (child.kind === "surface" || child.kind === "reader_surface") secret.reader_surface.push(value); else if (child.kind === "reveal") secret.reveal.push(value); else if (child.kind === "truth" || child.kind === "writer_truth") secret.writer_truth.push(value); else if (child.kind === "belief" || child.kind === "reader_belief") secret.reader_belief.push(value); else if (child.kind === "clue" || child.kind === "allowed_clue") secret.allowed_clues.push(...list(value)); else if (child.kind === "forbidden") secret.forbidden_on_page.push(...list(value)); else if (child.kind === "misdirect") secret.misdirect.push(value); } commands.push({ command: "secret", content: `${ref} mode=${mode}`, line: node.line, raw: secret.raw }); secrets.push(secret); }
    else walk(node.children);
  });
  walk(tree(body)); secrets.forEach((secret) => completeSecret(secret, checks, sourcePath));
  return { commands, sceneDirectives, secrets, variables: [], continuity: [], checks };
}
export function parseScriptBody(body: string, options: { path?: string } = {}): ParsedScriptBody {
  const path = options.path ?? "script";
  if (/^\s*\{(?:section|dialogue|secret|location|character|item|faction|timeline)\b/m.test(body) || /^\s*\[(?:tell|action|emotion|line|surface|reveal|truth)\b/m.test(body)) { try { return parseNested(body, path); } catch { /* use legacy parser */ } }
  return parseLegacy(body, path);
}

function chapterNumber(ref: string, chapters: Map<string, number>): number | null { const slug = ref.replace(/^chapter:/, ""); return chapters.get(slug) ?? null; }
function position(left: { chapter_number: number | null; paragraph_number: number; line: number; script_path: string }, right: { chapter_number: number | null; paragraph_number: number; line: number; script_path: string }) { return (left.chapter_number ?? Number.MAX_SAFE_INTEGER) - (right.chapter_number ?? Number.MAX_SAFE_INTEGER) || left.paragraph_number - right.paragraph_number || left.line - right.line || left.script_path.localeCompare(right.script_path); }
function resolveChapter(ref: string, chapters: Map<string, number>): number | null { const direct = Number(ref); if (Number.isFinite(direct) && direct > 0) return direct; const slug = ref.replace(/^chapter:/, ""); return chapters.get(slug) ?? (/^(\d{3})-/.exec(slug) ? Number(RegExp.$1) : null); }
function term(text: string, value: string): { line: number; snippet: string } | null { for (const [index, line] of text.split(/\r?\n/).entries()) if (line.toLowerCase().includes(value.toLowerCase())) return { line: index + 1, snippet: summarize(line.trim(), 160) }; return null; }
function summarize(value: string, length: number): string { const normalized = value.replace(/\s+/g, " ").trim(); return normalized.length <= length ? normalized : `${normalized.slice(0, Math.max(0, length - 1)).trimEnd()}…`; }

export function buildScriptLedgerDocument(files: Iterable<ScriptLedgerSourceFile>, options: { generatedAt?: string } = {}): { path: typeof SCRIPT_LEDGER_PATH; content: string; ledger: ScriptLedger } {
  const source = new Map<string, string>(); for (const file of files) source.set(file.path.replace(/^\.\//, "").replace(/\\/g, "/"), file.content);
  const chapters = new Map<string, number>(), canonical = new Map<string, CanonicalSecret>();
  for (const [path, raw] of source) {
    const chapter = /^chapters\/([^/]+)\/chapter\.md$/.exec(path); if (chapter) { const number = Number(matter(raw).data.number); if (Number.isFinite(number)) chapters.set(chapter[1], number); }
    const secret = /^secrets\/([^/]+)\.md$/.exec(path); if (secret) { const data = matter(raw).data, ref = String(data.id ?? `secret:${secret[1]}`); canonical.set(ref.toLowerCase(), { path, title: String(data.title ?? ref), known_from: optional(data.known_from), reveal_in: optional(data.reveal_in), false_beliefs: Array.isArray(data.false_beliefs) ? data.false_beliefs.map(String).filter(Boolean) : [], reveal_strategy: optional(data.reveal_strategy) }); }
  }
  const checks: ScriptLedgerCheck[] = [], scripts: ScriptLedger["scripts"] = [], secrets: ScriptLedgerSecretOccurrence[] = [], timeline: ScriptLedgerVariableOccurrence[] = [];
  const continuity: ScriptLedger["continuity"] = { state_changes: [], open_loops: [], payoffs_later: [], payoffs_now: [], false_history: [], other: [] };
  for (const [path, raw] of [...source].filter(([path]) => /^scripts\/.*\.md$/.test(path)).sort(([a], [b]) => a.localeCompare(b))) {
    const document = matter(raw); let frontmatter: ScriptFrontmatter; try { frontmatter = scriptSchema.parse(document.data); } catch (error) { check(checks, "error", "invalid-script-frontmatter", path, error instanceof Error ? error.message : String(error)); continue; }
    const parsed = parseScriptBody(document.content.trim(), { path }); checks.push(...parsed.checks);
    const chapterSlug = frontmatter.chapter.replace(/^chapter:/, ""), number = chapterNumber(frontmatter.chapter, chapters), paragraphSlug = frontmatter.paragraph.replace(/^paragraph:[^:]+:/, "").replace(/\.md$/i, "").trim(), prosePath = `chapters/${chapterSlug}/${paragraphSlug}.md`, prose = source.has(prosePath) ? matter(source.get(prosePath)!).content.trim() : null;
    const pov = parsed.sceneDirectives.find((entry) => entry.command === "pov"), goal = parsed.sceneDirectives.find((entry) => entry.command === "scene_goal"); if (!pov) check(checks, "warning", "missing-pov", path, "Script has no @pov directive."); if (!goal) check(checks, "warning", "missing-scene-goal", path, "Script has no @scene_goal directive.");
    scripts.push({ path, chapter: `chapter:${chapterSlug}`, chapter_number: number, paragraph: frontmatter.paragraph, paragraph_number: frontmatter.number, title: frontmatter.title, location: frontmatter.location, pov: pov?.content, scene_goal: goal?.content, commands: parsed.commands, directives: parsed.sceneDirectives });
    for (const item of parsed.secrets) { const known = canonical.get(item.ref.toLowerCase()), occurrence: ScriptLedgerSecretOccurrence = { ...item, script_path: path, chapter: `chapter:${chapterSlug}`, chapter_number: number, paragraph: frontmatter.paragraph, paragraph_number: frontmatter.number, title: frontmatter.title, canonical_secret: known ? { exists: true, ...known } : { exists: false, path: item.ref ? `secrets/${item.ref.replace(/^secret:/, "")}.md` : undefined } }; secrets.push(occurrence); if (item.ref && !known) check(checks, "warning", "missing-secret-ref", path, `Script references missing secret: ${item.ref}.`, item.line); if (known?.reveal_in && number !== null) { const reveal = resolveChapter(known.reveal_in, chapters); if (item.mode === "reveal" && reveal !== null && number < reveal) check(checks, "error", "reveal-before-reveal-in", path, `${item.ref} is revealed in chapter ${number}, before reveal_in ${known.reveal_in}.`, item.line); if (item.mode === "protect" && reveal !== null && number > reveal) check(checks, "warning", "protect-after-reveal", path, `${item.ref} is still protected after reveal_in ${known.reveal_in}.`, item.line); } if (prose) { for (const forbidden of [...new Set([...item.forbidden_on_page, ...item.forbidden].map((value) => value.trim()).filter(Boolean))]) { const found = term(prose, forbidden); if (found) check(checks, "error", "forbidden-term-in-prose", prosePath, `Forbidden term "${forbidden}" from ${item.ref} appears in prose: ${found.snippet}`, found.line); } for (const truth of item.writer_truth.flatMap(list)) { if (truth.length < 12) continue; const found = term(prose, truth); if (found) check(checks, "warning", "writer-truth-leaked-into-prose", prosePath, `Writer truth from ${item.ref} appears almost verbatim in prose: ${found.snippet}`, found.line); } } }
    if (prose) for (const [index, line] of prose.split(/\r?\n/).entries()) if (DIRECTIVE_PATTERN.test(line.trim())) check(checks, "error", "directive-leaked-into-prose", prosePath, `Script directive leaked into prose: ${line.trim()}`, index + 1);
    parsed.variables.forEach((item) => timeline.push({ ...item, script_path: path, chapter: `chapter:${chapterSlug}`, chapter_number: number, paragraph: frontmatter.paragraph, paragraph_number: frontmatter.number }));
    parsed.continuity.forEach((item) => { const occurrence = { ...item, script_path: path, chapter: `chapter:${chapterSlug}`, chapter_number: number, paragraph: frontmatter.paragraph, paragraph_number: frontmatter.number }; if (item.kind === "state_change") continuity.state_changes.push(occurrence); else if (item.kind === "open_loop") continuity.open_loops.push(occurrence); else if (item.kind === "payoff_later") continuity.payoffs_later.push(occurrence); else if (item.kind === "payoff_now") continuity.payoffs_now.push(occurrence); else if (item.kind === "false_history") continuity.false_history.push(occurrence); else continuity.other.push(occurrence); });
  }
  scripts.sort((a, b) => (a.chapter_number ?? Number.MAX_SAFE_INTEGER) - (b.chapter_number ?? Number.MAX_SAFE_INTEGER) || a.chapter.localeCompare(b.chapter) || a.paragraph_number - b.paragraph_number || a.path.localeCompare(b.path)); secrets.sort(position); timeline.sort(position); Object.values(continuity).forEach((items) => items.sort(position));
  const reveals = new Map<string, ScriptLedgerSecretOccurrence[]>(); secrets.filter((item) => item.mode === "reveal" && item.ref).forEach((item) => reveals.set(item.ref, [...(reveals.get(item.ref) ?? []), item])); reveals.forEach((items, ref) => items.slice(1).forEach((item) => check(checks, "warning", "duplicate-reveal", item.script_path, `${ref} has more than one mode=reveal occurrence.`, item.line)));
  const latest: ScriptLedger["variables"]["latest_by_name"] = {}, initialized = new Set<string>(); for (const item of timeline) { if (item.operation === "var") { if (initialized.has(item.name)) check(checks, "warning", "variable-conflict", item.script_path, `Variable ${item.name} is declared more than once.`, item.line); initialized.add(item.name); latest[item.name] = { value: item.value, script_path: item.script_path, line: item.line }; } else if (item.operation === "set") { if (!initialized.has(item.name)) check(checks, "warning", "set-before-var", item.script_path, `Variable ${item.name} is set before @var declared it.`, item.line); latest[item.name] = { value: item.value, script_path: item.script_path, line: item.line }; } else if (item.operation === "unset") { if (!(item.name in latest)) check(checks, "warning", "unset-before-var", item.script_path, `Variable ${item.name} is unset before it has a value.`, item.line); delete latest[item.name]; } else if (item.operation === "assert" && latest[item.name]?.value !== item.value) check(checks, "error", "assertion-failed", item.script_path, `Assertion failed for ${item.name}: expected ${item.value}, current ${latest[item.name]?.value ?? "unset"}.`, item.line); }
  const sortedLatest = Object.fromEntries(Object.entries(latest).sort(([a], [b]) => a.localeCompare(b))), generatedAt = options.generatedAt ?? new Date().toISOString(); checks.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.severity.localeCompare(b.severity) || a.code.localeCompare(b.code));
  const ledger: ScriptLedger = { schema_version: SCHEMA_VERSION, generated_at: generatedAt, scripts, secrets, variables: { timeline, latest_by_name: sortedLatest }, continuity, checks };
  return { path: SCRIPT_LEDGER_PATH, content: renderMarkdown({ type: "script-ledger", id: "state:script-ledger", title: "Script Ledger", generated_at: generatedAt, source: "scripts", schema_version: SCHEMA_VERSION, script_count: scripts.length, secret_occurrence_count: secrets.length, variable_occurrence_count: timeline.length, check_count: checks.length }, renderBody(ledger)), ledger };
}

function ordinal(value: number) { return String(value).padStart(3, "0"); }
function escape(value: string) { return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " "); }
function label(value: { chapter_number: number | null; paragraph_number: number; script_path: string; line?: number }) { return `${value.chapter_number === null ? "Chapter ?" : `Chapter ${ordinal(value.chapter_number)}`}, paragraph ${ordinal(value.paragraph_number)} (${value.script_path}${value.line ? `:${value.line}` : ""})`; }
function renderBody(ledger: ScriptLedger): string {
  const secretRows = ledger.secrets.length ? ["| Position | Secret | Mode | Explanation |", "| --- | --- | --- | --- |", ...ledger.secrets.map((item) => `| ${escape(label(item))} | \`${escape(item.ref)}\` | \`${item.mode}\` | ${escape(summarize(item.writer_truth[0] ?? item.canonical_secret.title ?? "No writer truth recorded.", 180))} |`)] : ["No script secrets tracked."];
  const variableRows = Object.entries(ledger.variables.latest_by_name).length ? ["| Variable | Latest Value | Last Position |", "| --- | --- | --- |", ...Object.entries(ledger.variables.latest_by_name).map(([name, value]) => `| \`${escape(name)}\` | \`${escape(value.value ?? "unset")}\` | ${escape(`${value.script_path}:${value.line}`)} |`)] : ["No script variables tracked."];
  const continuity = [...ledger.continuity.state_changes, ...ledger.continuity.open_loops, ...ledger.continuity.payoffs_later, ...ledger.continuity.payoffs_now, ...ledger.continuity.false_history, ...ledger.continuity.other].sort(position), continuityRows = continuity.length ? ["| Position | Kind | Value |", "| --- | --- | --- |", ...continuity.map((item) => `| ${escape(label(item))} | \`${item.kind}\` | ${escape(item.text)} |`)] : ["No script continuity directives tracked."];
  const checkRows = ledger.checks.length ? ["| Severity | Code | Location | Message |", "| --- | --- | --- | --- |", ...ledger.checks.map((item) => `| ${item.severity} | \`${escape(item.code)}\` | ${escape(`${item.path}${item.line ? `:${item.line}` : ""}`)} | ${escape(item.message)} |`)] : ["No script ledger checks reported."];
  return ["# Script Ledger", "", "Generated from `scripts/<chapter>/<paragraph>.md`. Do not edit this file by hand. Run `sync_script_ledger`.", "", "<!-- narrarium:script-ledger:data -->", "```json", JSON.stringify(ledger, null, 2), "```", "<!-- narrarium:script-ledger:data-end -->", "", "# Secret Map", "", ...secretRows, "", "# Variable Map", "", ...variableRows, "", "# Continuity Map", "", ...continuityRows, "", "# Checks", "", ...checkRows].join("\n");
}

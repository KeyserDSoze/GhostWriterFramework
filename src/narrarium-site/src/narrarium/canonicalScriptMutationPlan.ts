import { buildScriptLedgerDocument, SCRIPT_LEDGER_PATH, type ScriptLedgerCheck, type ScriptLedgerSourceFile } from "narrarium/script-ledger";

export const SCRIPT_PATH_PATTERN = /^scripts\/.*\.md$/;

export type CanonicalScriptMutation = {
  path: string;
  content: string | null;
  expectedCurrentHash?: string | null;
  ifAbsent?: boolean;
};

export type CanonicalScriptMutationResult = {
  changed: boolean;
  changedPaths: string[];
  checks: ScriptLedgerCheck[];
  errorCount: number;
  warningCount: number;
  revisions: Record<string, { content: string | null; hash: string | null; previousContent: string | null; previousHash: string | null }>;
  commitSha?: string;
  mode?: "local" | "remote";
};

export class CanonicalScriptConflictError extends Error {
  readonly code = "REPOSITORY_CONFLICT";
  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export class ScriptLedgerValidationError extends Error {
  readonly code = "SCRIPT_LEDGER_VALIDATION";
  constructor(readonly checks: ScriptLedgerCheck[]) {
    super(`Script ledger validation failed: ${checks.map(formatScriptLedgerCheck).join("; ")}`);
    this.name = "ScriptLedgerValidationError";
  }
}

export function formatScriptLedgerCheck(check: ScriptLedgerCheck): string {
  return `${check.path}${check.line ? `:${check.line}` : ""} [${check.code}] ${check.message}`;
}

export async function hashCanonicalText(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function planCanonicalScriptMutation(
  files: ScriptLedgerSourceFile[],
  mutations: CanonicalScriptMutation[],
  options: { ledgerGeneratedAt?: string } = {},
): Promise<{ result: CanonicalScriptMutationResult; mutations: CanonicalScriptMutation[] }> {
  if (!mutations.length) throw new Error("At least one script mutation is required.");
  const sourceMutations = mutations.filter((mutation) => mutation.path !== SCRIPT_LEDGER_PATH);
  if (!sourceMutations.some((mutation) => SCRIPT_PATH_PATTERN.test(mutation.path))) throw new Error("A canonical script mutation must change at least one scripts/**/*.md path.");
  const paths = new Set<string>();
  for (const mutation of sourceMutations) {
    if (paths.has(mutation.path)) throw new Error(`Duplicate script mutation path: ${mutation.path}`);
    paths.add(mutation.path);
  }

  const current = new Map(files.map((file) => [file.path, file.content]));
  const original = new Map(current);
  const changed: CanonicalScriptMutation[] = [];
  for (const mutation of sourceMutations) {
    const previous = current.get(mutation.path) ?? null;
    if (mutation.expectedCurrentHash !== undefined) {
      const actual = previous === null ? null : await hashCanonicalText(previous);
      if (actual !== mutation.expectedCurrentHash) throw new CanonicalScriptConflictError(previous === null ? `File does not exist: ${mutation.path}` : `File changed since it was read: ${mutation.path}`, mutation.path);
    }
    if (mutation.ifAbsent && previous !== null) continue;
    if (mutation.content === previous || (mutation.content === null && previous === null)) continue;
    changed.push({ ...mutation, expectedCurrentHash: previous === null ? null : await hashCanonicalText(previous) });
    if (mutation.content === null) current.delete(mutation.path);
    else current.set(mutation.path, mutation.content);
  }

  const previousLedger = current.get(SCRIPT_LEDGER_PATH) ?? null;
  const previousGeneratedAt = options.ledgerGeneratedAt ?? (!changed.length && previousLedger
    ? /^generated_at:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(previousLedger)?.[1].trim()
    : undefined);
  const ledger = buildScriptLedgerDocument([...current].map(([path, content]) => ({ path, content })), previousGeneratedAt ? { generatedAt: previousGeneratedAt } : {});
  const errors = ledger.ledger.checks.filter((check) => check.severity === "error");
  if (errors.length) throw new ScriptLedgerValidationError(errors);
  const warnings = ledger.ledger.checks.filter((check) => check.severity === "warning");
  const planned = [...changed];
  if (previousLedger !== ledger.content) planned.push({ path: SCRIPT_LEDGER_PATH, content: ledger.content, expectedCurrentHash: previousLedger === null ? null : await hashCanonicalText(previousLedger) });
  const revisionPaths = new Set([...mutations.map((mutation) => mutation.path), ...planned.map((mutation) => mutation.path)]);
  const revisions: CanonicalScriptMutationResult["revisions"] = {};
  for (const path of revisionPaths) {
    const previousContent = original.get(path) ?? null;
    const content = path === SCRIPT_LEDGER_PATH ? ledger.content : current.get(path) ?? null;
    revisions[path] = {
      content,
      hash: content === null ? null : await hashCanonicalText(content),
      previousContent,
      previousHash: previousContent === null ? null : await hashCanonicalText(previousContent),
    };
  }
  if (!planned.length) return { result: { changed: false, changedPaths: [], checks: ledger.ledger.checks, errorCount: 0, warningCount: warnings.length, revisions }, mutations: [] };
  return {
    result: { changed: true, changedPaths: planned.map((mutation) => mutation.path), checks: ledger.ledger.checks, errorCount: 0, warningCount: warnings.length, revisions },
    mutations: planned,
  };
}

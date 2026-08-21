import { Octokit } from "@octokit/rest";
import { parseDocument, stringify } from "yaml";
import { SCRIPT_LEDGER_PATH, type ScriptLedgerSourceFile } from "narrarium/script-ledger";
import { loadRemoteFileContentAtRef } from "@/github/githubClient";
import { getLocalRepository, listLocalFiles } from "@/repository/localRepository";
import { commitAndPushTextFileMutation, preflightRepositoryOperation, RepositoryConflictError, sha256Text } from "@/repository/safeRepositoryMutation";
import type { BookEntry } from "@/types/settings";
import { accountIdentity } from "@/auth/accountIdentity";
import { useAuthStore } from "@/store/authStore";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";

import { CanonicalScriptConflictError, planCanonicalScriptMutation, type CanonicalScriptMutation, type CanonicalScriptMutationResult } from "@/narrarium/canonicalScriptMutationPlan";

const SCRIPT_PATH = /^scripts\/.*\.md$/;
const isLedgerSource = (path: string) => path === SCRIPT_LEDGER_PATH || SCRIPT_PATH.test(path) || /^chapters\/.*\.md$/.test(path) || /^secrets\/[^/]+\.md$/.test(path);

export { planCanonicalScriptMutation, ScriptLedgerValidationError, formatScriptLedgerCheck } from "@/narrarium/canonicalScriptMutationPlan";
export type { CanonicalScriptMutation, CanonicalScriptMutationResult } from "@/narrarium/canonicalScriptMutationPlan";

async function collectSources(input: { token: string; book: BookEntry; branch: string; signal?: AbortSignal }, extraPaths: string[] = []): Promise<{ files: ScriptLedgerSourceFile[]; headSha: string }> {
  const requested = new Set(extraPaths);
  input.signal?.throwIfAborted();
  const identity = accountIdentity(useAuthStore.getState().user);
  const local = identity ? await getLocalRepository(input.book.owner, input.book.repo, input.branch, captureRepositoryOperationScope()).catch(() => null) : null;
  input.signal?.throwIfAborted();
  if (local) {
    const preflight = await preflightRepositoryOperation(input);
    const files = (await listLocalFiles(local.id))
      .filter((file) => file.kind === "text" && typeof file.text === "string" && (isLedgerSource(file.path) || requested.has(file.path)))
      .map((file) => ({ path: file.path, content: file.text! }));
    input.signal?.throwIfAborted();
    return { files, headSha: preflight.remoteHeadSha };
  }

  const octokit = new Octokit({ auth: input.token });
  const request = { request: { signal: input.signal } };
  const ref = await octokit.rest.git.getRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${input.branch}`, ...request });
  input.signal?.throwIfAborted();
  const headSha = ref.data.object.sha;
  const tree = await octokit.rest.git.getTree({ owner: input.book.owner, repo: input.book.repo, tree_sha: headSha, recursive: "1", ...request });
  if (tree.data.truncated) throw new Error("Repository tree is truncated; the script ledger cannot be rebuilt safely.");
  const paths = tree.data.tree.filter((entry) => entry.type === "blob" && entry.path && (isLedgerSource(entry.path) || requested.has(entry.path))).map((entry) => entry.path!);
  const files = await Promise.all(paths.map(async (path) => ({ path, content: (await loadRemoteFileContentAtRef(input.token, input.book.owner, input.book.repo, path, headSha, input.signal)).content })));
  input.signal?.throwIfAborted();
  return { files, headSha };
}

export async function commitCanonicalScriptMutation(input: {
  token: string;
  book: BookEntry;
  branch: string;
  message: string;
  mutations: CanonicalScriptMutation[];
  expectedRemoteHeadSha?: string;
  signal?: AbortSignal;
  ledgerGeneratedAt?: string;
}): Promise<CanonicalScriptMutationResult> {
  const snapshot = await collectSources(input, input.mutations.map((mutation) => mutation.path));
  if (input.expectedRemoteHeadSha && snapshot.headSha !== input.expectedRemoteHeadSha) throw new RepositoryConflictError("The source branch changed while preparing the script mutation.");
  input.signal?.throwIfAborted();
  let planned;
  try {
    planned = await planCanonicalScriptMutation(snapshot.files, input.mutations, { ledgerGeneratedAt: input.ledgerGeneratedAt });
  } catch (error) {
    if (error instanceof CanonicalScriptConflictError) throw new RepositoryConflictError(error.message, error.path);
    throw error;
  }
  if (!planned.result.changed) return planned.result;
  input.signal?.throwIfAborted();
  const committed = await commitAndPushTextFileMutation({
    token: input.token,
    book: input.book,
    branch: input.branch,
    expectedRemoteHeadSha: snapshot.headSha,
    message: input.message,
    mutations: planned.mutations,
    signal: input.signal,
    push: false,
  });
  return { ...planned.result, ...committed };
}

export async function commitScriptWithCanonicalLedger(input: {
  token: string;
  book: BookEntry;
  branch: string;
  script: ScriptLedgerSourceFile;
  message: string;
  expectedRemoteHeadSha?: string;
  signal?: AbortSignal;
  replace?: boolean;
  ifAbsent?: boolean;
}): Promise<CanonicalScriptMutationResult> {
  let content = input.script.content;
  let expectedCurrentHash: string | null | undefined = input.replace || input.ifAbsent ? undefined : null;
  if (input.replace) {
    const snapshot = await collectSources(input);
    if (input.expectedRemoteHeadSha && snapshot.headSha !== input.expectedRemoteHeadSha) throw new RepositoryConflictError("The source branch changed while generating the script.");
    const previous = snapshot.files.find((file) => file.path === input.script.path)?.content;
    if (previous !== undefined) {
      content = mergeScriptFrontmatter(previous, content);
      expectedCurrentHash = await sha256Text(previous);
    } else expectedCurrentHash = null;
  }
  return commitCanonicalScriptMutation({ ...input, mutations: [{ path: input.script.path, content, expectedCurrentHash, ifAbsent: input.ifAbsent }] });
}

function mergeScriptFrontmatter(existingRaw: string, generatedRaw: string): string {
  const parse = (raw: string) => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    return match ? { frontmatter: (parseDocument(match[1]).toJSON() as Record<string, unknown>) ?? {}, body: match[2] } : { frontmatter: {}, body: raw };
  };
  const existing = parse(existingRaw);
  const generated = parse(generatedRaw);
  const managedKeys = Object.keys(generated.frontmatter);
  const preserved = Object.fromEntries(Object.entries(existing.frontmatter).filter(([key]) => !managedKeys.includes(key)));
  const frontmatter = { ...preserved, ...generated.frontmatter };
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${generated.body.replace(/^\n+/, "")}`;
}

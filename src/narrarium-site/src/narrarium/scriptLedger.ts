import { Octokit } from "@octokit/rest";
import { buildScriptLedgerDocument, SCRIPT_LEDGER_PATH, type ScriptLedgerSourceFile } from "narrarium/script-ledger";
import { loadRemoteFileContentAtRef } from "@/github/githubClient";
import { getLocalRepository, listLocalFiles } from "@/repository/localRepository";
import { commitAndPushTextFileMutation, preflightRepositoryOperation, sha256Text } from "@/repository/safeRepositoryMutation";
import type { BookEntry } from "@/types/settings";

const isLedgerSource = (path: string) => path === SCRIPT_LEDGER_PATH || /^scripts\/.*\.md$/.test(path) || /^chapters\/.*\.md$/.test(path) || /^secrets\/[^/]+\.md$/.test(path);

async function collectSources(input: { token: string; book: BookEntry; branch: string }): Promise<{ files: ScriptLedgerSourceFile[]; headSha: string }> {
  const local = await getLocalRepository(input.book.owner, input.book.repo, input.branch).catch(() => null);
  if (local) {
    const preflight = await preflightRepositoryOperation(input);
    const files = (await listLocalFiles(local.id))
      .filter((file) => file.kind === "text" && typeof file.text === "string" && isLedgerSource(file.path))
      .map((file) => ({ path: file.path, content: file.text! }));
    return { files, headSha: preflight.remoteHeadSha };
  }

  const octokit = new Octokit({ auth: input.token });
  const ref = await octokit.rest.git.getRef({ owner: input.book.owner, repo: input.book.repo, ref: `heads/${input.branch}` });
  const headSha = ref.data.object.sha;
  const tree = await octokit.rest.git.getTree({ owner: input.book.owner, repo: input.book.repo, tree_sha: headSha, recursive: "1" });
  if (tree.data.truncated) throw new Error("Repository tree is truncated; the script ledger cannot be rebuilt safely.");
  const paths = tree.data.tree.filter((entry) => entry.type === "blob" && entry.path && isLedgerSource(entry.path)).map((entry) => entry.path!);
  const files = await Promise.all(paths.map(async (path) => ({ path, content: (await loadRemoteFileContentAtRef(input.token, input.book.owner, input.book.repo, path, headSha)).content })));
  return { files, headSha };
}

export async function commitScriptWithCanonicalLedger(input: {
  token: string;
  book: BookEntry;
  branch: string;
  script: ScriptLedgerSourceFile;
  message: string;
}): Promise<void> {
  const snapshot = await collectSources(input);
  const byPath = new Map(snapshot.files.map((file) => [file.path, file.content]));
  const previousScript = byPath.get(input.script.path) ?? null;
  const previousLedger = byPath.get(SCRIPT_LEDGER_PATH) ?? null;
  byPath.set(input.script.path, input.script.content);
  const ledger = buildScriptLedgerDocument([...byPath].map(([path, content]) => ({ path, content })));
  await commitAndPushTextFileMutation({
    token: input.token,
    book: input.book,
    branch: input.branch,
    expectedRemoteHeadSha: snapshot.headSha,
    message: input.message,
    mutations: [
      { path: input.script.path, content: input.script.content, expectedCurrentHash: previousScript === null ? null : await sha256Text(previousScript) },
      { path: SCRIPT_LEDGER_PATH, content: ledger.content, expectedCurrentHash: previousLedger === null ? null : await sha256Text(previousLedger) },
    ],
  });
}

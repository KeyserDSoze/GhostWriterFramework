import { readFileWithSha, isGitHubFileNotFoundError } from "@/github/githubClient";
import { sourceRevisionFromFiles } from "@/assistant/actionValidation";
import type { AssistantFileUpdate, AssistantMessage, PageChangeRow } from "@/assistant/store";
import type { PageEnv, PageId } from "@/assistant/pages/types";

/**
 * What every proposal for a page is made of: the files as they are now (what a change is applied over, and checked against when the author applies it), the
 * review the author reads (every thing of the page with its resulting state) and the action that applies it, with the provenance of the Copilot's proposals.
 */

export type CurrentFiles = Map<string, { content: string; sha: string } | null>;

export async function readPageFiles(env: Pick<PageEnv, "token" | "book" | "branch">, paths: readonly string[]): Promise<CurrentFiles> {
  return new Map(await Promise.all([...new Set(paths)].map(async (path) => [path, await readFileWithSha(env.token, env.book.owner, env.book.repo, env.branch, path).catch((error) => {
    if (isGitHubFileNotFoundError(error)) return null;
    throw error;
  })] as const)));
}

const COUNT_WORDS: Record<Exclude<PageChangeRow["change"], "unchanged">, { en: string; it: [string, string] }> = {
  created: { en: "created", it: ["creato", "creati"] },
  edited: { en: "edited", it: ["modificato", "modificati"] },
  "turned-on": { en: "turned on", it: ["acceso", "accesi"] },
  "turned-off": { en: "turned off", it: ["spento", "spenti"] },
  removed: { en: "removed", it: ["rimosso", "rimossi"] },
};

/** What a proposal changes, in a few words: «3 created, 8 turned off» («3 creati, 8 spenti»). */
export function changeCounts(rows: readonly PageChangeRow[], italian: boolean): string {
  return (Object.keys(COUNT_WORDS) as Array<keyof typeof COUNT_WORDS>)
    .map((change) => [change, rows.filter((row) => row.change === change).length] as const)
    .filter(([, count]) => count > 0)
    .map(([change, count]) => `${count} ${italian ? COUNT_WORDS[change].it[count === 1 ? 0 : 1] : COUNT_WORDS[change].en}`)
    .join(", ");
}

/** A value as the review shows it: a list joined, a long text cut. */
export function shortValue(value: unknown, max = 160): string {
  const text = Array.isArray(value) ? value.join(", ") : value && typeof value === "object" ? Object.entries(value).map(([key, entry]) => `${key}: ${String(entry)}`).join(", ") : value === undefined || value === null ? "" : String(value);
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** A field of a profile in the review: its value before and after when it changes. */
export function fieldRow(key: string, label: string, before: unknown, after: unknown): PageChangeRow {
  const changed = JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
  return changed ? { id: key, name: label, change: "edited", from: shortValue(before) || "—", to: shortValue(after) || "—" } : { id: key, name: label, change: "unchanged", to: shortValue(after) || "—" };
}

/** The proposal: what the author reads first, and the action that applies the files, reviewed as `rows`. */
export function pageProposal(input: { env: PageEnv; toolId: string; page: PageId; updates: AssistantFileUpdate[]; current: CurrentFiles; rows: PageChangeRow[]; text: string }): AssistantMessage {
  const sourceRevisions = Object.fromEntries(input.updates.map((update) => [update.path, input.current.get(update.path)?.sha ?? null]));
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: input.text,
    action: {
      kind: "apply-file-updates",
      bookId: input.env.book.id,
      toolId: input.toolId,
      owner: input.env.book.owner,
      repo: input.env.book.repo,
      branch: input.env.branch,
      sourceRevision: sourceRevisionFromFiles(sourceRevisions),
      sourceRevisions,
      generatedAt: new Date().toISOString(),
      updates: input.updates,
      review: { page: input.page, rows: input.rows },
    },
  };
}

/** The first lines of a proposal for the author: what it changes, and that nothing is written before it is applied. */
export function proposalHead(what: { en: string; it: string }, rows: readonly PageChangeRow[], italian: boolean, problems: readonly string[] = []): string {
  const counts = changeCounts(rows, italian);
  const head = italian ? `${what.it}: ${counts}. Nulla cambia finché non applichi la proposta.` : `${what.en}: ${counts}. Nothing changes until you apply the proposal.`;
  return problems.length ? `${head}\n\n${italian ? "Non fatto" : "Not done"}: ${problems.join(" ")}` : head;
}

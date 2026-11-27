import type { RepositoryTextMutation } from "@/repository/safeRepositoryMutation";
import type { UpdateTarget } from "@/readerUpdate/decision";

/**
 * The ONE commit of an update of the reader: the workflow the reader package writes (`planPagesWorkflowUpgrade`, keeping the older single password as one
 * slot), then the reader's files from the template. The file list is the whole of it; the book's own files are never in it.
 */
/** What a commit of the update changes on one branch: the update decision for the working branch, or the target for the publishing branch. */
type Update = Pick<UpdateTarget, "workflow" | "workflowChanges" | "customized" | "folder">;

/** The owner has not said «replace my edits» for a workflow that has some: nothing is committed. */
export class CustomizedWorkflowRefused extends Error {
  readonly code = "READER_WORKFLOW_CUSTOMIZED";
  constructor() {
    super("The workflow has edits that the update would replace.");
    this.name = "CustomizedWorkflowRefused";
  }
}

export interface ReaderUpdateCommit {
  message: string;
  mutations: RepositoryTextMutation[];
  /** The paths of the files the commit changes, in order. */
  paths: string[];
}

export function buildReaderUpdateCommit(update: Update, options: { replaceEdits: boolean; workflowHash: string | null; /** A branch read from GitHub: the files are checked by the head they were planned against, not by a hash of each. */ unchecked?: boolean }): ReaderUpdateCommit {
  if (update.customized && !options.replaceEdits) throw new CustomizedWorkflowRefused();
  const mutations: RepositoryTextMutation[] = [];
  const guard = (hash: string | null | undefined) => (options.unchecked ? {} : { expectedCurrentHash: hash });
  if (update.workflowChanges) mutations.push({ path: update.workflow.path, content: update.workflow.text, ...guard(options.workflowHash) });
  for (const file of update.folder.writes) mutations.push({ path: file.path, content: file.content, ...guard(file.expectedHash) });
  for (const file of update.folder.deletes) mutations.push({ path: file.path, content: null, ...guard(file.expectedHash) });
  const added = update.folder.writes.filter((file) => file.change === "added").length;
  const replaced = update.folder.writes.length - added;
  const title = update.folder.version ? `Update the reader to version ${update.folder.version}` : "Update the reader";
  const lines = [
    ...(update.workflowChanges ? update.workflow.changes.map((change) => `- Workflow: ${change}`) : []),
    ...(update.workflowChanges && update.customized ? ["- The edits of the workflow were replaced, as the author asked."] : []),
    `- Reader files: ${replaced} replaced, ${added} added${update.folder.deletes.length ? `, ${update.folder.deletes.length} deleted` : ""}.`,
    "- The book's own files are not touched.",
  ];
  return { message: `${title}\n\n${lines.join("\n")}\n`, mutations, paths: mutations.map((mutation) => mutation.path) };
}

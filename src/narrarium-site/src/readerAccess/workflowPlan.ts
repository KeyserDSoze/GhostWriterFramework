import { planPagesWorkflowUpgrade, type PagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";
import { workflowSupportsReaderPasswords } from "@/readerAccess/capability";

/**
 * What the reader package says of the Pages workflow a repository has (`planPagesWorkflowUpgrade`): this site never writes that file's text itself.
 *
 * For adding a password the question is only whether the workflow reads them: the current one does, one the package generated before the key slots does not
 * (`outdated`), an edited one does when it names the variable (`customized`; the owner's edits are theirs, and the update offer treats them as such), and
 * the previous version of the package's own (`previous`, version 2: every secret as JSON) reads them too, so passwords added to it protect the reader at
 * once; it is only older, and GitHub may hold it at «Action required», which the update to version 3 cures.
 */
export type ReaderWorkflowState = "missing" | "current" | "outdated" | "customized" | "previous";

/** The package's plan for the workflow text a repository has now (`null`: no file). */
export function planReaderWorkflow(content: string | null): PagesWorkflowUpgrade {
  return planPagesWorkflowUpgrade(content);
}

export function inspectReaderWorkflow(content: string | null): ReaderWorkflowState {
  const plan = planReaderWorkflow(content);
  if (plan.status === "missing") return "missing";
  if (plan.status === "current") return "current";
  if (plan.status === "generated" && plan.fromVersion === 2 && workflowSupportsReaderPasswords(content)) return "previous";
  if (plan.status === "customized" && workflowSupportsReaderPasswords(content)) return "customized";
  return "outdated";
}

import { planPagesWorkflowUpgrade, type PagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";
import { workflowSupportsReaderPasswords } from "@/readerAccess/capability";

/**
 * What the reader package says of the Pages workflow a repository has (`planPagesWorkflowUpgrade`): this site never writes that file's text itself.
 *
 * For adding a password the question is only whether the workflow reads them: the current one does, one the package generated before the key slots does not
 * (`outdated`), and an edited one does when it names the variable (`customized`; the owner's edits are theirs, and the update offer treats them as such).
 */
export type ReaderWorkflowState = "missing" | "current" | "outdated" | "customized";

/** The package's plan for the workflow text a repository has now (`null`: no file). */
export function planReaderWorkflow(content: string | null): PagesWorkflowUpgrade {
  return planPagesWorkflowUpgrade(content);
}

export function inspectReaderWorkflow(content: string | null): ReaderWorkflowState {
  const plan = planReaderWorkflow(content);
  if (plan.status === "missing") return "missing";
  if (plan.status === "current") return "current";
  if (plan.status === "customized" && workflowSupportsReaderPasswords(content)) return "customized";
  return "outdated";
}

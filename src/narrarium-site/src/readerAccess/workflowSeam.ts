/**
 * THE SEAM for the reader workflow (the package that writes it owns its content). This site never writes that file's text: until the package exports its
 * helper no update is offered. When the package lands, only this file changes: `inspect`
 * says whether the repository's file is the current one, and `update` commits the package's new file to the repository.
 */
import { workflowSupportsReaderPasswords } from "@/readerAccess/capability";

export type ReaderWorkflowState = "missing" | "current" | "outdated" | "unknown";

/**
 * `null`: the repository has no workflow file. A workflow that names the variable of the passwords (`READER_PASSWORD_SECRETS`) reads them (`current`); one that
 * does not is `outdated`: a password put on GitHub for it would be ignored and the reader would stay public. This is all the site claims of a workflow: what
 * the current workflow is, in full, is the package's to say (`updateReaderWorkflow`).
 */
export function inspectReaderWorkflow(content: string | null): ReaderWorkflowState {
  if (content === null) return "missing";
  return workflowSupportsReaderPasswords(content) ? "current" : "outdated";
}

/** The package's helper that updates an existing repository's workflow. `null` until it exists: the button that would call it is not shown. */
export const updateReaderWorkflow: null | ((input: { token: string; owner: string; repo: string; branch: string }) => Promise<void>) = null;

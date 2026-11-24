/**
 * THE SEAM for the reader workflow (the package that writes it owns its content). This site never writes that file's text: until the package exports its
 * helper, a repository whose workflow cannot be told apart is `unknown` and no update is offered. When the package lands, only this file changes: `inspect`
 * says whether the repository's file is the current one, and `update` commits the package's new file to the repository.
 */
export type ReaderWorkflowState = "missing" | "current" | "outdated" | "unknown";

/** `null`: the repository has no workflow file. Any text: whatever the package can tell about it (until it can, `unknown`). */
export function inspectReaderWorkflow(content: string | null): ReaderWorkflowState {
  if (content === null) return "missing";
  return "unknown";
}

/** The package's helper that updates an existing repository's workflow. `null` until it exists: the button that would call it is not shown. */
export const updateReaderWorkflow: null | ((input: { token: string; owner: string; repo: string; branch: string }) => Promise<void>) = null;

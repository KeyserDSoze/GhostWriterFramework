import { READER_PASSWORDS_VARIABLE, READER_WORKFLOW_PATH } from "@/readerAccess/contract";

/**
 * Whether the reader that a book publishes can honour passwords at all. Nothing that protects is offered before the published workflow can read the
 * passwords from the secrets: a password set for a workflow that ignores it would leave the reader public while the owner believes it is protected.
 *
 * The answer is read from the workflow itself, never assumed: a workflow that names the variable `READER_PASSWORD_SECRETS` is one that reads the passwords.
 * For a new repository that is the workflow of the template the site makes it from (the snapshot of the reader package's scaffolder); for an existing one,
 * the workflow in the repository (see `workflowSeam`). So it turns on by itself when the template that ships with the site is the one of the reader
 * package that has key slots.
 *
 * `READER_PASSWORDS_OVERRIDE` is the one switch for a release: `null` follows the workflow, `false` hides everything protective whatever the workflow says
 * (for a release of the site that must not offer it yet), `true` offers it whatever the workflow says (never to be shipped; for a test).
 */
export const READER_PASSWORDS_OVERRIDE: boolean | null = null;

export function workflowSupportsReaderPasswords(workflowText: string | null | undefined, override: boolean | null = READER_PASSWORDS_OVERRIDE): boolean {
  if (override !== null) return override;
  return typeof workflowText === "string" && workflowText.includes(READER_PASSWORDS_VARIABLE);
}

/** Whether the workflow of the site's template for new books can honour passwords. */
export function templateSupportsReaderPasswords(template: { files: Record<string, { text: string }> }, override: boolean | null = READER_PASSWORDS_OVERRIDE): boolean {
  return workflowSupportsReaderPasswords(template.files[READER_WORKFLOW_PATH]?.text, override);
}

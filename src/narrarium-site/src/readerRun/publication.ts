import { READER_PASSWORDS_VARIABLE } from "@/readerAccess/contract";
import { readerProtection, type ReaderPasswordRow, type RemoteReaderState } from "@/readerAccess/model";
import type { OutsideCheckResult } from "@/readerUpdate/outsideCheck";

/**
 * Whether the reader that is PUBLISHED asks for a password, which is not what GitHub holds in its secrets: a secret that no workflow reads protects nothing.
 * Passwords can be prepared at any time (the secret and the list are inert for a workflow that does not read them, see `inertForOldWorkflow`), so the secrets
 * alone no longer say anything about the published site. What does:
 *
 *  - the outside check (the EPUB must answer 404 and `version.json` say `protected`) is the proof, either way;
 *  - without it, the workflow of the commit that built the latest successful publication: when it reads the passwords, the site was built with them.
 *
 * A reader is called protected only on that evidence; while a publication is going nothing is claimed; when it cannot be known, nothing is claimed.
 */
export type ReaderPublication =
  /** Passwords are set and the published reader asks for one. */
  | "protecting"
  /** Passwords are set, but the published reader does not use them yet: it is public. */
  | "prepared"
  /** Passwords are set and a publication is going: what it makes is not known yet. */
  | "publishing"
  /** No password is set. */
  | "public"
  /** GitHub could not be read, or the workflow that built the published reader could not be. */
  | "unknown";

export interface PublicationEvidence {
  remote: RemoteReaderState;
  /** The workflow that built the latest successful publication reads the passwords; `null` when there is no such publication or its workflow could not be read. */
  builtReadsPasswords: boolean | null;
  /** A publication that was started and has not ended. */
  publishing: boolean;
  outside: OutsideCheckResult | null;
}

export function readerPublication(input: PublicationEvidence): ReaderPublication {
  const configured = readerProtection(input.remote);
  if (configured === "unknown") return "unknown";
  if (configured === "public") return "public";
  if (input.outside?.kind === "protected") return "protecting";
  if (input.outside?.kind === "epub-exposed" || input.outside?.kind === "not-protected") return "prepared";
  if (input.publishing) return "publishing";
  if (input.builtReadsPasswords === true) return "protecting";
  if (input.builtReadsPasswords === false) return "prepared";
  return "unknown";
}

/**
 * The workflow text reads the passwords: it names the variable that lists their secrets, or it is one of the older workflows that name the single secret.
 * (The package's own answer for the current workflow is `workflowSupportsReaderPasswords`; this one also takes the older single-password line, which does
 * protect.)
 */
export function workflowPublishesPasswords(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  return text.includes(READER_PASSWORDS_VARIABLE) || /NARRARIUM_READER_PASSWORD:\s*["']?\$\{\{\s*secrets\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}/.test(text);
}

export type RowActivation = "active" | "prepared" | "publishing";

/** What a password that is in place on GitHub is called while the published reader is in this state: «in use» only when the reader really asks for it. */
export function rowActivation(row: Pick<ReaderPasswordRow, "state">, publication: ReaderPublication): RowActivation | null {
  if (row.state !== "active") return null;
  if (publication === "protecting") return "active";
  return publication === "publishing" ? "publishing" : "prepared";
}

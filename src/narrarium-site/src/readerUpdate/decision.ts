import type { PagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";
import { planReaderWorkflow } from "@/readerAccess/workflowPlan";
import { READER_DIR, type ReaderFolderPlan } from "@/readerUpdate/folderPlan";

/**
 * Whether the reader of a book repository needs updating, from what was read of it. Nothing here reads or writes: the inputs are what the working copy
 * has (the text of the workflow, the reader/ folder compared with the template) and the state of this device (online, with a credential, with work of its
 * own still to publish).
 *
 * «Old» means the workflow does not read the list of passwords, or a file of the reader is not the one of the template. A book published with a password
 * and an old reader exposes its EPUB and the titles of its chapters in clear, so that case is told apart (`exposure`).
 */
export interface ReaderUpdateInputs {
  storage: "github" | "local-only";
  /** A working copy of the working branch exists on this device. */
  workingCopy: boolean;
  /** The text of the workflow, `null` when the repository has none, `undefined` when it could not be read. */
  workflowText: string | null | undefined;
  /** The reader/ folder against the template, `null` when it could not be read. */
  folder: ReaderFolderPlan | null;
  branch: string;
  online: boolean;
  credential: boolean;
  /** The working copy has changes of its own that are not on GitHub yet. */
  localChanges: boolean;
  /** What GitHub says, when it was read: whether Pages is on and whether a password is set. */
  remote?: { pagesOn: boolean | null; passwordsSet: boolean | null };
}

export type ReaderExposure =
  /** Published with a password and an old reader: the EPUB and the titles of the chapters are in clear. */
  | "password-old-reader"
  /** An old reader that is public anyway. */
  | "old-reader"
  /** Pages is off: nothing is published now. */
  | "not-published";

export type ReaderDelivery =
  /** Committed and published at once. */
  | "now"
  /** Committed on this device; it publishes at the next sync. */
  | "no-credential" | "offline" | "local-changes";

export type ReaderUpdateDecision =
  | { kind: "local-only" }
  | { kind: "no-working-copy" }
  | { kind: "unreadable" }
  | { kind: "not-published" }
  | { kind: "elsewhere"; readerDir: string }
  | { kind: "current"; version: string | null }
  | {
      kind: "update";
      workflow: PagesWorkflowUpgrade;
      /** The workflow has to change (it is missing, written before the key slots, or edited). */
      workflowChanges: boolean;
      /** The workflow has edits that the update would drop: it needs the owner's explicit «replace my edits». */
      customized: boolean;
      folder: ReaderFolderPlan;
      exposure: ReaderExposure;
      delivery: ReaderDelivery;
      /** The branch is one the workflow publishes from; on any other the update does not reach the site until it is merged. */
      publishesFromBranch: boolean;
    };

export const PUBLISHING_BRANCHES: readonly string[] = ["main", "master"];

export function deliveryOf(input: Pick<ReaderUpdateInputs, "credential" | "online" | "localChanges">): ReaderDelivery {
  if (!input.credential) return "no-credential";
  if (!input.online) return "offline";
  if (input.localChanges) return "local-changes";
  return "now";
}

export function decideReaderUpdate(input: ReaderUpdateInputs): ReaderUpdateDecision {
  if (input.storage === "local-only") return { kind: "local-only" };
  if (!input.workingCopy) return { kind: "no-working-copy" };
  if (input.workflowText === undefined || input.folder === null) return { kind: "unreadable" };
  const workflow = planReaderWorkflow(input.workflowText);
  if (workflow.settings.readerDir !== READER_DIR && workflow.status !== "missing") return { kind: "elsewhere", readerDir: workflow.settings.readerDir };
  if (workflow.status === "missing" && !input.folder.present) return { kind: "not-published" };
  const workflowChanges = workflow.status !== "current";
  if (!workflowChanges && input.folder.writes.length === 0 && input.folder.deletes.length === 0) return { kind: "current", version: input.folder.version };
  const passwordSet = workflow.settings.legacyPasswordSecret !== undefined || input.remote?.passwordsSet === true;
  const exposure: ReaderExposure = input.remote?.pagesOn === false ? "not-published" : passwordSet ? "password-old-reader" : "old-reader";
  return {
    kind: "update",
    workflow,
    workflowChanges,
    customized: workflow.status === "customized",
    folder: input.folder,
    exposure,
    delivery: deliveryOf(input),
    publishesFromBranch: PUBLISHING_BRANCHES.includes(input.branch),
  };
}

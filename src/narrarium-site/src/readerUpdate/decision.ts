import type { PagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";
import { planReaderWorkflow } from "@/readerAccess/workflowPlan";
import { READER_DIR, type ReaderFolderPlan } from "@/readerUpdate/folderPlan";
import type { PublishingBranchRead } from "@/readerUpdate/publishingBranch";

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
  /** The paths of the workflow and of reader/ that this device has changed and GitHub does not have yet (in local commits not pushed, or not committed). */
  unpublished?: readonly string[];
  /**
   * What GitHub says, when it was read: whether Pages is on, whether a password is set, and the text of the workflow on the working branch (`null`: it has none;
   * absent: it could not be read, or the working branch is not the one that was read). The reader is current only when GitHub has it too.
   */
  remote?: { pagesOn: boolean | null; passwordsSet: boolean | null; workflowText?: string | null };
  /**
   * The repository's default branch: the one the Pages workflow runs from, so the one the published reader is made from. `undefined` when it is not known
   * (nothing was read from GitHub): `main` and `master` are then taken for it.
   */
  publishingBranch?: string;
  /**
   * What the publishing branch has, when it is not the branch the author works on: its working copy on this device or GitHub's own copy, planned like the
   * working branch. `undefined`: not read (the working branch is the publishing one, or GitHub could not be asked: offline, no credential); `"unreadable"`:
   * GitHub was asked and did not give it.
   */
  publishing?: PublishingBranchRead | "unreadable";
}

export type ReaderExposure =
  /** Published with a password and an old reader: the EPUB and the titles of the chapters are in clear. */
  | "password-old-reader"
  /** The published reader (the publishing branch) is current; only the branch the author works on has an old copy of it. */
  | "branch-only"
  /**
   * The reader works and is current; only its workflow is version 2, which hands the build step every secret of the repository as JSON: GitHub can hold it
   * at «Action required» until someone with write access approves it. Not an exposure of the book, so it is told apart from the old reader's.
   */
  | "workflow-v2"
  /** An old reader that is public anyway. */
  | "old-reader"
  /** Pages is off: nothing is published now. */
  | "not-published";

export type ReaderDelivery =
  /** Committed and published at once. */
  | "now"
  /** Committed on this device; it publishes at the next sync. */
  | "no-credential" | "offline" | "local-changes";

/** What the update changes on a branch that is not the one the author works on: the publishing branch. */
export interface UpdateTarget {
  branch: string;
  source: PublishingBranchRead["source"];
  headSha: string | null;
  workflow: PagesWorkflowUpgrade;
  workflowChanges: boolean;
  customized: boolean;
  folder: ReaderFolderPlan;
  workflowHash: string | null;
  /** `now`: it can be committed on GitHub at once. Otherwise it waits (it is only on this device, not yet on the publishing branch). */
  delivery: ReaderDelivery;
}

/**
 * What the publishing branch has, as the cards tell it («main: old workflow; this branch: updated»):
 *  - `current` / `old`: read, and the reader there is up to date or not;
 *  - `not-published`: the branch has no reader and no workflow;
 *  - `unreadable`: GitHub was asked and did not answer;
 *  - `unknown`: GitHub could not be asked (offline, no credential): it is not claimed either way.
 */
export type PublishingState = "current" | "old" | "not-published" | "unreadable" | "unknown";

export interface PublishingInfo { branch: string; state: PublishingState }

export type ReaderUpdateDecision =
  | { kind: "local-only" }
  | { kind: "no-working-copy" }
  | { kind: "unreadable" }
  | { kind: "not-published" }
  | { kind: "elsewhere"; readerDir: string }
  | {
      kind: "current";
      publishing?: PublishingInfo;
      version: string | null;
      /** `checked`: GitHub's workflow was read and is the current one. `unchecked`: it could not be read, so this says what this device has. */
      remote: "checked" | "unchecked";
    }
  /** The reader is current on this device and GitHub does not have it (yet): never «up to date» while the published side is old. */
  | {
      kind: "on-device";
      publishing?: PublishingInfo;
      version: string | null;
      reason: "local-commits" | "remote-differs";
      /** What the workflow on GitHub is: the current one, `previous` (version 2: it reads the passwords, and may be held for approval), an old one, none, or not read. */
      remoteWorkflow: "current" | "previous" | "old" | "missing" | "unknown";
      exposure: ReaderExposure | null;
      delivery: ReaderDelivery;
      unpublished: string[];
      publishesFromBranch: boolean;
    }
  | {
      kind: "update";
      /** The branch the author works on has to change (it is old). `false`: only the publishing branch is old. */
      currentNeeded: boolean;
      /** The publishing branch (the repository's default branch) when it is not the working branch, and what it has. */
      publishing?: PublishingInfo;
      /** What the update does on the publishing branch; absent when the working branch is the publishing one, or when it has nothing to change. */
      publishingTarget?: UpdateTarget;
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

/** The names that are taken for the publishing branch only while the repository's default branch is not known. */
export const PUBLISHING_BRANCHES: readonly string[] = ["main", "master"];

/** Whether the branch is the one the workflow publishes from: the repository's default branch, or `main`/`master` while that is not known. */
export function publishesFrom(input: Pick<ReaderUpdateInputs, "branch" | "publishingBranch">): boolean {
  return input.publishingBranch !== undefined ? input.publishingBranch === input.branch : PUBLISHING_BRANCHES.includes(input.branch);
}

interface PublishingPlan { info: PublishingInfo | null; target: UpdateTarget | null }

/** The publishing branch's side of the decision: nothing for a book that works on it, otherwise what it has and what the update would change there. */
function planPublishing(input: ReaderUpdateInputs): PublishingPlan {
  const branch = input.publishingBranch;
  if (branch === undefined || branch === input.branch) return { info: null, target: null };
  const info = (state: PublishingState): PublishingPlan => ({ info: { branch, state }, target: null });
  if (input.publishing === undefined) return info("unknown");
  if (input.publishing === "unreadable") return info("unreadable");
  const read = input.publishing;
  const workflow = planReaderWorkflow(read.workflowText);
  if (workflow.settings.readerDir !== READER_DIR && workflow.status !== "missing") return info("unknown");
  if (workflow.status === "missing" && !read.folder.present) return info("not-published");
  const workflowChanges = workflow.status !== "current";
  if (!workflowChanges && read.folder.writes.length === 0 && read.folder.deletes.length === 0) return info("current");
  return {
    info: { branch, state: "old" },
    target: {
      branch, source: read.source, headSha: read.headSha, workflow, workflowChanges, customized: workflow.status === "customized", folder: read.folder, workflowHash: read.workflowHash,
      delivery: deliveryOf({ credential: input.credential, online: input.online, localChanges: false }),
    },
  };
}

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
  const passwordSet = workflow.settings.legacyPasswordSecret !== undefined || input.remote?.passwordsSet === true;
  const publishing = planPublishing(input);
  const currentNeeded = workflowChanges || input.folder.writes.length > 0 || input.folder.deletes.length > 0;
  // Which side of the reader is old decides what is exposed: the published one is the publishing branch's. When the working branch is not it and it is
  // current, only this branch's copy is old; when it cannot be known, the published reader is taken to be as old as this one.
  const publishedOld = publishing.info === null ? true : publishing.info.state !== "current" && publishing.info.state !== "not-published";
  // Only the workflow is old, and it is version 2: the reader works and the book is protected as it was; GitHub may hold the workflow for approval.
  const noFolderChange = (folder: ReaderFolderPlan) => folder.writes.length === 0 && folder.deletes.length === 0;
  const onlyWorkflowV2 = workflow.fromVersion === 2 && noFolderChange(input.folder) && (!publishing.target || (publishing.target.workflow.fromVersion === 2 && noFolderChange(publishing.target.folder)));
  const exposureOf = (): ReaderExposure => input.remote?.pagesOn === false || publishing.info?.state === "not-published" ? "not-published"
    : !publishedOld ? "branch-only"
      : onlyWorkflowV2 ? "workflow-v2"
        : passwordSet ? "password-old-reader" : "old-reader";
  if (!currentNeeded && !publishing.target) {
    const remoteText = input.remote?.workflowText;
    const remotePlan = remoteText === undefined ? null : planReaderWorkflow(remoteText);
    const remoteWorkflow: "current" | "previous" | "old" | "missing" | "unknown" = remotePlan === null ? "unknown" : remotePlan.status === "current" ? "current" : remotePlan.status === "missing" ? "missing" : remotePlan.status === "generated" && remotePlan.fromVersion === 2 ? "previous" : "old";
    const unpublished = [...(input.unpublished ?? [])];
    if (remoteWorkflow === "old" || remoteWorkflow === "previous" || remoteWorkflow === "missing" || unpublished.length > 0) {
      const behind = remoteWorkflow === "old" || remoteWorkflow === "previous" || remoteWorkflow === "missing";
      return {
        kind: "on-device",
        ...(publishing.info ? { publishing: publishing.info } : {}),
        version: input.folder.version,
        reason: behind ? "remote-differs" : "local-commits",
        remoteWorkflow,
        exposure: !behind ? null : input.remote?.pagesOn === false ? "not-published" : remoteWorkflow === "previous" ? "workflow-v2" : passwordSet ? "password-old-reader" : "old-reader",
        delivery: deliveryOf(input),
        unpublished,
        publishesFromBranch: publishesFrom(input),
      };
    }
    return { kind: "current", ...(publishing.info ? { publishing: publishing.info } : {}), version: input.folder.version, remote: remotePlan === null ? "unchecked" : "checked" };
  }
  const exposure = exposureOf();
  return {
    kind: "update",
    currentNeeded,
    ...(publishing.info ? { publishing: publishing.info } : {}),
    ...(publishing.target ? { publishingTarget: publishing.target } : {}),
    workflow,
    workflowChanges,
    customized: workflow.status === "customized",
    folder: input.folder,
    exposure,
    delivery: deliveryOf(input),
    publishesFromBranch: publishesFrom(input),
  };
}

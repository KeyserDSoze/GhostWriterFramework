import { RevisionCampaignError, ServerRequestError, isRevisionCampaignErrorCode, serverSupportsOutlineApply, type RevisionCampaignErrorCode, type ServerInfo } from "narrarium-engine";
import i18n from "@/i18n";
import { REVIEW_SERVER_VERSION, REVIEW_TARGETS_SERVER_VERSION } from "@/autopilot/reviewPolicy";

/** The release of the personal server that applies the Synopsis to a book: the routes of the campaigns (`POST` and `DELETE …/autopilot/campaign`). */
export const OUTLINE_APPLY_SERVER_VERSION = "0.1.19";

/** Whether the personal server announces that it applies the Synopsis to a book. An older one answers 404 to the routes of the campaigns. */
export function serverHasOutlineApply(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverSupportsOutlineApply(info);
}

/** The personal server that runs the book predates the campaigns: nothing is sent to it, and the author is told to update it. */
export class AutopilotOutlineApplyUnsupportedError extends Error {
  constructor() {
    super(i18n.t("autopilot.campaign.oldServer", { version: OUTLINE_APPLY_SERVER_VERSION }));
    this.name = "AutopilotOutlineApplyUnsupportedError";
  }
}

/** The personal server that runs the book predates the review of a finished book: nothing is sent to it, and the author is told to update it. */
export class AutopilotReviewUnsupportedError extends Error {
  constructor() {
    super(i18n.t("autopilot.reviewBook.oldServer", { version: REVIEW_SERVER_VERSION }));
    this.name = "AutopilotReviewUnsupportedError";
  }
}

/** The personal server that runs the book reviews it again but predates the targets for the readers: it would drop them, so nothing is sent and the author is told to update it. */
export class AutopilotReviewTargetsUnsupportedError extends Error {
  constructor() {
    super(i18n.t("autopilot.reviewBook.oldServerTargets", { version: REVIEW_TARGETS_SERVER_VERSION }));
    this.name = "AutopilotReviewTargetsUnsupportedError";
  }
}

/**
 * The engine refused the campaign, in this browser or on the personal server: its code (`RevisionCampaignError`) says why. The runtime throws it for both, so
 * that a refusal is told in the words of the campaigns (a `not_changed` of the frozen chapters says something else).
 */
export class AutopilotCampaignRefusedError extends Error {
  constructor(readonly code: RevisionCampaignErrorCode, detail: string) {
    super(detail);
    this.name = "AutopilotCampaignRefusedError";
  }
}

/** The refusal of a campaign as the runtime throws it: the engine's error here, or the server's answer with one of its codes. Anything else is left as it is. */
export function campaignRefusal(error: unknown): unknown {
  if (error instanceof RevisionCampaignError) return new AutopilotCampaignRefusedError(error.code, error.message);
  if (error instanceof ServerRequestError && isRevisionCampaignErrorCode(error.code) && (error.status === 400 || error.status === 409)) return new AutopilotCampaignRefusedError(error.code, error.message);
  return error;
}

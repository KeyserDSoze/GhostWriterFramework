import { AutopilotDesignError, ServerRequestError } from "narrarium-engine";
import i18n from "@/i18n";
import { DESIGN_REVIEW_SERVER_VERSION } from "@/outline/designReviewModel";

/** The codes with which the engine refuses a choice of a pitch, a decision about a finding or a review of the design on request (`AutopilotDesignError`). */
export const DESIGN_REVIEW_ERROR_CODES = ["invalid_request", "no_pitches", "unknown_pitch", "pitch_locked", "design_active", "design_no_chapters", "no_findings", "unknown_finding", "not_fixable"] as const;
export type DesignReviewErrorCode = (typeof DESIGN_REVIEW_ERROR_CODES)[number];

export function isDesignReviewErrorCode(code: unknown): code is DesignReviewErrorCode {
  return typeof code === "string" && (DESIGN_REVIEW_ERROR_CODES as readonly string[]).includes(code);
}

/** The personal server that runs the book predates the reviews of a design: nothing is sent to it, and the author is told to update it. */
export class AutopilotDesignReviewUnsupportedError extends Error {
  constructor() {
    super(i18n.t("designReview.oldServer", { version: DESIGN_REVIEW_SERVER_VERSION }));
    this.name = "AutopilotDesignReviewUnsupportedError";
  }
}

/** The engine refused what the author decided, in this browser or on the personal server: its code says why, and the runtime throws one error for both. */
export class AutopilotDesignRefusedError extends Error {
  constructor(readonly code: DesignReviewErrorCode, detail: string) {
    super(detail);
    this.name = "AutopilotDesignRefusedError";
  }
}

/** The refusal of a choice or a decision as the runtime throws it: the engine's error here, or the server's answer with one of its codes. Anything else is left as it is. */
export function designRefusal(error: unknown): unknown {
  if (error instanceof AutopilotDesignError && isDesignReviewErrorCode(error.code)) return new AutopilotDesignRefusedError(error.code, error.message);
  if (error instanceof ServerRequestError && isDesignReviewErrorCode(error.code) && (error.status === 400 || error.status === 409)) return new AutopilotDesignRefusedError(error.code, error.message);
  return error;
}

/** What a refusal says to the author, in her language; the engine's own words when a code has none. */
export function designRefusalText(error: AutopilotDesignRefusedError): string {
  return i18n.t(`designReview.errors.${error.code}`, { defaultValue: error.message });
}

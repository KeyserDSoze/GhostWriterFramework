import { isFrozenChapterErrorCode, serverSupportsFrozenChapters, type FrozenChapterErrorCode, type ServerInfo } from "narrarium-engine";
import i18n from "@/i18n";

/** The release of the personal server that has the frozen chapters: their three routes, and `frozenEdits` among the settings a run reads again. */
export const FROZEN_SERVER_VERSION = "0.1.9";

/** Whether the personal server announces the frozen chapters. An older one answers 404 to their routes and does not know `frozenEdits`. */
export function serverHasFrozenChapters(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverSupportsFrozenChapters(info);
}

/** The personal server that runs the book predates the frozen chapters: nothing is sent to it, and the author is told to update it. */
export class AutopilotFrozenUnsupportedError extends Error {
  constructor() {
    super(i18n.t("autopilot.frozen.oldServer", { version: FROZEN_SERVER_VERSION }));
    this.name = "AutopilotFrozenUnsupportedError";
  }
}

/**
 * Why a decision about a frozen chapter was refused, when it was: the code of the engine's `FrozenChapterError` in this browser, the same code
 * in the answer of the personal server (`ServerRequestError`). `null` for every other failure. Never throws.
 */
export function frozenErrorCode(error: unknown): FrozenChapterErrorCode | null {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return isFrozenChapterErrorCode(code) ? code : null;
}

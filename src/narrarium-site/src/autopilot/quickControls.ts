import { serverSupportsAutopilotControls, type AutopilotPauseMode, type AutopilotPublishMode, type AutopilotRunLimits, type ServerInfo } from "narrarium-engine";
import i18n from "@/i18n";

/** The release of the personal server that introduced the quick controls (pause at the end of the chapter, the limits of one run, the options that change during a run). */
export const QUICK_CONTROLS_SERVER_VERSION = "0.1.5";

/** How a client asks a run to pause (`AutopilotPauseMode`), or takes back a pause that waits (`cancel`). */
export type PauseCommand = AutopilotPauseMode | "cancel";

/** What the author can ask for the autopilot of one run: one step, or one chapter, and then a pause. */
export type RunOneKind = "step" | "chapter";

/** Where the book is published, in the order the menu lists them. */
export const PUBLISH_CHOICES: readonly AutopilotPublishMode[] = ["off", "chapter", "step"];

/** Whether the personal server announces that it implements the quick controls. A server that does not ignores `limits` and takes `after-chapter` and `cancel` for `after-step`. */
export function serverHasQuickControls(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverSupportsAutopilotControls(info);
}

/** Whether a start asks for a real limit: the engine takes only a whole number above zero for one, and anything else for none. */
export function hasRunLimit(limits: AutopilotRunLimits | null | undefined): boolean {
  const valid = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  return valid(limits?.steps) || valid(limits?.chapters);
}

/**
 * The personal server does not know the quick controls: a command it would read as something else (a limit it would ignore, a
 * `cancel` it would take for a pause) is not sent, and the author is told to update the server.
 */
export class AutopilotControlsUnsupportedError extends Error {
  constructor() {
    super(i18n.t("autopilot.errors.controlsUnsupported", { version: QUICK_CONTROLS_SERVER_VERSION }));
    this.name = "AutopilotControlsUnsupportedError";
  }
}

import type { TFunction } from "i18next";
import { DEFAULT_MAX_INPUT_TOKENS, type AiLeftOutReason, type AiUnusableWhy } from "narrarium-engine";
import { formatCount } from "@/autopilot/format";

/** Why a candidate of a route was not asked, as the engine's step or the record of a call says it. */
export interface LeftOutInfo {
  reason?: AiLeftOutReason;
  why?: AiUnusableWhy;
  /** The tokens the prompt needs, and what the model's window leaves for it, when the candidate was left out for its window. */
  promptTokens?: number;
  windowTokens?: number;
  /** The model's window is not set: the default was assumed. */
  windowDefault?: boolean;
}

const WORDS: ReadonlySet<string> = new Set(["no-tool-calls", "boundary", "budget", "not-acknowledged", "out-of-time"]);
const UNUSABLE: ReadonlySet<string> = new Set(["integration-missing", "provider-unsupported", "model-missing", "task-not-allowed"]);

/** The reason a candidate was left out, in the words of the page: what the engine knows of it, and the figures when it says them. */
export function leftOutReason(t: TFunction, info: LeftOutInfo): string {
  if (info.reason === "unusable") return t(`autopilot.route.reason.${info.why && UNUSABLE.has(info.why) ? info.why : "model-missing"}`);
  if (info.reason === "context-window") {
    return typeof info.promptTokens === "number" && typeof info.windowTokens === "number"
      ? t(info.windowDefault ? "autopilot.route.reason.context-window-default" : "autopilot.route.reason.context-window", { prompt: formatCount(info.promptTokens), window: formatCount(info.windowTokens), assumed: formatCount(DEFAULT_MAX_INPUT_TOKENS) })
      : t("autopilot.route.reason.context-window-unknown");
  }
  return t(`autopilot.route.reason.${info.reason && WORDS.has(info.reason) ? info.reason : "unknown"}`);
}

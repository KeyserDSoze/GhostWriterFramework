import { isAutopilotRuleErrorCode, serverSupportsAutopilotRules, type AutopilotRuleErrorCode, type ServerInfo } from "narrarium-engine";
import i18n from "@/i18n";

/** The release of the personal server that can change and remove the permanent rules of the autopilot (`PUT` and `DELETE …/autopilot/rules/:index`). */
export const RULES_SERVER_VERSION = "0.1.6";

/** Whether the personal server announces that it changes and removes the permanent rules. An older one answers 404 to those calls. */
export function serverEditsRules(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverSupportsAutopilotRules(info);
}

/** The personal server that runs the book predates the editing of the rules: nothing is sent to it, and the author is told to update it. */
export class AutopilotRulesUnsupportedError extends Error {
  constructor() {
    super(i18n.t("autopilot.config.rules.oldServer", { version: RULES_SERVER_VERSION }));
    this.name = "AutopilotRulesUnsupportedError";
  }
}

/**
 * Why a rule was refused, when it was: the code of the engine's `AutopilotRuleError` in this browser, the same code in the answer of the
 * personal server (`ServerRequestError`). `null` for every other failure. Never throws.
 */
export function ruleErrorCode(error: unknown): AutopilotRuleErrorCode | null {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return isAutopilotRuleErrorCode(code) ? code : null;
}

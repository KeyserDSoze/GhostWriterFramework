import { AiToolsRequiredError } from "narrarium-engine";
import type { TFunction } from "i18next";
import type { AssistantAction } from "@/assistant/store";

export interface AiFailureReply {
  /** The text of the assistant's message, in Markdown. */
  text: string;
  /** What the message offers to do about it. */
  action?: AssistantAction;
}

/**
 * What the Copilot tells the author when an AI call fails for a reason that is theirs to fix, in the words of the autopilot's error panel (its texts are loaded with the Copilot): with
 * «Tools only» on, no model of the route can call a function, so a structured request has nowhere to go and nothing was sent. The two ways out are in the text, and the AI Router,
 * where the switch is, one click away. Any other failure is the sentence of the client, which already says what ran out and where it is changed: `null`, the message is shown as it is.
 */
export function describeAiFailure(error: unknown, t: TFunction): AiFailureReply | null {
  if (!(error instanceof AiToolsRequiredError)) return null;
  return {
    text: `**${t("autopilot.failure.kind.config.title")}**\n\n${t("autopilot.failure.kind.config.explain")}\n\n> ${error.message}`,
    action: { kind: "navigate", to: "/app/settings/ai-router#tools-only", label: t("autopilot.failure.config.openRouter") },
  };
}

import { AiProviderError, AiToolsRequiredError } from "narrarium-engine";
import type { TFunction } from "i18next";
import { providerMarkdown } from "@/autopilot/providerWords";
import { CompletionFallbackError } from "@/assistant/completionFallback";
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
 * where the switch is, one click away. A provider that refused the request is told in its own words, as labelled fields (the HTTP status, the message, the type, the parameter and the code of
 * its error) above the sentence of the client, which keeps everything the client said; with several candidates, each one's answer under its name. Any other failure is the sentence of the
 * client, which already says what ran out and where it is changed: `null`, the message is shown as it is.
 */
export function describeAiFailure(error: unknown, t: TFunction): AiFailureReply | null {
  if (error instanceof AiToolsRequiredError) {
    return {
      text: `**${t("autopilot.failure.kind.config.title")}**\n\n${t("autopilot.failure.kind.config.explain")}\n\n> ${error.message}`,
      action: { kind: "navigate", to: "/app/settings/ai-router#tools-only", label: t("autopilot.failure.config.openRouter") },
    };
  }
  const say = t as unknown as Parameters<typeof providerMarkdown>[0];
  if (error instanceof CompletionFallbackError) {
    const blocks = error.answers.flatMap((answer) => (answer.body ? [`**${answer.label}**\n${providerMarkdown(say, answer.body, "autopilot.failure.provider", { status: true })}`] : []));
    return blocks.length ? { text: `**${t("autopilot.failure.provider.title")}**\n\n${blocks.join("\n\n")}\n\n> ${error.message}` } : null;
  }
  if (error instanceof AiProviderError && error.body) {
    return { text: `**${t("autopilot.failure.provider.title")}**\n\n${providerMarkdown(say, error.body, "autopilot.failure.provider", { status: true })}\n\n> ${error.message}` };
  }
  return null;
}

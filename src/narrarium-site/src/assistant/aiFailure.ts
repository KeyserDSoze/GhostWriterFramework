import { AiProviderError, AiToolsRequiredError } from "narrarium-engine";
import type { TFunction } from "i18next";
import { providerMarkdown } from "@/autopilot/providerWords";
import { CompletionFallbackError } from "@/assistant/completionFallback";
import type { AssistantAction } from "@/assistant/store";
import { ROUTING_LIMIT_BOUNDS, limitKeyOf, raiseFor, routingBudgetOfError } from "@/assistant/routingLimitRaise";
import { formatWhole } from "@/autopilot/format";
import { formatMoney } from "@/costs/money";
import type { AppSettings } from "@/types/settings";

export interface AiFailureReply {
  /** The text of the assistant's message, in Markdown. */
  text: string;
  /** What the message offers to do about it. */
  action?: AssistantAction;
}

type LimitSettings = Pick<AppSettings, "routingExecution" | "costCurrency">;

/**
 * What the Copilot tells the author when an AI call fails for a reason that is theirs to fix, in the words of the autopilot's error panel (its texts are loaded with the Copilot): with
 * «Tools only» on, no model of the route can call a function, so a structured request has nowhere to go and nothing was sent. The two ways out are in the text, and the AI Router,
 * where the switch is, one click away. A provider that refused the request is told in its own words, as labelled fields (the HTTP status, the message, the type, the parameter and the code of
 * its error) above the sentence of the client, which keeps everything the client said; with several candidates, each one's answer under its name. When a routing limit left the
 * fallbacks of the call out, the reply says which limit, what they needed and the limit, and offers to raise it and send the request again (`routingLimitPart`). Any other failure is
 * the sentence of the client, which already says what ran out and where it is changed: `null`, the message is shown as it is.
 */
export function describeAiFailure(error: unknown, t: TFunction, settings?: LimitSettings): AiFailureReply | null {
  const refusal = routingLimitFailure(error, t, settings);
  if (refusal) return refusal;
  const failure = describeProviderFailure(error, t);
  const limit = routingLimitPart(error, t, settings);
  if (!limit) return failure;
  const head = failure?.text ?? (error instanceof Error ? error.message : "");
  return { text: head ? `${head}\n\n${limit.text}` : limit.text, action: failure?.action ?? limit.action };
}

function describeProviderFailure(error: unknown, t: TFunction): AiFailureReply | null {
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

/**
 * The fallbacks a routing limit left out of a call that failed (the Copilot's router or the engine's client, the same fields, `budget`): which limit, what they would have needed
 * together and what the limit allows, where it is changed, and the one-click raise that lets them be tried when the request is sent again (`raise-routing-limit`), when the settings
 * accept a limit that holds them. `null` when no limit left anything out.
 */
export function routingLimitPart(error: unknown, t: TFunction, settings?: LimitSettings): AiFailureReply | null {
  const budget = routingBudgetOfError(error);
  if (!budget) return null;
  const key = limitKeyOf(budget);
  const value = (amount: number) => (budget.limit === "tokens" ? formatWhole(amount) : formatMoney(amount, settings?.costCurrency || "USD"));
  const open: AssistantAction = { kind: "navigate", to: "/app/settings/ai-router#routing-options", label: t("autopilot.failure.routingLimit.open") };
  const text = `**${t("autopilot.failure.routingLimit.title")}**\n\n${t(`autopilot.failure.routingLimit.${budget.limit}`, { estimated: value(budget.estimated), allowed: value(budget.allowed), field: t(`routing.${key}`) })}`;
  const raise = settings ? raiseFor(budget, settings.routingExecution) : null;
  if (!raise) return { text: `${text}\n\n${t("autopilot.failure.routingLimit.tooHigh", { max: value(ROUTING_LIMIT_BOUNDS[key].max) })}`, action: open };
  return { text, action: { kind: "raise-routing-limit", key, from: raise.from, to: raise.to, estimated: raise.estimated } };
}

/**
 * A refusal of the routing limits themselves: a fallback of speech or images over them (`RoutingExecutionBudgetError`, with the limit and its numbers and the raise), or the
 * refusal of a call before anything was sent that an older engine reports (`AiRoutingBudgetError`: a personal server not updated yet), with its words and the way to the limits.
 * `null` for any other failure.
 */
export function routingLimitFailure(error: unknown, t: TFunction, settings?: LimitSettings): AiFailureReply | null {
  const name = error instanceof Error ? error.name : "";
  if (name !== "RoutingExecutionBudgetError" && name !== "AiRoutingBudgetError") return null;
  const part = name === "RoutingExecutionBudgetError" ? routingLimitPart(error, t, settings) : null;
  if (part) return part;
  const open: AssistantAction = { kind: "navigate", to: "/app/settings/ai-router#routing-options", label: t("autopilot.failure.routingLimit.open") };
  return { text: `**${t("autopilot.failure.routingLimit.refusedTitle")}**\n\n${t("autopilot.failure.routingLimit.unknown")}\n\n> ${(error as Error).message}`, action: open };
}

import { ATTACHMENT_LIMITS, constrainAttachmentsToTokenBudget } from "@/assistant/attachments";
import { resolveTaskCandidates } from "@/assistant/router";
import type { AssistantAttachment } from "@/assistant/store";
import type { AppSettings } from "@/types/settings";

/** The tokens the attachments of a request may take: a quarter of the window of the Copilot's first model, at most `ATTACHMENT_LIMITS.estimatedTokens`. */
export function selectedAttachmentTokenBudget(settings: AppSettings): number {
  const candidate = resolveTaskCandidates(settings, "copilot").find((entry) => entry.integration && entry.model);
  const model = candidate?.integration?.chatModels?.find((entry) => entry.name === candidate.model);
  if (!model?.maxInputTokens) return ATTACHMENT_LIMITS.estimatedTokens;
  return Math.max(0, Math.min(ATTACHMENT_LIMITS.estimatedTokens, Math.floor(model.maxInputTokens * 0.25)));
}

/** The most of the text of the attached files a request carries (`attachment_content`); a text set apart as material is not counted in it. */
export const ATTACHMENT_TEXT_CHARS = 24_000;

export function attachmentsText(attachments: readonly AssistantAttachment[]): string {
  return attachments.filter((attachment) => attachment.kind === "text" && !attachment.material).map((attachment) => {
    const status = attachment.truncated ? `\n[TRUNCATED: ${attachment.truncationReason ?? "safe extraction limit reached"}]` : "";
    return `ATTACHMENT: ${attachment.name}${status}\n${attachment.textContent || "[No text excerpt included]"}`;
  }).join("\n\n---\n\n");
}

/** The texts the author set apart as material («Use this text as material»), in the order they were added. */
export function attachedMaterial(attachments: readonly AssistantAttachment[]): string {
  return attachments.filter((attachment) => attachment.material && attachment.kind === "text" && attachment.textContent).map((attachment) => attachment.textContent as string).join("\n\n");
}

/**
 * How much of the text of the attached files a request carries, when it is less than all of it (the share of the window the attachments may take, then `ATTACHMENT_TEXT_CHARS`): what
 * the chat tells the author, with the way to give a long text whole (as material). `null` when every character is sent.
 */
export function attachmentTextCut(settings: AppSettings, rawAttachments: readonly AssistantAttachment[]): { sent: number; total: number } | null {
  const files = rawAttachments.filter((attachment) => attachment.kind === "text" && !attachment.material);
  const total = files.reduce((sum, attachment) => sum + (attachment.textContent?.length ?? 0), 0);
  if (!total) return null;
  const kept = constrainAttachmentsToTokenBudget(rawAttachments.filter((attachment) => !attachment.material), selectedAttachmentTokenBudget(settings)).filter((attachment) => attachment.kind === "text");
  const keptChars = kept.reduce((sum, attachment) => sum + (attachment.textContent?.length ?? 0), 0);
  const joined = attachmentsText(kept).length;
  const sent = joined > ATTACHMENT_TEXT_CHARS ? Math.floor(keptChars * ATTACHMENT_TEXT_CHARS / joined) : keptChars;
  return sent < total ? { sent, total } : null;
}


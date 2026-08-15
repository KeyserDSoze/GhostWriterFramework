import type { AssistantAttachment } from "@/assistant/store";
import type { EntityKind } from "@/narrarium/canon";

export const ATTACHMENT_IMPORT_TARGETS = ["paragraph", "chapter", "note", "character", "location", "faction", "item", "secret", "timeline", "script", "draft"] as const;
export type AttachmentImportTarget = (typeof ATTACHMENT_IMPORT_TARGETS)[number];

export type AttachmentImportRoute =
  | { handler: "paragraph" | "chapter" | "note" | "script" | "draft" }
  | { handler: "entity"; entityKind: EntityKind };

export function attachmentImportRoute(target: AttachmentImportTarget): AttachmentImportRoute {
  if (target === "character" || target === "location" || target === "faction" || target === "item" || target === "secret") return { handler: "entity", entityKind: target };
  if (target === "timeline") return { handler: "entity", entityKind: "timeline-event" };
  return { handler: target };
}

export function validateImportAttachments(attachments: AssistantAttachment[]): string | null {
  if (!attachments.length) return "Attach at least one file first.";
  for (const attachment of attachments) {
    if (!attachment.id || !attachment.name || !attachment.mimeType || attachment.sizeBytes < 0) return `Attachment metadata is malformed for ${attachment.name || "unnamed file"}.`;
    if (attachment.kind === "text" && !attachment.textContent?.trim()) return `Attachment ${attachment.name} has no readable text.`;
    if (attachment.kind === "image" && !attachment.imageDataUrl?.startsWith("data:image/")) return `Attachment ${attachment.name} has invalid image data.`;
  }
  return null;
}

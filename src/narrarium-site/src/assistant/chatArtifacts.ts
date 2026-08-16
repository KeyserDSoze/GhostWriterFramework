import { marked } from "marked";
import type { AssistantArchivedAction, AssistantArchivedAttachment, AssistantAttachment, AssistantMessage, AssistantSession } from "@/assistant/store";
import { markdownToSpeechText } from "@/assistant/speech";

const ALLOWED_TAGS = new Set([
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "strong",
  "table", "tbody", "td", "th", "thead", "tr", "ul",
]);
const DROP_WITH_CONTENT = new Set(["audio", "canvas", "embed", "form", "iframe", "img", "math", "object", "script", "style", "svg", "video"]);

function sanitizeHtml(html: string): string {
  if (typeof DOMParser === "undefined") return escapeHtml(html);
  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");
  sanitizeChildren(document.body);
  return document.body.innerHTML;
}

function sanitizeChildren(parent: Element): void {
  for (const child of [...parent.children]) {
    const tag = child.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) {
      child.remove();
      continue;
    }
    sanitizeChildren(child);
    if (!ALLOWED_TAGS.has(tag)) {
      child.replaceWith(...child.childNodes);
      continue;
    }
    const href = tag === "a" ? child.getAttribute("href") : null;
    for (const attribute of [...child.attributes]) child.removeAttribute(attribute.name);
    if (tag === "a") sanitizeLink(child, href);
  }
}

function sanitizeLink(element: Element, rawHref: string | null): void {
  if (!rawHref) return;
  const href = rawHref.replace(/[\u0000-\u0020\u007f]+/g, "").trim();
  if (!isSafeLink(href)) return;
  element.setAttribute("href", href);
  element.setAttribute("rel", "noopener noreferrer nofollow");
  if (/^https?:/i.test(href)) element.setAttribute("target", "_blank");
}

function isSafeLink(href: string): boolean {
  return /^(?:https?:|mailto:|#|\/|\.\.?(?:\/|$))/i.test(href);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderAssistantMarkdownHtml(markdown: string): string {
  return sanitizeHtml(marked.parse(markdown, { async: false }) as string);
}

export function assistantMarkdownToRichPlainText(markdown: string): string {
  if (typeof window === "undefined") return markdownToSpeechText(markdown);
  const parser = new DOMParser();
  const html = renderAssistantMarkdownHtml(markdown);
  const document = parser.parseFromString(html, "text/html");
  return document.body.textContent?.trim() ?? markdownToSpeechText(markdown);
}

function messageHeading(message: AssistantMessage): string {
  return message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "System";
}

function attachmentLine(attachment: AssistantAttachment | AssistantArchivedAttachment): string {
  return `- ${attachment.name} (${attachment.mimeType}, ${attachment.kind}, ${attachment.sizeBytes} bytes; id: ${attachment.id})`;
}

export function archivedActionDetails(action: AssistantArchivedAction): string[] {
  const lines = [
    `- Message: ${action.messageId}`,
    `  Kind: ${action.kind}`,
    `  Book: ${action.bookId ?? "n/a"}`,
    `  Tool: ${action.toolId ?? "n/a"}`,
    `  Repository: ${action.owner && action.repo ? `${action.owner}/${action.repo}` : "n/a"}`,
    `  Branch: ${action.branch ?? "n/a"}`,
    `  Source revision: ${action.sourceRevision ?? "n/a"}`,
    `  Generated: ${action.generatedAt ?? "n/a"}`,
    `  Paths: ${action.paths.length ? action.paths.join(", ") : "none"}`,
  ];
  const revisions = Object.entries(action.sourceRevisions ?? {});
  lines.push(`  Source revisions: ${revisions.length ? revisions.map(([path, revision]) => `${path}=${revision ?? "missing"}`).join(", ") : "none"}`);
  return lines;
}

export function assistantArchiveHistoryLines(session: AssistantSession): string[] {
  const archive = session.archive;
  if (!archive) return [];
  const lines = archive.actions.flatMap(archivedActionDetails);
  const rollup = archive.rollup;
  if (rollup?.actionCount) lines.push(`- Rolled actions: ${rollup.actionCount}; ${rollup.algorithm}: ${rollup.actionDigest}`);
  if (rollup?.attachmentCount) lines.push(`- Rolled attachments: ${rollup.attachmentCount}; ${rollup.algorithm}: ${rollup.attachmentDigest}`);
  return lines;
}

export function hasAssistantSessionArchiveContent(session: AssistantSession): boolean {
  const archive = session.archive;
  return Boolean((archive?.summary || session.compactSummary).trim() || archive?.actions.length || archive?.attachments.length || archive?.rollup?.actionCount || archive?.rollup?.attachmentCount);
}

export function buildAssistantSessionMarkdown(session: AssistantSession): string {
  const archive = session.archive;
  const lines = [
    `# ${session.title}`,
    "",
    `Context: ${session.contextTitle}`,
    `Updated: ${session.updatedAt}`,
    "",
    "## Export Limitations",
    "",
    session.losslessArchive?.complete === false
      ? "This human-readable export is not a backup. It omits machine-restorable data, and this legacy chat also has unavailable historical ranges. The validated JSON archive preserves all records that remain available but cannot restore missing legacy records."
      : "This human-readable export is not a backup. It omits attachment contents and image data, full action/proposal payloads, proposed file contents, undo snapshots, quarantined raw actions, cloud provider/account identity, cloud file identity, and machine-restorable schema metadata. Use the validated JSON archive for complete backup or migration.",
  ];
  if (session.losslessArchive && !session.losslessArchive.complete) lines.push("", `WARNING: Historical records are incomplete. Missing ranges: ${session.losslessArchive.missingRanges.map((range) => `${range.from}-${range.to} (${range.reason})`).join(", ")}. No export can restore those records.`);
  const archiveSummary = archive?.summary.trim() || session.compactSummary.trim();
  if (hasAssistantSessionArchiveContent(session)) {
    lines.push("", `## Archived Conversation (${archive?.messageCount ?? session.compactedMessageCount} messages)`);
    if (archiveSummary) lines.push("", archiveSummary);
    const provenance = assistantArchiveHistoryLines(session);
    if (provenance.length) lines.push("", "### Archived Audit Provenance", "", ...provenance);
    if (archive?.attachments.length) lines.push("", "### Archived Attachments", "", ...archive.attachments.map(attachmentLine));
  }
  if (session.attachments.length) lines.push("", "## Active Attachments", "", ...session.attachments.map(attachmentLine));
  for (const message of session.messages) {
    lines.push("", `## ${messageHeading(message)}`, "", message.text.trim() || "(empty)");
  }
  return lines.join("\n").trim() + "\n";
}

export async function buildAssistantSessionPdfBlob(session: AssistantSession): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 48;
  const lineHeight = 16;
  let y = margin;

  const writeBlock = (text: string, size = 11, bold = false) => {
    pdf.setFont("helvetica", bold ? "bold" : "normal");
    pdf.setFontSize(size);
    const lines = pdf.splitTextToSize(text, pageWidth - margin * 2) as string[];
    for (const line of lines) {
      if (y > pageHeight - margin) {
        pdf.addPage();
        y = margin;
      }
      pdf.text(line, margin, y);
      y += lineHeight;
    }
  };

  writeBlock(session.title, 16, true);
  y += 6;
  writeBlock(`Context: ${session.contextTitle}`);
  writeBlock(`Updated: ${new Date(session.updatedAt).toLocaleString()}`);
  y += 8;
  writeBlock("Export Limitations", 13, true);
  writeBlock("This human-readable export is not a backup. It omits attachment contents and image data, full action/proposal payloads, proposed file contents, undo snapshots, quarantined raw actions, cloud provider/account identity, cloud file identity, and machine-restorable schema metadata. Use the JSON archive for full-fidelity backup or migration.");
  const archiveSummary = session.archive?.summary.trim() || session.compactSummary.trim();
  if (hasAssistantSessionArchiveContent(session)) {
    y += 8;
    writeBlock(`Archived Conversation (${session.archive?.messageCount ?? session.compactedMessageCount} messages)`, 13, true);
    if (archiveSummary) writeBlock(assistantMarkdownToRichPlainText(archiveSummary));
    for (const line of assistantArchiveHistoryLines(session)) writeBlock(line);
    for (const attachment of session.archive?.attachments ?? []) writeBlock(attachmentLine(attachment));
  }
  if (session.attachments.length) {
    y += 8;
    writeBlock("Active Attachments", 13, true);
    for (const attachment of session.attachments) writeBlock(attachmentLine(attachment));
  }
  for (const message of session.messages) {
    y += 8;
    writeBlock(messageHeading(message), 13, true);
    writeBlock(assistantMarkdownToRichPlainText(message.text.trim() || "(empty)"));
  }

  return pdf.output("blob");
}

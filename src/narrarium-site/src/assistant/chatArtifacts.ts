import { marked } from "marked";
import type { AssistantMessage, AssistantSession } from "@/assistant/store";
import { markdownToSpeechText } from "@/assistant/speech";

function sanitizeHtml(html: string): string {
  if (typeof window === "undefined") return html;
  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");
  document.querySelectorAll("script,style,iframe,object,embed").forEach((node) => node.remove());
  document.querySelectorAll("*").forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      if ((name === "href" || name === "src") && value.startsWith("javascript:")) element.removeAttribute(attribute.name);
    });
  });
  return document.body.innerHTML;
}

export function renderAssistantMarkdownHtml(markdown: string): string {
  return sanitizeHtml(marked.parse(markdown, { async: false }) as string);
}

export function assistantMarkdownToRichPlainText(markdown: string): string {
  if (typeof window === "undefined") return markdownToSpeechText(markdown);
  const parser = new DOMParser();
  const html = renderAssistantMarkdownHtml(markdown);
  const document = parser.parseFromString(html, "text/html");
  return document.body.textContent?.trim() || markdownToSpeechText(markdown);
}

function messageHeading(message: AssistantMessage): string {
  return message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "System";
}

export function buildAssistantSessionMarkdown(session: AssistantSession): string {
  const lines = [
    `# ${session.title}`,
    "",
    `Context: ${session.contextTitle}`,
    `Updated: ${session.updatedAt}`,
  ];
  if (session.compactSummary.trim()) {
    lines.push("", "## Compaction Summary", "", session.compactSummary.trim());
  }
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
  if (session.compactSummary.trim()) {
    y += 8;
    writeBlock("Compaction Summary", 13, true);
    writeBlock(assistantMarkdownToRichPlainText(session.compactSummary));
  }
  for (const message of session.messages) {
    y += 8;
    writeBlock(messageHeading(message), 13, true);
    writeBlock(assistantMarkdownToRichPlainText(message.text.trim() || "(empty)"));
  }

  return pdf.output("blob");
}

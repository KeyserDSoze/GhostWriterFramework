import { renderSafeMarkdownHtml } from "narrarium";

/** Keep all reader-side Markdown rendering on the same safe core renderer. */
export function renderReaderMarkdown(markdown: string): string {
  return renderSafeMarkdownHtml(markdown);
}

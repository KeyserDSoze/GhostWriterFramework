import type React from "react";

export function handleTextIndent(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.currentTarget;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  const value = target.value;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const selectionEnd = value.slice(0, end).lastIndexOf("\n") + 1;
  const endBoundary = end === lineStart ? end : selectionEnd || value.length;
  const blockEnd = end > lineStart && value[end - 1] !== "\n" ? value.length === end ? end : value.indexOf("\n", end) < 0 ? value.length : value.indexOf("\n", end) : end;
  const selectedEnd = Math.max(endBoundary, blockEnd);
  const selected = value.slice(lineStart, selectedEnd);
  const lines = selected.split("\n");
  const indent = "  ";
  const nextLines = event.shiftKey
    ? lines.map((line) => line.startsWith(indent) ? line.slice(indent.length) : line.startsWith("\t") ? line.slice(1) : line.startsWith(" ") ? line.slice(1) : line)
    : lines.map((line) => indent + line);
  const next = value.slice(0, lineStart) + nextLines.join("\n") + value.slice(selectedEnd);
  event.preventDefault();
  target.value = next;
  const delta = next.length - value.length;
  target.setSelectionRange(event.shiftKey ? Math.max(lineStart, start - (value.slice(lineStart, start).startsWith(indent) ? indent.length : 1)) : start + indent.length, Math.max(lineStart, selectedEnd + delta));
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

export const COPILOT_HANDLER_IDS = [
  "search-book", "switch-branch", "import-attachments", "create-chapter", "create-paragraph", "create-entity",
  "create-script", "create-draft", "update-plot", "write-resume", "write-evaluation", "evaluate-chapter-paragraphs",
  "rewrite-paragraph", "create-note", "review-context", "summarize-context", "answer-from-context", "open-reader",
  "navigate", "read-current-page", "list-simulated-readers", "create-simulated-reader", "toggle-simulated-reader",
  "evaluate-with-readers", "summarize-reader-evaluations", "open-reader-evaluations", "generate-draft-from-feedback",
  "restore-previous-drafts", "feedback-rewrite-status", "cancel-feedback-rewrite", "run-audit", "open-audit",
  "update-audit", "delete-audit", "set-audit-finding-status", "list-branches", "show-branch-diff", "list-commits",
  "list-pull-requests", "create-pull-request", "get-book", "get-chapter", "get-paragraph", "get-character",
  "get-location", "get-faction", "get-item", "get-secret", "get-timeline-event", "get-body", "get-frontmatter",
  "delete-current-note", "delete-current-paragraph", "delete-current-entity", "delete-reader-evaluation", "deep-research",
  "create-from-research", "multi-file-edit",
] as const;

export const EXECUTABLE_COPILOT_HANDLER_IDS: ReadonlySet<string> = new Set(COPILOT_HANDLER_IDS);

export const LLM_COPILOT_TOOL_IDS: ReadonlySet<string> = new Set([
  "answer-from-context", "create-chapter", "create-entity", "create-from-research", "create-note", "create-paragraph",
  "create-script", "create-simulated-reader", "deep-research", "evaluate-chapter-paragraphs", "evaluate-with-readers",
  "import-attachments", "multi-file-edit", "review-context", "rewrite-current-paragraph", "run-audit", "summarize-context",
  "summarize-reader-evaluations", "update-audit", "update-plot", "write-evaluation", "write-resume",
]);

export function assertExecutableHandlerMap(handlers: Record<string, unknown>): void {
  const actual = Object.keys(handlers).sort();
  const declared: string[] = [...COPILOT_HANDLER_IDS].sort();
  if (new Set(declared).size !== declared.length) throw new Error("Duplicate IDs in the Copilot handler catalog.");
  if (actual.length !== declared.length || actual.some((id, index) => id !== declared[index])) {
    const missing = declared.filter((id) => !actual.includes(id));
    const orphaned = actual.filter((id) => !declared.includes(id));
    throw new Error(`Copilot handler catalog mismatch. Missing: ${missing.join(", ") || "none"}; orphaned: ${orphaned.join(", ") || "none"}.`);
  }
}

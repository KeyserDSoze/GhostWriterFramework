import type { AssistantAction } from "@/assistant/store";

const QUICK_ACTION_TOOLS: Record<string, string> = {
  fix: "rewrite-current-paragraph",
  review: "review-context",
  evaluation: "write-evaluation",
  resume: "write-resume",
  summary: "summarize-context",
  enrich: "answer-from-context",
  consistency: "answer-from-context",
  appearances: "search-book",
  reveal: "review-context",
  plot: "update-plot",
  search: "search-book",
  note: "create-note",
  diff: "show-branch-diff",
};

export function quickActionToolId(actionId: string): string | null {
  return QUICK_ACTION_TOOLS[actionId] ?? null;
}

export function policyTargetEnabled(targetId: string | null, isEnabled: (toolId: string) => boolean): boolean {
  return Boolean(targetId && isEnabled(targetId));
}

export function assistantActionToolId(action: AssistantAction): string | null {
  switch (action.kind) {
    case "apply-paragraph-rewrite":
      return "rewrite-current-paragraph";
    case "switch-book-branch":
      return "switch-branch";
    case "read-aloud":
      return "read-current-page";
    case "confirm-delete":
      if (action.target === "note") return "delete-current-note";
      if (action.target === "paragraph") return "delete-current-paragraph";
      if (action.target === "reader-evaluation") return "delete-reader-evaluation";
      return "delete-current-entity";
    case "navigate":
      if (/\/reader\/evaluations(?:[/?#]|$)/.test(action.to)) return "open-reader-evaluations";
      if (/\/reader(?:[?#]|$)/.test(action.to)) return "open-reader";
      if (/\/audit(?:[/?#]|$)/.test(action.to)) return "open-context-audit";
      return "navigate-app";
    case "apply-file-updates":
    case "undo-file-updates":
      return null;
  }
}

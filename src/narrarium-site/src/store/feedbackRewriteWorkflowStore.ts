import { create } from "zustand";
import type { FeedbackSourceMode, ParagraphFeedbackProposal, RewriteConflict, RewriteOperationManifest, RewriteOperationProgress, RewriteRollbackPolicy } from "@/narrarium/rewriteFromReaderFeedback";

export type FeedbackRewriteMode = "generate" | "restore" | "status";
export type FeedbackRewriteScope = "chapter" | "paragraph";
export type FeedbackRewritePhase =
  | "loading"
  | "configure"
  | "mandatory-warning"
  | "preparing"
  | "generating"
  | "rolling-back"
  | "paragraph-preview"
  | "chapter-progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "resume-confirmation"
  | "rollback-confirmation"
  | "rollback-conflicts";

export interface FeedbackRewriteIntent {
  mode: FeedbackRewriteMode;
  scope: FeedbackRewriteScope;
  bookId: string;
  chapterSlug: string;
  paragraphSlug?: string;
  feedbackMode?: FeedbackSourceMode;
  feedbackPath?: string;
  readerId?: string;
  readerName?: string;
}

export interface RollbackConflictPreview extends RewriteConflict {
  currentContent: string;
  beforeContent: string;
}

interface FeedbackRewriteWorkflowState {
  open: boolean;
  requestId: number;
  intent: FeedbackRewriteIntent | null;
  phase: FeedbackRewritePhase;
  staleFeedback: boolean;
  missingSummary: boolean;
  proposal: ParagraphFeedbackProposal | null;
  manifest: RewriteOperationManifest | null;
  manifestPath: string | null;
  progress: RewriteOperationProgress | null;
  error: string | null;
  conflicts: RollbackConflictPreview[];
  rollbackPolicies: Record<string, RewriteRollbackPolicy>;
  abortController: AbortController | null;
  abortable: boolean;
  openWorkflow: (intent: FeedbackRewriteIntent) => void;
  closeWorkflow: () => void;
  patch: (patch: Partial<FeedbackRewriteWorkflowState>) => void;
  cancelActive: () => boolean;
}

const initialRuntime = {
  phase: "loading" as FeedbackRewritePhase,
  staleFeedback: false,
  missingSummary: false,
  proposal: null,
  manifest: null,
  manifestPath: null,
  progress: null,
  error: null,
  conflicts: [] as RollbackConflictPreview[],
  rollbackPolicies: {} as Record<string, RewriteRollbackPolicy>,
  abortController: null,
  abortable: false,
};

export const useFeedbackRewriteWorkflowStore = create<FeedbackRewriteWorkflowState>()((set, get) => ({
  open: false,
  requestId: 0,
  intent: null,
  ...initialRuntime,
  openWorkflow: (intent) => set((state) => ({ open: true, requestId: state.requestId + 1, intent, ...initialRuntime })),
  closeWorkflow: () => {
    if (get().abortController) return;
    set({ open: false, intent: null, ...initialRuntime });
  },
  patch: (patch) => set(patch),
  cancelActive: () => {
    const controller = get().abortController;
    if (!controller || !get().abortable) return false;
    controller.abort();
    return true;
  },
}));

export function openFeedbackRewriteWorkflow(intent: FeedbackRewriteIntent): void {
  useFeedbackRewriteWorkflowStore.getState().openWorkflow(intent);
}

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
  ownerSessionId?: string;
  ownerRequestId?: string;
}

export interface FeedbackRewriteOperationIdentity {
  bookId: string;
  operationId: string;
  scope: FeedbackRewriteScope;
  chapterSlug: string;
  paragraphSlug?: string;
  requestId: number;
  ownerSessionId: string;
  ownerRequestId: string;
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
  operationId: string | null;
  progress: RewriteOperationProgress | null;
  error: string | null;
  conflicts: RollbackConflictPreview[];
  rollbackPolicies: Record<string, RewriteRollbackPolicy>;
  abortController: AbortController | null;
  abortable: boolean;
  operationIdentity: FeedbackRewriteOperationIdentity | null;
  openWorkflow: (intent: FeedbackRewriteIntent) => void;
  closeWorkflow: () => void;
  patch: (patch: Partial<FeedbackRewriteWorkflowState>) => void;
  cancelActive: (identity: FeedbackRewriteOperationIdentity) => boolean;
}

const initialRuntime = {
  phase: "loading" as FeedbackRewritePhase,
  staleFeedback: false,
  missingSummary: false,
  proposal: null,
  manifest: null,
  operationId: null,
  progress: null,
  error: null,
  conflicts: [] as RollbackConflictPreview[],
  rollbackPolicies: {} as Record<string, RewriteRollbackPolicy>,
  abortController: null,
  abortable: false,
  operationIdentity: null as FeedbackRewriteOperationIdentity | null,
};

export const useFeedbackRewriteWorkflowStore = create<FeedbackRewriteWorkflowState>()((set, get) => ({
  open: false,
  requestId: 0,
  intent: null,
  ...initialRuntime,
  openWorkflow: (intent) => set((state) => state.abortController ? state : ({
      open: true,
      requestId: state.requestId + 1,
      intent: {
        ...intent,
        ownerSessionId: intent.ownerSessionId ?? `ui:${crypto.randomUUID()}`,
        ownerRequestId: intent.ownerRequestId ?? `ui:${crypto.randomUUID()}`,
      },
      ...initialRuntime,
    })),
  closeWorkflow: () => {
    if (get().abortController) return;
    set({ open: false, intent: null, ...initialRuntime });
  },
  patch: (patch) => set(patch),
  cancelActive: (identity) => {
    const current = get();
    const controller = current.abortController;
    if (!controller || !current.abortable || !sameOperationIdentity(current.operationIdentity, identity)) return false;
    controller.abort();
    return true;
  },
}));

export function sameOperationIdentity(left: FeedbackRewriteOperationIdentity | null, right: FeedbackRewriteOperationIdentity): boolean {
  return Boolean(left
    && left.bookId === right.bookId
    && left.operationId === right.operationId
    && left.scope === right.scope
    && left.chapterSlug === right.chapterSlug
    && left.paragraphSlug === right.paragraphSlug
    && left.requestId === right.requestId
    && left.ownerSessionId === right.ownerSessionId
    && left.ownerRequestId === right.ownerRequestId);
}

export function openFeedbackRewriteWorkflow(intent: FeedbackRewriteIntent): void {
  useFeedbackRewriteWorkflowStore.getState().openWorkflow(intent);
}

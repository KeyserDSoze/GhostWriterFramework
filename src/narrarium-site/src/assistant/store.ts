import { create } from "zustand";

export interface AssistantAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: "text" | "image";
  sizeBytes: number;
  textContent?: string;
  imageDataUrl?: string;
}

export interface AssistantFileUpdate {
  path: string;
  content: string;
  reason?: string;
  previousContent?: string | null;
}

export type AssistantAction =
  | {
      kind: "apply-paragraph-rewrite";
      bookId: string;
      chapterSlug: string;
      paragraphPath: string;
      proposedBody: string;
    }
  | {
      kind: "apply-file-updates";
      bookId: string;
      updates: AssistantFileUpdate[];
    }
  | {
      kind: "undo-file-updates";
      bookId: string;
      updates: AssistantFileUpdate[];
    }
  | {
      kind: "switch-book-branch";
      bookId: string;
      branchName: string;
      createIfMissing?: boolean;
      baseBranch?: string;
    }
  | {
      kind: "navigate";
      to: string;
      label?: string;
    }
  | {
      kind: "read-aloud";
      bookId: string;
      title: string;
      paths: string[];
      includeFrontmatter?: boolean;
    };

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  action?: AssistantAction;
}

export interface AssistantSessionMeta {
  id: string;
  fileId?: string;
  title: string;
  contextTitle: string;
  updatedAt: string;
}

export interface AssistantSession extends AssistantSessionMeta {
  messages: AssistantMessage[];
  attachments: AssistantAttachment[];
  compactSummary: string;
  compactedMessageCount: number;
}

interface AssistantState {
  open: boolean;
  busy: boolean;
  sessions: AssistantSessionMeta[];
  currentSession: AssistantSession | null;
  setOpen: (open: boolean) => void;
  setBusy: (busy: boolean) => void;
  setSessions: (sessions: AssistantSessionMeta[]) => void;
  setCurrentSession: (session: AssistantSession | null) => void;
  updateCurrentSession: (updater: (session: AssistantSession) => AssistantSession) => void;
  updateMessage: (messageId: string, patch: Partial<AssistantMessage>) => void;
  clearMessages: () => void;
}

export const useAssistantStore = create<AssistantState>((set) => ({
  open: false,
  busy: false,
  sessions: [],
  currentSession: null,
  setOpen: (open) => set({ open }),
  setBusy: (busy) => set({ busy }),
  setSessions: (sessions) => set({ sessions }),
  setCurrentSession: (currentSession) => set({ currentSession }),
  updateCurrentSession: (updater) =>
    set((state) => ({
      currentSession: state.currentSession ? updater(state.currentSession) : state.currentSession,
    })),
  updateMessage: (messageId, patch) =>
    set((state) => ({
      currentSession: state.currentSession
        ? {
            ...state.currentSession,
            messages: state.currentSession.messages.map((message) =>
              message.id === messageId ? { ...message, ...patch } : message,
            ),
          }
        : state.currentSession,
    })),
  clearMessages: () =>
    set((state) => ({
      currentSession: state.currentSession
        ? { ...state.currentSession, messages: [], compactSummary: "", compactedMessageCount: 0 }
        : state.currentSession,
    })),
}));

export function createEmptyAssistantSession(contextTitle: string): AssistantSession {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: `${contextTitle} ${timestamp.slice(0, 16).replace("T", " ")}`,
    contextTitle,
    updatedAt: timestamp,
    messages: [],
    attachments: [],
    compactSummary: "",
    compactedMessageCount: 0,
  };
}

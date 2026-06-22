import { create } from "zustand";

export interface AssistantAction {
  kind: "apply-paragraph-rewrite";
  bookId: string;
  chapterSlug: string;
  paragraphPath: string;
  proposedBody: string;
}

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  action?: AssistantAction;
}

interface AssistantState {
  open: boolean;
  messages: AssistantMessage[];
  busy: boolean;
  setOpen: (open: boolean) => void;
  addMessage: (message: AssistantMessage) => void;
  replaceMessages: (messages: AssistantMessage[]) => void;
  clear: () => void;
  setBusy: (busy: boolean) => void;
}

export const useAssistantStore = create<AssistantState>((set) => ({
  open: false,
  messages: [],
  busy: false,
  setOpen: (open) => set({ open }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  replaceMessages: (messages) => set({ messages }),
  clear: () => set({ messages: [] }),
  setBusy: (busy) => set({ busy }),
}));

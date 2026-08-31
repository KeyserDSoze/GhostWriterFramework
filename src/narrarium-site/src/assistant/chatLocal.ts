import {
  deleteLocalAssistantSession,
  initializeAccountLocalStore,
  listLocalAssistantSessions,
  loadLocalAssistantSession,
  saveLocalAssistantSession,
} from "@/account/accountLocalStore";
import { useClipboardStore } from "@/clipboard/clipboardStore";
import { useCostsStore } from "@/costs/costsStore";
import { useSettingsStore } from "@/store/settingsStore";
import type { AssistantSession } from "@/assistant/store";

async function ensureLocalAccount(): Promise<void> {
  await initializeAccountLocalStore({
    settings: useSettingsStore.getState().settings,
    costs: useCostsStore.getState().file,
    clipboard: useClipboardStore.getState().items,
    chats: [],
  });
}

export async function listLocalChatSessions() {
  await ensureLocalAccount();
  return listLocalAssistantSessions();
}

export async function loadLocalChatSession(sessionId: string): Promise<AssistantSession> {
  await ensureLocalAccount();
  const session = await loadLocalAssistantSession(sessionId);
  if (!session) throw new Error(`Local chat ${sessionId} is unavailable.`);
  return session;
}

export async function saveLocalChatSession(session: AssistantSession): Promise<void> {
  await ensureLocalAccount();
  await saveLocalAssistantSession(session);
}

export async function deleteLocalChatSession(sessionId: string): Promise<void> {
  await ensureLocalAccount();
  await deleteLocalAssistantSession(sessionId);
}

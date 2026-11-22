import { useSettingsStore } from "@/store/settingsStore";

/**
 * Where the autopilot of a book runs, as the author's settings say: this is what every command reads to know whether to talk to this
 * browser's session or to the personal server. `save` keeps it (the author's settings are saved on request, not by themselves).
 */
export async function setAutopilotHost(bookId: string, host: "browser" | "server", save?: () => Promise<unknown>): Promise<void> {
  const store = useSettingsStore.getState();
  store.patchSettings({ books: store.settings.books.map((entry) => (entry.id === bookId ? { ...entry, autopilotHost: host === "server" ? "server" : undefined } : entry)) });
  await save?.();
}

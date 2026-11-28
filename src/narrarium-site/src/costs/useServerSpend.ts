import { useMemo } from "react";
import { useAutopilotStore } from "@/autopilot/store";
import { serverSpend, type ServerSpend } from "@/costs/serverSpend";
import { useMoney } from "@/costs/useMoney";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * What the books that run on the personal server spent (`serverSpend`), followed live from what this browser already holds of them: the summaries the server streams and the states downloaded. Nothing is
 * asked of the server or of GitHub here: a book whose summary was not read is said, not guessed.
 */
export function useServerSpend(bookId = ""): ServerSpend {
  const books = useSettingsStore((state) => state.settings.books);
  const views = useAutopilotStore((state) => state.views);
  const summaries = useAutopilotStore((state) => state.summaries);
  const serverBooks = useAutopilotStore((state) => state.server.books);
  const { display, relabels } = useMoney();
  return useMemo(() => serverSpend(books, { views, summaries, server: { books: serverBooks } }, { display, relabels }, bookId), [books, views, summaries, serverBooks, display, relabels, bookId]);
}

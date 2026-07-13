import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { triggerCurrentSave } from "@/store/saveStore";
import { triggerCurrentRepositorySync } from "@/store/repositorySyncStore";
import { useProseEditorStore } from "@/components/editor/proseEditorStore";
import { useClipboardStore } from "@/clipboard/clipboardStore";
import { useUiStore } from "@/store/uiStore";
import { useBooksStore } from "@/store/booksStore";
import { parseAppRoute } from "@/assistant/context";
import { resolveContextualNavigation } from "@/lib/contextualNavigation";

function selectionFromElement(el: Element | null): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (end > start) return el.value.slice(start, end);
  }
  return "";
}

/** Global keyboard shortcuts mounted once in the Shell. */
export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const location = useLocation();
  const structures = useBooksStore((s) => s.structures);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();

      // Ctrl/Cmd+S → save the active page (block the browser save dialog).
      if (key === "s") {
        event.preventDefault();
        void triggerCurrentSave();
        return;
      }

      // Ctrl/Cmd+D → open the LLM request debug modal.
      if (key === "d") {
        event.preventDefault();
        useUiStore.getState().setDebugOpen(true);
        return;
      }

      // Ctrl/Cmd+E → save active page edits, then auto-commit and push the current book.
      if (key === "e") {
        event.preventDefault();
        void triggerCurrentRepositorySync();
        return;
      }

      const route = parseAppRoute(location.pathname);
      const bookId = "bookId" in route ? route.bookId : undefined;
      const structure = bookId ? structures[bookId] : undefined;
      const target = resolveContextualNavigation(structure, location.pathname, bookId);

      // Ctrl/Cmd+Tab → switch to the next available view of the same chapter/paragraph.
      // Ctrl/Cmd+Shift+Tab → previous view of the same target.
      if (key === "tab") {
        const href = event.shiftKey ? target.previousViewHref : target.nextViewHref;
        if (!href) return;
        event.preventDefault();
        navigate(href);
        return;
      }

      // Ctrl/Cmd+B → contextual previous chapter/paragraph while keeping the same view mode.
      if (key === "b") {
        if (!target.previousHref) return;
        event.preventDefault();
        navigate(target.previousHref);
        return;
      }

      // Ctrl/Cmd+N → contextual next chapter/paragraph while keeping the same view mode.
      if (key === "n") {
        if (!target.nextHref) return;
        event.preventDefault();
        navigate(target.nextHref);
        return;
      }

      // Ctrl/Cmd+M → open quick notes.
      if (key === "m") {
        event.preventDefault();
        useUiStore.getState().setNotesOpen(true);
        return;
      }

      // Ctrl/Cmd+C inside a registered prose editor → also push to clipboard history.
      // We do NOT preventDefault, so the native copy still fills the system clipboard.
      if (key === "c") {
        const active = document.activeElement;
        const registered = active ? useProseEditorStore.getState().forElement(active as HTMLTextAreaElement) : undefined;
        if (registered) {
          const selection = selectionFromElement(active);
          if (selection.trim()) useClipboardStore.getState().push(selection, "copy");
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [location.pathname, navigate, structures]);
}

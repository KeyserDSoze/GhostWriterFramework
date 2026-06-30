import { useEffect } from "react";
import { triggerCurrentSave } from "@/store/saveStore";
import { useProseEditorStore } from "@/components/editor/proseEditorStore";
import { useClipboardStore } from "@/clipboard/clipboardStore";
import { useUiStore } from "@/store/uiStore";

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
  }, []);
}

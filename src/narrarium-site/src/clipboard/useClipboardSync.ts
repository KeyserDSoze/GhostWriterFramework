import { useEffect } from "react";
import { saveLocalAccountClipboard } from "@/account/accountLocalStore";
import { useClipboardStore } from "@/clipboard/clipboardStore";

/** Keeps the account IndexedDB replica current; remote sync is scheduled elsewhere. */
export function useClipboardSync() {
  const revision = useClipboardStore((state) => state.revision);
  useEffect(() => {
    if (revision === 0) return;
    void saveLocalAccountClipboard(useClipboardStore.getState().items).catch(() => undefined);
  }, [revision]);
}

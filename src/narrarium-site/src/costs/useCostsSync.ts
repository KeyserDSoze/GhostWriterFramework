import { useEffect, useRef } from "react";
import { useAuthStore } from "@/store/authStore";
import { useCostsStore } from "@/costs/costsStore";
import { loadCosts, saveCosts } from "@/costs/costsCloud";
import { emptyBucket, type BookUsage, type CostsFile } from "@/costs/model";

function mergeMax(a: CostsFile, b: CostsFile): CostsFile {
  const books: Record<string, BookUsage> = {};
  const ids = new Set([...Object.keys(a.books), ...Object.keys(b.books)]);
  for (const id of ids) {
    const x = a.books[id] ?? { bookId: id, ...emptyBucket() };
    const y = b.books[id] ?? { bookId: id, ...emptyBucket() };
    books[id] = {
      bookId: id,
      bookName: y.bookName ?? x.bookName,
      inputTokens: Math.max(x.inputTokens, y.inputTokens),
      cachedTokens: Math.max(x.cachedTokens, y.cachedTokens),
      outputTokens: Math.max(x.outputTokens, y.outputTokens),
      chatCost: Math.max(x.chatCost, y.chatCost),
      imageCount: Math.max(x.imageCount, y.imageCount),
      imageCost: Math.max(x.imageCost, y.imageCost),
      ttsChars: Math.max(x.ttsChars, y.ttsChars),
      ttsCost: Math.max(x.ttsCost, y.ttsCost),
      sttMinutes: Math.max(x.sttMinutes, y.sttMinutes),
      sttCost: Math.max(x.sttCost, y.sttCost),
    };
  }
  return { version: 1, currency: "EUR", updatedAt: new Date().toISOString(), books };
}

export function useCostsSync() {
  const { user, accessToken } = useAuthStore();
  const dirty = useCostsStore((s) => s.dirty);
  const loadedRef = useRef(false);
  const savingRef = useRef(false);

  // Initial load + merge with local cache.
  useEffect(() => {
    if (!user || !accessToken || loadedRef.current) return;
    loadedRef.current = true;
    void loadCosts(user.provider, accessToken).then((handle) => {
      const local = useCostsStore.getState().file;
      const merged = mergeMax(local, handle.file);
      useCostsStore.getState().setFile(merged, handle.driveFileId);
    });
  }, [user, accessToken]);

  // Debounced save when dirty.
  useEffect(() => {
    if (!user || !accessToken || !dirty) return;
    const timer = setTimeout(() => {
      if (savingRef.current) return;
      savingRef.current = true;
      const { file, driveFileId } = useCostsStore.getState();
      void saveCosts(user.provider, accessToken, { file, driveFileId })
        .then((handle) => useCostsStore.getState().markSynced(handle.driveFileId))
        .catch(() => undefined)
        .finally(() => { savingRef.current = false; });
    }, 4000);
    return () => clearTimeout(timer);
  }, [dirty, user, accessToken]);
}

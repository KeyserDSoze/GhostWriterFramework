import { useEffect, useRef } from "react";
import { useAuthStore } from "@/store/authStore";
import { useCostsStore } from "@/costs/costsStore";
import { loadCosts, saveCosts } from "@/costs/costsCloud";
import { emptyBucket, type BookUsage, type CostsFile, type UsageBucket } from "@/costs/model";

function maxBucket(x: UsageBucket, y: UsageBucket): UsageBucket {
  return {
    inputTokens: Math.max(x.inputTokens, y.inputTokens),
    cachedTokens: Math.max(x.cachedTokens, y.cachedTokens),
    outputTokens: Math.max(x.outputTokens, y.outputTokens),
    chatCost: Math.max(x.chatCost, y.chatCost),
    imageCount: Math.max(x.imageCount, y.imageCount),
    imageInputTextTokens: Math.max(x.imageInputTextTokens, y.imageInputTextTokens),
    imageCachedInputTextTokens: Math.max(x.imageCachedInputTextTokens, y.imageCachedInputTextTokens),
    imageInputImageTokens: Math.max(x.imageInputImageTokens, y.imageInputImageTokens),
    imageCachedInputImageTokens: Math.max(x.imageCachedInputImageTokens, y.imageCachedInputImageTokens),
    imageOutputTokens: Math.max(x.imageOutputTokens, y.imageOutputTokens),
    imageCost: Math.max(x.imageCost, y.imageCost),
    ttsChars: Math.max(x.ttsChars, y.ttsChars),
    ttsCost: Math.max(x.ttsCost, y.ttsCost),
    sttHours: Math.max(x.sttHours, y.sttHours),
    sttCost: Math.max(x.sttCost, y.sttCost),
  };
}

function mergeModels(a?: Record<string, UsageBucket>, b?: Record<string, UsageBucket>): Record<string, UsageBucket> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, UsageBucket> = {};
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) {
    out[key] = maxBucket({ ...emptyBucket(), ...(a?.[key] ?? {}) }, { ...emptyBucket(), ...(b?.[key] ?? {}) });
  }
  return out;
}

function mergeMax(a: CostsFile, b: CostsFile): CostsFile {
  const books: Record<string, BookUsage> = {};
  const ids = new Set([...Object.keys(a.books), ...Object.keys(b.books)]);
  for (const id of ids) {
    const x = { ...emptyBucket(), ...(a.books[id] ?? {}) };
    const y = { ...emptyBucket(), ...(b.books[id] ?? {}) };
    books[id] = {
      bookId: id,
      bookName: y.bookName ?? x.bookName,
      ...maxBucket(x, y),
      models: mergeModels(a.books[id]?.models, b.books[id]?.models),
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

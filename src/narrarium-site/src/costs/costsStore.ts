import { create } from "zustand";
import type { AIPricing } from "@/types/settings";
import { addBucket, aggregateAll, bucketTotal, emptyBucket, emptyCostsFile, type BookUsage, type CostsFile, type UsageBucket } from "@/costs/model";

const LOCAL_KEY = "narrarium-costs-v1";

function loadLocal(): CostsFile {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return { ...emptyCostsFile(), ...(JSON.parse(raw) as CostsFile) };
  } catch {
    // ignore
  }
  return emptyCostsFile();
}

function persistLocal(file: CostsFile) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(file));
  } catch {
    // ignore
  }
}

interface CostsState {
  file: CostsFile;
  driveFileId?: string;
  dirty: boolean;
  currentBookId?: string;
  currentBookName?: string;
  setCurrentBook: (bookId: string | undefined, bookName: string | undefined) => void;
  setFile: (file: CostsFile, driveFileId?: string) => void;
  markSynced: (driveFileId?: string) => void;
  record: (bookId: string | undefined, bookName: string | undefined, delta: Partial<UsageBucket>) => void;
  recordCurrent: (delta: Partial<UsageBucket>) => void;
}

export const useCostsStore = create<CostsState>()((set, get) => ({
  file: loadLocal(),
  driveFileId: undefined,
  dirty: false,
  currentBookId: undefined,
  currentBookName: undefined,
  setCurrentBook: (currentBookId, currentBookName) => set({ currentBookId, currentBookName }),
  setFile: (file, driveFileId) => { persistLocal(file); set({ file, driveFileId, dirty: false }); },
  markSynced: (driveFileId) => set((s) => ({ driveFileId: driveFileId ?? s.driveFileId, dirty: false })),
  record: (bookId, bookName, delta) => {
    if (!bookId) return;
    const hasValue = Object.values(delta).some((v) => (v ?? 0) !== 0);
    if (!hasValue) return;
    set((s) => {
      const existing: BookUsage = s.file.books[bookId] ?? { bookId, bookName, ...emptyBucket() };
      const merged: BookUsage = { ...existing, bookName: bookName ?? existing.bookName, ...addBucket(existing, delta) };
      const file: CostsFile = { ...s.file, updatedAt: new Date().toISOString(), books: { ...s.file.books, [bookId]: merged } };
      persistLocal(file);
      return { file, dirty: true };
    });
  },
  recordCurrent: (delta) => {
    const { currentBookId, currentBookName, record } = get();
    record(currentBookId, currentBookName, delta);
  },
}));

// ─── Cost computation helpers ─────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export function chatDelta(usage: TokenUsage, pricing?: AIPricing): Partial<UsageBucket> {
  const input = usage.inputTokens || 0;
  const cached = usage.cachedTokens || 0;
  const output = usage.outputTokens || 0;
  const billedInput = Math.max(0, input - cached);
  let chatCost = 0;
  if (pricing) {
    chatCost =
      (billedInput / 1_000_000) * (pricing.inputPerMTok ?? 0) +
      (cached / 1_000_000) * (pricing.cachedPerMTok ?? 0) +
      (output / 1_000_000) * (pricing.outputPerMTok ?? 0);
  }
  return { inputTokens: input, cachedTokens: cached, outputTokens: output, chatCost };
}

export function imageDelta(count: number, pricing?: AIPricing): Partial<UsageBucket> {
  return { imageCount: count, imageCost: pricing?.perImage ? count * pricing.perImage : 0 };
}

export function ttsDelta(chars: number, pricing?: AIPricing): Partial<UsageBucket> {
  return { ttsChars: chars, ttsCost: pricing?.ttsPerMChar ? (chars / 1_000_000) * pricing.ttsPerMChar : 0 };
}

export function sttDelta(minutes: number, pricing?: AIPricing): Partial<UsageBucket> {
  return { sttMinutes: minutes, sttCost: pricing?.sttPerMinute ? minutes * pricing.sttPerMinute : 0 };
}

export { aggregateAll, bucketTotal };

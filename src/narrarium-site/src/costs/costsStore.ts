import { create } from "zustand";
import type { AIPricing } from "@/types/settings";
import { aggregateAll, bucketTotal, emptyCostsFile, type CostsFile, type UsageBucket } from "@/costs/model";
import { loadLocalAccountCosts } from "@/account/accountLocalStore";

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

/**
 * What the costs shown are made of: the costs as the account store keeps them (`persisted`) and, on top of them, the records of this tab that are on
 * their way to it. The recorder (`costs/recordUsage.ts`, loaded with the first call that costs) sets it; until then nothing is on its way.
 */
let viewOf: (persisted: CostsFile) => CostsFile = (persisted) => persisted;
let afterHydrate: (() => void) | null = null;
let forget: (() => void) | null = null;

/**
 * The recorder says how the costs of this tab are seen while its records are written, what to do when the account store has given its costs
 * (records that waited for the store are written then), and how to forget what is on its way (the costs of another account replace these).
 */
export function setCostsView(view: (persisted: CostsFile) => CostsFile, hydrated?: () => void, reset?: () => void): void {
  viewOf = view;
  afterHydrate = hydrated ?? null;
  forget = reset ?? null;
}

interface CostsState {
  /** The costs shown: the stored ones and the records of this tab not yet stored. */
  file: CostsFile;
  /** The costs as the account store had them when they were last read or written. */
  persisted: CostsFile;
  driveFileId?: string;
  dirty: boolean;
  revision: number;
  currentBookId?: string;
  currentBookName?: string;
  setCurrentBook: (bookId: string | undefined, bookName: string | undefined) => void;
  /** Replaces the costs of this tab, for another account: nothing on its way is kept. */
  setFile: (file: CostsFile, driveFileId?: string) => void;
  /** The costs as the account store holds them now (after a load, a sync or a write of this tab's records). */
  hydrate: (file: CostsFile, driveFileId?: string) => void;
  /** The records on their way changed: the costs shown are made again. */
  refreshView: () => void;
  markSynced: (revision: number, driveFileId?: string) => void;
}

export const useCostsStore = create<CostsState>()((set, get) => {
  const initial = loadLocal();
  return {
    file: initial,
    persisted: initial,
    driveFileId: undefined,
    dirty: false,
    revision: 0,
    currentBookId: undefined,
    currentBookName: undefined,
    setCurrentBook: (currentBookId, currentBookName) => set({ currentBookId, currentBookName }),
    setFile: (file, driveFileId) => {
      // Another account: what this tab had on its way belongs to the one before, and is never written into this one.
      forget?.();
      persistLocal(file);
      set((s) => ({ file, persisted: file, driveFileId, dirty: false, revision: s.revision + 1 }));
    },
    hydrate: (persisted, driveFileId) => {
      const file = viewOf(persisted);
      persistLocal(file);
      set((s) => ({ file, persisted, driveFileId: driveFileId ?? s.driveFileId, dirty: file !== persisted }));
      afterHydrate?.();
    },
    refreshView: () => {
      const file = viewOf(get().persisted);
      set((s) => ({ file, dirty: file !== s.persisted, revision: s.revision + 1 }));
    },
    markSynced: (revision, driveFileId) => set((s) => s.revision === revision ? { driveFileId: driveFileId ?? s.driveFileId, dirty: false } : s),
  };
});

/** Another tab wrote costs (`recordUsage.ts` says so on this channel): what this tab shows is read again from the account store. */
export const COSTS_CHANNEL = "narrarium-costs";

let listening = false;
let reading: Promise<void> | null = null;

/** Reads the costs again from the account store (another tab wrote them). Never throws: what is shown stays until the next read. */
export function reloadCostsFromAccountStore(): Promise<void> {
  reading ??= loadLocalAccountCosts()
    .then((costs) => { if (costs) useCostsStore.getState().hydrate(costs); })
    .catch(() => undefined)
    .finally(() => { reading = null; });
  return reading;
}

function listenToOtherTabs(): void {
  if (listening || typeof BroadcastChannel === "undefined") return;
  listening = true;
  try {
    const channel = new BroadcastChannel(COSTS_CHANNEL);
    channel.onmessage = () => { void reloadCostsFromAccountStore(); };
    // A test process (Node) must not stay open for it; a page has no such thing.
    (channel as unknown as { unref?: () => void }).unref?.();
  } catch {
    // Without the channel, this tab shows its own records and the others' at its next load or sync.
  }
}

listenToOtherTabs();

// ─── Cost computation helpers ─────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/**
 * The cost of chat tokens at a price, by the engine's rule (its `estimateCost`): prices are per million tokens, and tokens served from the cache cost like
 * normal input unless the model has its own cached price. The calls the engine makes are priced by the engine itself; this is for the reports of the
 * Copilot's attempts, which must agree with them (a test compares the two).
 */
export function chatDelta(usage: TokenUsage, pricing?: AIPricing): Partial<UsageBucket> {
  const input = usage.inputTokens || 0;
  const cached = usage.cachedTokens || 0;
  const output = usage.outputTokens || 0;
  const billedInput = Math.max(0, input - cached);
  let chatCost = 0;
  if (pricing) {
    chatCost =
      (billedInput / 1_000_000) * (pricing.inputPerMTok ?? 0) +
      (cached / 1_000_000) * (pricing.cachedPerMTok ?? pricing.inputPerMTok ?? 0) +
      (output / 1_000_000) * (pricing.outputPerMTok ?? 0);
  }
  return { inputTokens: input, cachedTokens: cached, outputTokens: output, chatCost };
}

export interface ImageTokenUsage {
  inputTextTokens: number;
  cachedInputTextTokens: number;
  inputImageTokens: number;
  cachedInputImageTokens: number;
  outputTokens: number;
}

/** Token-based image cost (gpt-image style). */
export function imageTokenDelta(usage: ImageTokenUsage, pricing?: AIPricing): Partial<UsageBucket> {
  const inputText = usage.inputTextTokens || 0;
  const cachedText = usage.cachedInputTextTokens || 0;
  const inputImage = usage.inputImageTokens || 0;
  const cachedImage = usage.cachedInputImageTokens || 0;
  const output = usage.outputTokens || 0;
  const billedInputText = Math.max(0, inputText - cachedText);
  const billedInputImage = Math.max(0, inputImage - cachedImage);
  let imageCost = 0;
  if (pricing) {
    imageCost =
      (billedInputText / 1_000_000) * (pricing.imageInputTextPerMTok ?? 0) +
      (cachedText / 1_000_000) * (pricing.imageCachedInputTextPerMTok ?? 0) +
      (billedInputImage / 1_000_000) * (pricing.imageInputImagePerMTok ?? 0) +
      (cachedImage / 1_000_000) * (pricing.imageCachedInputImagePerMTok ?? 0) +
      (output / 1_000_000) * (pricing.imageOutputPerMTok ?? 0);
  }
  return {
    imageCount: 1,
    imageInputTextTokens: inputText,
    imageCachedInputTextTokens: cachedText,
    imageInputImageTokens: inputImage,
    imageCachedInputImageTokens: cachedImage,
    imageOutputTokens: output,
    imageCost,
  };
}

export function ttsDelta(chars: number, pricing?: AIPricing): Partial<UsageBucket> {
  return { ttsChars: chars, ttsCost: pricing?.ttsPerMChar ? (chars / 1_000_000) * pricing.ttsPerMChar : 0 };
}

export function sttDelta(hours: number, pricing?: AIPricing): Partial<UsageBucket> {
  return { sttHours: hours, sttCost: pricing?.sttPerHour ? hours * pricing.sttPerHour : 0 };
}

export { aggregateAll, bucketTotal };

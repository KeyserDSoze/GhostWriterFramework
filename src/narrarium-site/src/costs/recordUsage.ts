import { LocalAccountStoreMissingError, updateLocalAccountCosts } from "@/account/accountLocalStore";
import { COSTS_CHANNEL, setCostsView, useCostsStore } from "@/costs/costsStore";
import type { UsageCounters, UsageDelta, UsageSource } from "@/costs/ledger";
import type { UsageBucket } from "@/costs/model";
import { localDay } from "@/costs/period";
import { usageSource, type UsageOrigin } from "@/costs/usageSource";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * THE way usage is recorded: every call that may cost something, of every feature (the browser's AI port for the autopilot, the Copilot and every
 * feature routed through it; images; voice), comes here once, and nowhere else writes costs. A record goes into the ledger and, as the legacy code
 * did, into the legacy totals of its book (`legacyCosts.ts`), in one transaction of the account store, so that two tabs never lose each other's.
 */
export interface UsageRecord extends UsageOrigin {
  /** The book the call is for: the run's, else the book open in the app; none is `""`. */
  bookId?: string;
  bookName?: string;
  integrationId?: string;
  model: string;
  /** The task the call belongs to: its first call counts the task. Absent: the call is a task of its own. */
  task?: string;
  /** The tokens of the call: reported by the provider when `usageKnown`, the engine's estimate otherwise; `null` when nothing came back. */
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number } | null;
  usageKnown: boolean;
  /** The money of the call at the price of its model: measured when `costKnown`, an estimate otherwise; absent without a price. */
  cost?: number;
  costKnown: boolean;
  /** Whether the model had a price. */
  priced: boolean;
  /** The currency of the price: the setting when the call was made. */
  currency: string;
  /** A call that used something even though nothing says how much (an image the provider made without reporting its tokens). */
  billed?: boolean;
  /** What only the legacy totals count of it (images, characters, hours), exactly as the legacy code recorded them. */
  legacy?: Partial<UsageBucket>;
  /** When the call ended. */
  at?: Date;
}

/** A record as it was added: its row of the ledger, and what it added to the legacy totals. */
export interface RecordedUsage {
  record: UsageRecord;
  source: UsageSource;
  delta: UsageDelta;
}

/** A record on its way to the account store: its row, its book, what only the legacy totals count of it, when, and the currency a ledger it begins starts with. */
export interface PendingUsage {
  delta: UsageDelta;
  bookId: string;
  bookName?: string;
  legacy?: Partial<UsageBucket>;
  at: Date;
  /** The currency the ledger starts with, if this record begins it. */
  currency: string;
}

const pending: PendingUsage[] = [];
let writing: Promise<void> = Promise.resolve();
/** Raised when what is on its way is forgotten: a write that began before it does not touch what came after. */
let generation = 0;
let waitingForStore = false;
const listeners = new Set<(recorded: RecordedUsage) => void>();

/** The tasks already counted, newest last; a few thousand are enough for the tasks of a tab that still make calls. */
const counted = new Map<string, true>();
const MAX_COUNTED = 4000;

function firstCallOf(task: string | undefined): boolean {
  if (!task) return true;
  if (counted.has(task)) return false;
  counted.set(task, true);
  if (counted.size > MAX_COUNTED) counted.delete(counted.keys().next().value as string);
  return true;
}

/** The counters of one call: measured numbers and estimates apart, never mixed. */
export function countersOf(record: Pick<UsageRecord, "usage" | "usageKnown" | "cost" | "costKnown" | "priced" | "billed">, firstOfTask: boolean): Partial<UsageCounters> {
  const counters: Partial<UsageCounters> = { calls: 1, tasks: firstOfTask ? 1 : 0 };
  const used = Boolean(record.usage && (record.usage.inputTokens || record.usage.outputTokens || record.usage.cachedTokens)) || record.billed === true;
  if (record.usage && record.usageKnown) {
    counters.inputTokens = record.usage.inputTokens;
    counters.cachedTokens = record.usage.cachedTokens;
    counters.outputTokens = record.usage.outputTokens;
  } else if (used && !record.usageKnown) {
    counters.unknownUsageCalls = 1;
    if (record.usage) {
      counters.estimatedInputTokens = record.usage.inputTokens;
      counters.estimatedOutputTokens = record.usage.outputTokens;
    }
  }
  if (record.priced && typeof record.cost === "number" && Number.isFinite(record.cost)) {
    if (record.costKnown && record.usageKnown) counters.cost = record.cost;
    else counters.estimatedCost = record.cost;
  }
  if (!record.priced && used) counters.unpricedCalls = 1;
  return counters;
}

/** The writer the records of this tab are shown under until they are stored: only what is shown, never stored. */
const PENDING_WRITER = "pending";

/**
 * What turns records into costs (`applyUsage.ts`: the ledger and the legacy totals), loaded with the first record: the app does not carry the ledger
 * before it records anything. Until it is there a record is kept and shown once it is.
 */
type Apply = typeof import("@/costs/applyUsage");
let apply: Apply | null = null;
let loading: Promise<Apply> | null = null;

function loadApply(): Promise<Apply> {
  loading ??= import("@/costs/applyUsage")
    .then((module) => {
      apply = module;
      return module;
    })
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

setCostsView(
  (persisted) => (pending.length && apply ? apply.withRecords(persisted, pending, PENDING_WRITER) : persisted),
  () => { if (waitingForStore && pending.length) flush(); },
  () => resetUsageRecorder(),
);

function tellOtherTabs(): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(COSTS_CHANNEL);
    channel.postMessage({ type: "costs-changed" });
    channel.close();
  } catch {
    // The other tabs see these records at their next load or sync.
  }
}

/** Writes the records on their way, in order, one transaction at a time. Before the account store exists they wait for it (`flushPendingUsage`). */
function flush(): void {
  writing = writing.then(async () => {
    while (pending.length) {
      const batch = pending.slice();
      const started = generation;
      try {
        const { withRecords } = await loadApply();
        const stored = await updateLocalAccountCosts((costs, writerId) => (started === generation ? withRecords(costs, batch, writerId) : costs));
        if (started !== generation) return;
        pending.splice(0, batch.length);
        waitingForStore = false;
        useCostsStore.getState().hydrate(stored);
        tellOtherTabs();
      } catch (error) {
        // The store is not made yet (the settings are loading), or cannot be written now: the records stay on their way and are shown; the next record,
        // or the load of the account data, writes them.
        waitingForStore = error instanceof LocalAccountStoreMissingError || waitingForStore;
        return;
      }
    }
  });
}

/** Writes the records that waited for the account store: the store calls it once it has loaded the account data. */
export function flushPendingUsage(): Promise<void> {
  if (pending.length) flush();
  return writing;
}

/** Whether records wait for the account store to be made (they are kept and shown meanwhile). */
export function usageWaitingForStore(): boolean {
  return waitingForStore && pending.length > 0;
}

/** Hears every record as it is added, with its row: for what shows a task's cost while it runs. A listener that throws never stops a record. */
export function onUsageRecorded(listener: (recorded: RecordedUsage) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Records one call. Never throws and never waits: the caller's work goes on whatever happens to the record. */
export function recordUsage(record: UsageRecord): RecordedUsage {
  const store = useCostsStore.getState();
  const bookId = record.bookId ?? store.currentBookId ?? "";
  const bookName = record.bookId !== undefined ? record.bookName : store.currentBookName;
  const at = record.at ?? new Date();
  const source = usageSource(record);
  const display = useSettingsStore.getState().settings.costCurrency || "USD";
  const delta: UsageDelta = {
    key: {
      period: localDay(at),
      bookId,
      source,
      capability: record.capability,
      integrationId: record.integrationId ?? "",
      model: record.model,
      currency: record.priced ? record.currency || display : "",
    },
    counters: countersOf(record, firstCallOf(record.task)),
  };
  pending.push({ delta, bookId, ...(bookName ? { bookName } : {}), ...(record.legacy ? { legacy: record.legacy } : {}), at, currency: display });
  if (apply) store.refreshView();
  else void loadApply().then(() => useCostsStore.getState().refreshView(), () => undefined);
  flush();
  const recorded: RecordedUsage = { record: { ...record, bookId }, source, delta };
  for (const listener of listeners) {
    try {
      listener(recorded);
    } catch {
      // A listener never stops a record.
    }
  }
  return recorded;
}

/** Forgets what this tab had on its way and the tasks it counted: for another account, and for the tests. */
export function resetUsageRecorder(): void {
  generation += 1;
  pending.splice(0, pending.length);
  counted.clear();
  waitingForStore = false;
}

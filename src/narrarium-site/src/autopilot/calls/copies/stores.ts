import { emptyLedger, type CopyLedger, type CopyLedgerState, type CopyOutbox, type CopyOutboxItem, type CopyTargetKind } from "./types";

const outboxKey = (item: { bookId: string; taskId: string; target: CopyTargetKind }) => `${item.bookId}\u0000${item.target}\u0000${item.taskId}`;

/** The reference `CopyOutbox`: in memory, for tests and for a device whose real outbox is not wired. */
export class MemoryCopyOutbox implements CopyOutbox {
  private readonly items = new Map<string, CopyOutboxItem>();
  async put(item: CopyOutboxItem): Promise<void> { this.items.set(outboxKey(item), { ...item }); }
  async list(bookId?: string): Promise<CopyOutboxItem[]> {
    return [...this.items.values()].filter((item) => bookId === undefined || item.bookId === bookId).map((item) => ({ ...item }));
  }
  async delete(bookId: string, taskId: string, target: CopyTargetKind): Promise<void> { this.items.delete(outboxKey({ bookId, taskId, target })); }
}

const ledgerKey = (bookId: string, target: CopyTargetKind, scope: string | null) => `${scope ?? ""}\u0000${bookId}\u0000${target}`;

/** The reference `CopyLedger`: in memory. */
export class MemoryCopyLedger implements CopyLedger {
  private readonly states = new Map<string, CopyLedgerState>();
  async read(bookId: string, target: CopyTargetKind, scope: string | null): Promise<CopyLedgerState> {
    return structuredClone(this.states.get(ledgerKey(bookId, target, scope)) ?? emptyLedger(target));
  }
  async write(bookId: string, target: CopyTargetKind, scope: string | null, state: CopyLedgerState): Promise<void> {
    this.states.set(ledgerKey(bookId, target, scope), structuredClone(state));
  }
  async clear(bookId: string, target: CopyTargetKind, scope: string | null): Promise<void> { this.states.delete(ledgerKey(bookId, target, scope)); }
}

const STORAGE_PREFIX = "narrarium.aiCallCopies.v1";

/** A `CopyLedger` that keeps each archive's state in localStorage (small: an id, a day and a size per task), under a key of the account scope, the book and the target. */
export class LocalStorageCopyLedger implements CopyLedger {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = window.localStorage) {}
  private key(bookId: string, target: CopyTargetKind, scope: string | null): string {
    return `${STORAGE_PREFIX}.${encodeURIComponent(scope ?? "")}.${encodeURIComponent(bookId)}.${target}`;
  }
  async read(bookId: string, target: CopyTargetKind, scope: string | null): Promise<CopyLedgerState> {
    try {
      const raw = this.storage.getItem(this.key(bookId, target, scope));
      if (!raw) return emptyLedger(target);
      const value = JSON.parse(raw) as Partial<CopyLedgerState>;
      if (!value || typeof value !== "object" || typeof value.copied !== "object" || value.copied === null) return emptyLedger(target);
      return { ...emptyLedger(target), ...value, target, copied: value.copied, skipped: Array.isArray(value.skipped) ? value.skipped : [] };
    } catch {
      return emptyLedger(target);
    }
  }
  async write(bookId: string, target: CopyTargetKind, scope: string | null, state: CopyLedgerState): Promise<void> {
    this.storage.setItem(this.key(bookId, target, scope), JSON.stringify(state));
  }
  async clear(bookId: string, target: CopyTargetKind, scope: string | null): Promise<void> {
    this.storage.removeItem(this.key(bookId, target, scope));
  }
}

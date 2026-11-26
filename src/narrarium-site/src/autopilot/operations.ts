import i18n from "@/i18n";

/** What can hold a book: each of these is exclusive with the others for the same book. Pause, Stop and looking at the book never are. */
export type AutopilotOperationKind = "start" | "answer" | "configure" | "reset" | "intervene" | "moveToServer" | "moveToBrowser" | "sync" | "frozen" | "campaign" | "githubConflicts";

export interface BookOperation {
  kind: AutopilotOperationKind;
  /** When it started (ISO 8601). */
  since: string;
}

/** Another operation holds the book, or another tab of this browser does: say which, in words. */
export class AutopilotOperationBusyError extends Error {
  constructor(readonly requested: AutopilotOperationKind, readonly active: AutopilotOperationKind | "otherTab") {
    super(i18n.t(`autopilot.errors.busyWith.${active}`));
    this.name = "AutopilotOperationBusyError";
  }
}

interface ActiveOperation extends BookOperation {
  automatic: boolean;
  finished: Promise<void>;
}

/**
 * One operation at a time for each book, whoever asks for it: the page, the dock, a background sync. The operation
 * a person started is published (`publish`), so every component can disable what conflicts with it and say what is
 * happening; one that is refused throws `AutopilotOperationBusyError`. Whatever the outcome, the book is free again.
 */
export class BookOperations {
  private readonly active = new Map<string, ActiveOperation>();

  constructor(private readonly publish: (bookId: string, operation: BookOperation | null) => void) {}

  current(bookId: string): BookOperation | null {
    const active = this.active.get(bookId);
    return active && !active.automatic ? { kind: active.kind, since: active.since } : null;
  }

  /** An operation the author asked for. It waits for a background one, which ends by itself, and is refused by another of the author's. */
  async run<T>(bookId: string, kind: AutopilotOperationKind, work: () => Promise<T>): Promise<T> {
    for (;;) {
      const active = this.active.get(bookId);
      if (!active) break;
      if (!active.automatic) throw new AutopilotOperationBusyError(kind, active.kind);
      await active.finished;
    }
    return this.enter(bookId, kind, false, work);
  }

  /** Work nobody asked for (a sync after a step of the server): it gives way, doing nothing, when the book is busy. */
  async runAutomatic<T>(bookId: string, kind: AutopilotOperationKind, work: () => Promise<T>): Promise<T | undefined> {
    if (this.active.has(bookId)) return undefined;
    return this.enter(bookId, kind, true, work);
  }

  private async enter<T>(bookId: string, kind: AutopilotOperationKind, automatic: boolean, work: () => Promise<T>): Promise<T> {
    const since = new Date().toISOString();
    let release: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => { release = resolve; });
    this.active.set(bookId, { kind, since, automatic, finished });
    if (!automatic) this.publish(bookId, { kind, since });
    try {
      return await work();
    } finally {
      this.active.delete(bookId);
      if (!automatic) this.publish(bookId, null);
      release();
    }
  }
}

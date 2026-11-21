interface Want {
  /** The earliest time a download is wanted. */
  notBefore: number;
  /** How long after the end of the previous download this request lets the next one start. */
  minInterval: number;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface Slot<T> {
  inFlight: Promise<T> | null;
  /** When the previous download ended. */
  lastEnd: number;
  /** What was asked for since the last download started; only the requests that would start one earliest are kept. */
  wanted: Want[];
  /** Callers waiting for the next download to end. */
  waiters: Array<Waiter<T>>;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Keeps the downloads of each book in order, whoever asks for them: one at a time; one more after it when somebody
 * asked in the meantime (the one in flight may have started before what they wait for); and, for requests that give an
 * interval, not sooner than that interval after the previous one ended. Requests that come while one is waiting for its
 * turn join it, so a burst of events costs one download, and the last event is never left without one.
 */
export class RefreshCoordinator<T> {
  private readonly slots = new Map<string, Slot<T>>();

  constructor(private readonly load: (bookId: string) => Promise<T>) {}

  private slot(bookId: string): Slot<T> {
    let slot = this.slots.get(bookId);
    if (!slot) {
      slot = { inFlight: null, lastEnd: Number.NEGATIVE_INFINITY, wanted: [], waiters: [], timer: null };
      this.slots.set(bookId, slot);
    }
    return slot;
  }

  /**
   * Download now, or right after the one in flight. With `join` the one in flight is enough: for whoever only wants
   * to see the book and is not waiting for a change made a moment ago.
   */
  refresh(bookId: string, options: { join?: boolean } = {}): Promise<T> {
    const slot = this.slot(bookId);
    if (options.join && slot.inFlight) return slot.inFlight;
    const done = new Promise<T>((resolve, reject) => slot.waiters.push({ resolve, reject }));
    this.want(slot, { notBefore: Date.now(), minInterval: 0 });
    this.pump(bookId, slot);
    return done;
  }

  /** A download is wanted `delay` ms from now, and at least `minInterval` ms after the previous one ended. */
  schedule(bookId: string, when: { delay: number; minInterval: number }): void {
    const slot = this.slot(bookId);
    this.want(slot, { notBefore: Date.now() + when.delay, minInterval: when.minInterval });
    this.pump(bookId, slot);
  }

  private want(slot: Slot<T>, request: Want): void {
    const dominated = (other: Want) => other.notBefore <= request.notBefore && other.minInterval <= request.minInterval;
    if (slot.wanted.some(dominated)) return;
    slot.wanted = [...slot.wanted.filter((other) => !(request.notBefore <= other.notBefore && request.minInterval <= other.minInterval)), request];
  }

  private pump(bookId: string, slot: Slot<T>): void {
    if (slot.inFlight || slot.wanted.length === 0) return;
    const now = Date.now();
    // A clock that was set back must not hold the next download for longer than the interval itself.
    if (slot.lastEnd > now) slot.lastEnd = now;
    const due = Math.min(...slot.wanted.map((request) => Math.max(request.notBefore, slot.lastEnd + request.minInterval)));
    const wait = due - now;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    if (wait > 0) {
      slot.timer = setTimeout(() => {
        slot.timer = null;
        this.pump(bookId, slot);
      }, wait);
      return;
    }
    const claimed = slot.waiters;
    slot.waiters = [];
    slot.wanted = [];
    let download: Promise<T>;
    try {
      download = this.load(bookId);
    } catch (error) {
      download = Promise.reject(error);
    }
    slot.inFlight = download;
    const finish = () => {
      slot.inFlight = null;
      slot.lastEnd = Date.now();
      this.pump(bookId, slot);
    };
    download.then(
      (value) => {
        finish();
        for (const waiter of claimed) waiter.resolve(value);
      },
      (error: unknown) => {
        finish();
        for (const waiter of claimed) waiter.reject(error);
      },
    );
  }
}

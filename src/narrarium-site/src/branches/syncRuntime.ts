import type { SyncTrigger } from "@/branches/autoSyncPolicy";
import { refreshLoadedBranch, runBookSyncCycle, browserAutoSyncHost } from "@/branches/autoSync";
import { useBranchSyncStore, type BookSyncState } from "@/branches/syncStore";
import { sayOutcomesOfWatchedBranch } from "@/branches/outcomeToasts";

/**
 * One tab of the browser syncs the branches; the others ask it. The tabs queue for a Web Lock (`LEADER_LOCK`): the tab that holds it runs the cycles of
 * every book a tab asks for (one at a time per book, a request that comes while it runs makes it run once more after), and tells the others what it found
 * over a BroadcastChannel; when it closes, the next tab in the queue takes over (the pattern of the autopilot's connection to the personal server).
 * Without Web Locks or BroadcastChannel a tab syncs by itself: the lock of each working copy still keeps two tabs from changing it at once.
 */

export const LEADER_LOCK = "narrarium:branch-sync";
export const CHANNEL_NAME = "narrarium-branch-sync";

export interface SyncChannel {
  postMessage(data: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/** What a tab asks: the book, why, and the branch it shows (the leading tab may not have the book open, or may know an older choice of branch). */
export interface SyncRequest { trigger: SyncTrigger; branch?: string }

export type SyncMessage =
  | { kind: "request"; bookId: string; trigger: SyncTrigger; branch?: string }
  | { kind: "state"; bookId: string; state: BookSyncState }
  | { kind: "branch-updated"; bookId: string; branch: string };

export interface SyncRuntimeEnv {
  locks?: () => LockManager | undefined;
  channel?: () => SyncChannel | null;
  cycle?: (bookId: string, request: SyncRequest, branchUpdated: (bookId: string, branch: string) => void) => Promise<BookSyncState>;
  /** A branch of a book shown here got new files: read it again (default: the structure of the book, if this tab shows that branch). */
  refresh?: (bookId: string, branch: string) => void;
}

/** Opening, switching, creating and the person outrank the automatic triggers: a request waiting for a running cycle keeps the strongest. */
const STRENGTH: Record<SyncTrigger, number> = { manual: 3, created: 2, switch: 2, open: 2, online: 1, focus: 1, periodic: 0 };

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export class BranchSyncRuntime {
  private started = false;
  private leader = false;
  private channelValue: SyncChannel | null = null;
  private readonly controller = new AbortController();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Map<string, SyncRequest>();
  /** Asked of a leader that may not have heard: run here if this tab becomes the leader. */
  private readonly unanswered = new Map<string, SyncRequest>();

  constructor(private readonly env: SyncRuntimeEnv = {}) {}

  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.channelValue = this.env.channel ? this.env.channel() : typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);
    this.channelValue?.addEventListener("message", (event) => this.onMessage(event.data as SyncMessage | undefined));
    const manager = this.env.locks ? this.env.locks() : typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!manager?.request || !this.channelValue) {
      this.becomeLeader();
      return;
    }
    const signal = this.controller.signal;
    void manager.request(LEADER_LOCK, { signal }, async () => {
      this.becomeLeader();
      await untilAborted(signal);
      this.leader = false;
    }).catch(() => {
      // The browser refused the lock (a sandboxed page): this tab syncs by itself, as it would without Web Locks.
      if (!signal.aborted && !this.leader) this.becomeLeader();
    });
  }

  /** Stop leading or following (tests; a real tab simply closes, which hands the lock over). */
  stop(): void {
    this.controller.abort();
    this.leader = false;
  }

  /** A trigger of this tab for a book, with the branch it shows: run by the leader, this tab or another one. */
  request(bookId: string, trigger: SyncTrigger, branch?: string): void {
    this.start();
    const request = { trigger, ...(branch ? { branch } : {}) };
    if (this.leader) {
      this.enqueue(bookId, request);
      return;
    }
    this.keepStrongest(this.unanswered, bookId, request);
    this.post({ kind: "request", bookId, ...request });
  }

  /** What the cycle of a book runs now, if any (tests wait on it). */
  whenIdle(bookId: string): Promise<void> {
    return this.running.get(bookId) ?? Promise.resolve();
  }

  private becomeLeader(): void {
    this.leader = true;
    const waiting = [...this.unanswered];
    this.unanswered.clear();
    for (const [bookId, request] of waiting) this.enqueue(bookId, request);
  }

  /** The strongest reason wins; the newest branch asked for is the one shown now. */
  private keepStrongest(map: Map<string, SyncRequest>, bookId: string, request: SyncRequest): void {
    const current = map.get(bookId);
    const trigger = current && STRENGTH[current.trigger] > STRENGTH[request.trigger] ? current.trigger : request.trigger;
    const branch = request.branch ?? current?.branch;
    map.set(bookId, { trigger, ...(branch ? { branch } : {}) });
  }

  private enqueue(bookId: string, request: SyncRequest): void {
    if (this.running.has(bookId)) {
      this.keepStrongest(this.again, bookId, request);
      return;
    }
    const run = (async () => {
      try {
        const cycle = this.env.cycle ?? ((id: string, asked: SyncRequest, updated: (book: string, branch: string) => void) => runBookSyncCycle(id, asked.trigger, browserAutoSyncHost(updated), { branch: asked.branch }));
        const state = await cycle(bookId, request, (book, branch) => this.branchUpdated(book, branch));
        this.post({ kind: "state", bookId, state });
      } catch {
        // A cycle that throws has said nothing new: the next trigger tries again.
      } finally {
        this.running.delete(bookId);
        const next = this.again.get(bookId);
        this.again.delete(bookId);
        if (next) this.enqueue(bookId, next);
      }
    })();
    this.running.set(bookId, run);
  }

  private branchUpdated(bookId: string, branch: string): void {
    (this.env.refresh ?? ((book, name) => void refreshLoadedBranch(book, name)))(bookId, branch);
    this.post({ kind: "branch-updated", bookId, branch });
  }

  private onMessage(message: SyncMessage | undefined): void {
    switch (message?.kind) {
      case "request":
        if (this.leader) this.enqueue(message.bookId, { trigger: message.trigger, ...(message.branch ? { branch: message.branch } : {}) });
        break;
      case "state":
        this.unanswered.delete(message.bookId);
        useBranchSyncStore.getState().replaceBook(message.bookId, message.state);
        break;
      case "branch-updated":
        (this.env.refresh ?? ((book, name) => void refreshLoadedBranch(book, name)))(message.bookId, message.branch);
        break;
      default:
    }
  }

  private post(message: SyncMessage): void {
    try { this.channelValue?.postMessage(message); } catch { /* another tab missing a message only waits for the next one */ }
  }
}

let shared: BranchSyncRuntime | null = null;
let saying = false;

/** The runtime of this tab, started on first use, and what it tells the person about the branch this tab shows. */
export function branchSyncRuntime(): BranchSyncRuntime {
  shared ??= new BranchSyncRuntime();
  shared.start();
  if (!saying) {
    saying = true;
    sayOutcomesOfWatchedBranch();
  }
  return shared;
}

/** Tests: a fresh runtime with their locks, channel and cycle. */
export function replaceBranchSyncRuntimeForTests(runtime: BranchSyncRuntime | null): void {
  shared?.stop();
  shared = runtime;
}

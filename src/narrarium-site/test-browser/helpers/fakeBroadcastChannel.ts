/** The bits of `BroadcastChannel` the runtime uses. */
export interface FakeChannel {
  postMessage(data: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
}

/**
 * The tabs of one browser: a message posted on one channel reaches every other channel (not the sender's own),
 * copied as the browser copies it, a moment later.
 */
export class FakeBroadcastBus {
  private readonly channels = new Set<FakeChannelImpl>();
  /** Every message posted, in order, with the tab that posted it. */
  readonly posted: Array<{ from: string; data: unknown }> = [];

  channel(tab: string): FakeChannel {
    const channel = new FakeChannelImpl(this, tab);
    this.channels.add(channel);
    return channel;
  }

  closeTab(tab: string): void {
    for (const channel of [...this.channels]) if (channel.tab === tab) channel.close();
  }

  /** @internal */
  deliver(from: FakeChannelImpl, data: unknown): void {
    this.posted.push({ from: from.tab, data });
    const copy = structuredClone(data);
    for (const channel of this.channels) {
      if (channel === from) continue;
      queueMicrotask(() => channel.receive(structuredClone(copy)));
    }
  }

  /** @internal */
  forget(channel: FakeChannelImpl): void {
    this.channels.delete(channel);
  }
}

class FakeChannelImpl implements FakeChannel {
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  private closed = false;

  constructor(private readonly bus: FakeBroadcastBus, readonly tab: string) {}

  postMessage(data: unknown): void {
    if (this.closed) return;
    this.bus.deliver(this, data);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  receive(data: unknown): void {
    if (this.closed) return;
    for (const listener of [...this.listeners]) listener({ data } as MessageEvent);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.bus.forget(this);
  }
}

import { vi } from "vitest";

export interface FakeSentinel {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  /** What the browser does to the lock when the tab goes to the background. */
  revoke: () => void;
}

export function fakeSentinel(): FakeSentinel {
  const listeners = new Set<() => void>();
  const value: FakeSentinel = {
    released: false,
    release: vi.fn(async () => {
      value.released = true;
    }),
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
    revoke: () => {
      value.released = true;
      for (const listener of [...listeners]) listener();
    },
  };
  return value;
}

/** A fake `navigator.wakeLock` and `document.visibilityState`, with the locks it granted. */
export function installFakeWakeLock() {
  const state = {
    visibility: "visible" as "visible" | "hidden",
    issued: [] as FakeSentinel[],
    request: vi.fn(async (_type: string) => { const next = fakeSentinel(); state.issued.push(next); return next; }),
  };
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state.visibility });
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: (type: string) => state.request(type) } });
  return {
    state,
    /** Replace what a request does. */
    onRequest(behavior: () => Promise<FakeSentinel>) {
      state.request.mockImplementation(async () => behavior());
    },
    setVisibility(next: "visible" | "hidden") {
      state.visibility = next;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    uninstall() {
      delete (document as { visibilityState?: unknown }).visibilityState;
      delete (navigator as { wakeLock?: unknown }).wakeLock;
    },
    removeApi() {
      delete (navigator as { wakeLock?: unknown }).wakeLock;
    },
  };
}

export const flushMicrotasks = async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); };

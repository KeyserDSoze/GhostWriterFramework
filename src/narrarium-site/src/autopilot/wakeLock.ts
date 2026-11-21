interface WakeLockSentinelLike {
  readonly released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
  removeEventListener?(type: "release", listener: () => void): void;
}

interface WakeLockApi {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

function wakeLockApi(): WakeLockApi | undefined {
  return (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
}

/**
 * Keeps the screen awake while a run goes on in this tab, so the device does not suspend the run.
 *
 * The browser drops the lock whenever the tab goes to the background, so it is taken again each time the tab is shown
 * for as long as the run lasts. A refusal (low battery, power saving, no support) is not an error: the run goes on and
 * the next time the tab is shown it is tried again.
 */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private requesting: Promise<void> | null = null;
  private active = false;

  /** The lock is held right now. */
  get held(): boolean {
    return Boolean(this.sentinel && !this.sentinel.released);
  }

  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "visible") void this.acquire();
  };

  /** A run began: hold the lock, and take it again whenever the browser drops it. */
  start(): void {
    if (this.active) return;
    this.active = true;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    void this.acquire();
  }

  /** The run ended: let the screen sleep again. */
  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    const current = this.sentinel;
    this.sentinel = null;
    await current?.release().catch(() => undefined);
  }

  private acquire(): Promise<void> {
    const api = wakeLockApi();
    if (!this.active || !api || document.visibilityState !== "visible" || this.held) return Promise.resolve();
    if (this.requesting) return this.requesting;
    const attempt = (async () => {
      try {
        const granted = await api.request("screen");
        if (!this.active) {
          await granted.release().catch(() => undefined);
          return;
        }
        this.sentinel = granted;
        granted.addEventListener?.("release", () => {
          if (this.sentinel === granted) this.sentinel = null;
        });
      } catch {
        this.sentinel = null;
      }
    })();
    const requesting = attempt.finally(() => {
      if (this.requesting === requesting) this.requesting = null;
    });
    this.requesting = requesting;
    return requesting;
  }
}

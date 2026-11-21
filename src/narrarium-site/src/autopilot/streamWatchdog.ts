/**
 * Notices a live connection that went quiet. The personal server sends a `heartbeat` every 15 seconds, so a connection
 * that delivers nothing for `limit` ms is dead even though the browser was not told (a phone that changed network, a
 * proxy that dropped it): `trip` is called once, to close it and open another.
 *
 * Messages are only counted (`touch`), not timed one by one, so a long, busy run costs nothing. The check is by the
 * clock, not by counting timer ticks: a timer that a background tab delays is no excuse for noticing late, and the
 * tab being shown again or the network coming back checks at once.
 */
export class StreamWatchdog {
  /** The connection was given up as dead. */
  tripped = false;
  private last = Date.now();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly limit: number, private readonly trip: () => void) {
    this.arm(limit);
    document.addEventListener("visibilitychange", this.onWake);
    window.addEventListener("online", this.onWake);
  }

  /** Something arrived. */
  touch(): void {
    this.last = Date.now();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    document.removeEventListener("visibilitychange", this.onWake);
    window.removeEventListener("online", this.onWake);
  }

  private arm(delay: number): void {
    this.timer = setTimeout(this.onTimer, Math.max(0, delay));
  }

  private readonly onTimer = () => {
    this.timer = null;
    if (!this.expire()) this.arm(this.limit - (Date.now() - this.last));
  };

  private readonly onWake = () => {
    this.expire();
  };

  private expire(): boolean {
    if (this.tripped) return true;
    if (Date.now() - this.last < this.limit) return false;
    this.tripped = true;
    this.stop();
    this.trip();
    return true;
  }
}

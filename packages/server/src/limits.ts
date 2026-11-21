import { isIP } from "node:net";

/** Requests that come from this computer without saying where they started: the local CLI, the owner's browser. */
export const LOCAL_SOURCE = "local";
/** The most keys a limiter remembers: memory stays bounded however many sources show up. */
export const MAX_LIMITER_KEYS = 10_000;

/** What `sourceOf` reads of an HTTP request: the TCP peer and the headers. */
export interface RequestOrigin {
  socket: { remoteAddress?: string | undefined };
  headers: Record<string, string | string[] | undefined>;
}

/** The eight 16-bit groups of an IPv6 address that `net.isIP` has accepted. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const [a, b, c, d] = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = rest ? rest.split(":") : [];
  const gap = text.includes("::") ? 8 - front.length - back.length : 0;
  return [...front, ...Array<string>(gap).fill("0"), ...back].map((group) => Number.parseInt(group, 16));
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), if that is what these groups are. */
function mappedIpv4(groups: number[]): string | undefined {
  if (!groups.slice(0, 5).every((group) => group === 0) || groups[5] !== 0xffff) return undefined;
  return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
}

export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return address.startsWith("127.");
  if (family !== 6) return false;
  const groups = ipv6Groups(address);
  const mapped = mappedIpv4(groups);
  if (mapped) return mapped.startsWith("127.");
  return groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
}

/**
 * The identity a limit is counted for, from an IP address: IPv4 as it is (IPv4-mapped IPv6 too), IPv6 as the /64 network
 * it belongs to, because one subscriber holds a whole /64 and could otherwise spend a fresh budget with every address.
 * `undefined` when the text is not an IP address.
 */
export function sourceFromAddress(address: string): string | undefined {
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return undefined;
  const groups = ipv6Groups(address);
  return mappedIpv4(groups) ?? `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/**
 * Who sent a request, as far as limits are concerned.
 *
 * The server listens on loopback only; the Cloudflare connector reaches it from there and puts the real client address
 * in `cf-connecting-ip` (Cloudflare overwrites whatever the client sent). That header is believed only when the TCP peer
 * is loopback and the owner configured a public address (`trustTunnelHeader`): otherwise anybody could claim any address.
 * Loopback without the header is the single source "local".
 */
export function sourceOf(request: RequestOrigin, trustTunnelHeader: boolean): string {
  const peer = request.socket.remoteAddress;
  if (!peer) return "unknown";
  if (!isLoopbackAddress(peer)) return sourceFromAddress(peer) ?? peer.slice(0, 64);
  if (trustTunnelHeader) {
    const claimed = request.headers["cf-connecting-ip"];
    const source = typeof claimed === "string" ? sourceFromAddress(claimed.trim()) : undefined;
    if (source) return source;
  }
  return LOCAL_SOURCE;
}

export interface WindowLimiterOptions {
  /** Hits allowed per key in one window. */
  max: number;
  windowMs: number;
  /** Keys remembered at most (default `MAX_LIMITER_KEYS`). */
  maxKeys?: number;
  /** Milliseconds on a clock that never goes back (default: `performance.now`), so a clock change cannot extend a block. */
  now?: () => number;
}

export interface LimitVerdict {
  allowed: boolean;
  /** When refused: how long until the key's window is over. */
  retryAfterMs: number;
}

/** A fixed window per key, in memory. The window starts at the key's first hit and a refused hit does not extend it. */
export class WindowLimiter {
  /** Oldest window first: expired windows are always a prefix. */
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: WindowLimiterOptions) {
    this.max = options.max;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? MAX_LIMITER_KEYS;
    this.now = options.now ?? (() => performance.now());
  }

  get size(): number {
    return this.windows.size;
  }

  /** Count one hit for the key. The hit that would pass `max` is refused. */
  hit(key: string): LimitVerdict {
    const now = this.now();
    let window = this.windows.get(key);
    if (window && now - window.start >= this.windowMs) {
      this.windows.delete(key);
      window = undefined;
    }
    if (!window) {
      this.makeRoom(now);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.max) return { allowed: false, retryAfterMs: Math.max(1, window.start + this.windowMs - now) };
    window.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Forget the key (after a success). */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Expired windows go first, then the oldest live ones: the map never holds more than `maxKeys` keys. */
  private makeRoom(now: number): void {
    if (this.windows.size < this.maxKeys) return;
    for (const [key, window] of this.windows) {
      if (now - window.start < this.windowMs) break;
      this.windows.delete(key);
    }
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }
}

/** At most `max` slots per key at a time. Keys that hold nothing are forgotten, so the map only holds what is in flight. */
export class ConcurrencyLimiter {
  private readonly held = new Map<string, number>();

  constructor(private readonly max: number) {}

  get size(): number {
    return this.held.size;
  }

  /** Take a slot: the function that gives it back (once), or `undefined` when the key already holds `max`. */
  enter(key: string): (() => void) | undefined {
    const count = this.held.get(key) ?? 0;
    if (count >= this.max) return undefined;
    this.held.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.held.get(key) ?? 1) - 1;
      if (remaining <= 0) this.held.delete(key);
      else this.held.set(key, remaining);
    };
  }
}

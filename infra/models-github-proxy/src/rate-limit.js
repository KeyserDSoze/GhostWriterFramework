/**
 * Fixed-window request counter per key, kept in the memory of the isolate that runs it.
 * It is forgotten when the isolate is recycled and is not shared between isolates or
 * data centres, so it dampens abuse; it is not a guarantee.
 */
export function createRateLimiter({ windowMs, maxRequests, maxTracked, now = () => Date.now() }) {
  const entries = new Map();

  // Drop what has expired; if every entry is still fresh, forget the oldest ones.
  function makeRoom(currentTime) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= currentTime) entries.delete(key);
    }
    while (entries.size >= maxTracked) {
      entries.delete(entries.keys().next().value);
    }
  }

  return {
    check(key) {
      const currentTime = now();
      let entry = entries.get(key);
      if (!entry || entry.resetAt <= currentTime) {
        entries.delete(key);
        if (entries.size >= maxTracked) makeRoom(currentTime);
        entry = { count: 0, resetAt: currentTime + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      if (entry.count > maxRequests) {
        return { limited: true, retryAfter: Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000)) };
      }
      return { limited: false, retryAfter: 0 };
    },
    size() {
      return entries.size;
    },
  };
}

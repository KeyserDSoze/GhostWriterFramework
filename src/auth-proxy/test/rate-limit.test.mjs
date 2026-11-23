import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRateLimiter } from "../src/rate-limit.js";

function makeLimiter(overrides = {}) {
  let time = 1_000_000;
  const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 3, maxTracked: 100, now: () => time, ...overrides });
  return {
    limiter,
    advance(ms) {
      time += ms;
    },
  };
}

describe("fixed-window rate limiter", () => {
  it("allows up to maxRequests per window and limits the next request", () => {
    const { limiter } = makeLimiter();
    for (let index = 0; index < 3; index += 1) {
      assert.deepEqual(limiter.check("203.0.113.1"), { limited: false, retryAfter: 0 });
    }
    assert.equal(limiter.check("203.0.113.1").limited, true);
    assert.equal(limiter.check("203.0.113.1").limited, true);
  });

  it("reports Retry-After as the remaining seconds of the window, rounded up, never below 1", () => {
    const { limiter, advance } = makeLimiter();
    for (let index = 0; index < 3; index += 1) limiter.check("a");
    assert.equal(limiter.check("a").retryAfter, 60);
    advance(20_000);
    assert.equal(limiter.check("a").retryAfter, 40);
    advance(39_001);
    assert.equal(limiter.check("a").retryAfter, 1);
  });

  it("keeps an independent budget per key", () => {
    const { limiter } = makeLimiter();
    for (let index = 0; index < 4; index += 1) limiter.check("a");
    assert.equal(limiter.check("a").limited, true);
    assert.equal(limiter.check("b").limited, false);
  });

  it("does not extend the window while a caller keeps hammering", () => {
    const { limiter, advance } = makeLimiter();
    for (let index = 0; index < 3; index += 1) limiter.check("a");
    for (let second = 0; second < 59; second += 1) {
      advance(1_000);
      assert.equal(limiter.check("a").limited, true);
    }
    advance(1_000);
    assert.equal(limiter.check("a").limited, false);
  });

  it("starts a new window once the previous one has elapsed", () => {
    const { limiter, advance } = makeLimiter();
    for (let index = 0; index < 4; index += 1) limiter.check("a");
    advance(60_000);
    assert.deepEqual(limiter.check("a"), { limited: false, retryAfter: 0 });
  });

  it("bounds its memory: expired entries go first, then the oldest", () => {
    const { limiter, advance } = makeLimiter({ maxTracked: 3 });
    for (const key of ["a", "b", "c"]) limiter.check(key);
    assert.equal(limiter.size(), 3);

    advance(60_000);
    limiter.check("d");
    assert.equal(limiter.size(), 1, "all expired entries are dropped when the table is full");

    for (const key of ["e", "f", "g", "h", "i"]) limiter.check(key);
    assert.ok(limiter.size() <= 3, `holds ${limiter.size()} entries with maxTracked = 3`);
  });

  it("forgets the oldest address, not the newest, when every entry is still fresh", () => {
    const { limiter } = makeLimiter({ maxTracked: 2, maxRequests: 1 });
    limiter.check("old");
    limiter.check("mid");
    limiter.check("new");
    assert.equal(limiter.check("new").limited, true, "the newest address keeps its count");
    assert.equal(limiter.check("old").limited, false, "the oldest address was forgotten");
  });

  it("reads the clock at call time, so Date.now can be stubbed", (t) => {
    let now = 5_000;
    t.mock.method(Date, "now", () => now);
    const limiter = createRateLimiter({ windowMs: 1_000, maxRequests: 1, maxTracked: 10 });
    limiter.check("a");
    assert.equal(limiter.check("a").limited, true);
    now += 1_000;
    assert.equal(limiter.check("a").limited, false);
  });
});

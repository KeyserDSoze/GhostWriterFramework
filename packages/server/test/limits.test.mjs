import test from "node:test";
import assert from "node:assert/strict";
// The module is read through the namespace, so a missing export fails the test that needs it and nothing else.
import * as testing from "../dist/testing.mjs";

/** What `sourceOf` needs of an HTTP request: the TCP peer and the headers. */
const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
const CLOUDFLARE = "cf-connecting-ip";

test("C6: sourceOf - behind the tunnel the source is the address Cloudflare reports, otherwise the TCP peer", () => {
  const { sourceOf, LOCAL_SOURCE } = testing;
  assert.equal(LOCAL_SOURCE, "local");
  // The tunnel connects from the loopback interface and the owner configured a public address: believe the header.
  assert.equal(sourceOf(request("127.0.0.1", { [CLOUDFLARE]: "203.0.113.7" }), true), "203.0.113.7");
  assert.equal(sourceOf(request("::1", { [CLOUDFLARE]: "203.0.113.7" }), true), "203.0.113.7");
  assert.equal(sourceOf(request("::ffff:127.0.0.1", { [CLOUDFLARE]: "203.0.113.7" }), true), "203.0.113.7");
  assert.equal(sourceOf(request("127.8.9.10", { [CLOUDFLARE]: "203.0.113.7" }), true), "203.0.113.7", "all of 127.0.0.0/8 is this computer");
  assert.equal(sourceOf(request("127.0.0.1", { [CLOUDFLARE]: "  203.0.113.7  " }), true), "203.0.113.7", "surrounding spaces are not part of the address");
  // Loopback without the header (the local CLI, the owner's browser) is the single source "local", whatever the option says.
  assert.equal(sourceOf(request("127.0.0.1"), true), "local");
  assert.equal(sourceOf(request("127.0.0.1"), false), "local");
  assert.equal(sourceOf(request("::1"), true), "local");
});

test("C6: sourceOf - the header is ignored when no public address is configured", () => {
  const { sourceOf } = testing;
  assert.equal(sourceOf(request("127.0.0.1", { [CLOUDFLARE]: "203.0.113.7" }), false), "local");
  assert.equal(sourceOf(request("::1", { [CLOUDFLARE]: "2001:db8::1" }), false), "local");
});

test("C6: sourceOf - a header sent by a peer that is not loopback is never believed", () => {
  const { sourceOf } = testing;
  assert.equal(sourceOf(request("198.51.100.20", { [CLOUDFLARE]: "203.0.113.7" }), true), "198.51.100.20");
  assert.equal(sourceOf(request("10.0.0.5", { [CLOUDFLARE]: "127.0.0.1" }), true), "10.0.0.5");
  assert.equal(sourceOf(request("::ffff:198.51.100.20", { [CLOUDFLARE]: "203.0.113.7" }), true), "198.51.100.20");
  assert.equal(sourceOf(request("2001:db8:aaaa:bbbb:1:2:3:4", { [CLOUDFLARE]: "203.0.113.7" }), true), "2001:db8:aaaa:bbbb::/64");
  assert.equal(sourceOf(request("198.51.100.20", { [CLOUDFLARE]: "203.0.113.7" }), false), "198.51.100.20");
  assert.equal(sourceOf(request(undefined), true), "unknown", "a socket that is already gone");
});

test("C6: sourceOf - anything that is not an IP address in the header falls back to the loopback source", () => {
  const { sourceOf } = testing;
  const garbage = [
    "", " ", "unknown", "not-an-ip", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.4:443", "[2001:db8::1]", "2001:db8::1/64",
    "1.2.3.4, 5.6.7.8", "1.2.3.4\n5.6.7.8", "0x7f.0.0.1", "203.0.113.7;drop table", "localhost", "::g", "1:2:3:4:5:6:7:8:9", "a".repeat(5000),
  ];
  for (const value of garbage) assert.equal(sourceOf(request("127.0.0.1", { [CLOUDFLARE]: value }), true), "local", JSON.stringify(value.slice(0, 40)));
  // A header that repeats arrives as an array on some runtimes: it is not one address.
  assert.equal(sourceOf(request("127.0.0.1", { [CLOUDFLARE]: ["203.0.113.7", "198.51.100.1"] }), true), "local");
  assert.equal(sourceOf(request("127.0.0.1", { "x-forwarded-for": "203.0.113.7", "true-client-ip": "203.0.113.7" }), true), "local", "only the header Cloudflare overwrites counts");
});

test("C6: sourceOf - IPv6 clients are limited as a whole /64, and IPv4-mapped addresses are plain IPv4", () => {
  const { sourceOf } = testing;
  const from = (address) => sourceOf(request("127.0.0.1", { [CLOUDFLARE]: address }), true);
  assert.equal(from("2001:DB8:abcd:12::7"), "2001:db8:abcd:12::/64");
  assert.equal(from("2001:db8:abcd:12:ffff:eeee:dddd:cccc"), "2001:db8:abcd:12::/64", "every address of the /64 is the same source");
  assert.equal(from("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(from("2001:db8:0:0:0:0:0:1"), "2001:db8:0:0::/64", "the long and the short form agree");
  assert.notEqual(from("2001:db8:abcd:13::7"), from("2001:db8:abcd:12::7"), "another /64 is another source");
  assert.equal(from("::ffff:203.0.113.5"), "203.0.113.5");
  assert.equal(from("203.0.113.5"), "203.0.113.5");
});

test("C6: WindowLimiter - a fixed window per key; a refused hit says when the window ends and does not extend it", () => {
  const { WindowLimiter } = testing;
  let now = 1_000;
  const limiter = new WindowLimiter({ max: 3, windowMs: 60_000, now: () => now });
  assert.deepEqual([1, 2, 3].map(() => limiter.hit("a").allowed), [true, true, true]);
  const refused = limiter.hit("a");
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterMs, 60_000);
  now += 10_000;
  assert.deepEqual({ allowed: limiter.hit("a").allowed, retryAfterMs: limiter.hit("a").retryAfterMs }, { allowed: false, retryAfterMs: 50_000 }, "refused hits never push the end of the window");
  assert.equal(limiter.hit("b").allowed, true, "another key has its own budget");
  now += 50_000;
  assert.equal(limiter.hit("a").allowed, true, "a new window starts when the old one is over");
  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, false);
});

test("C6: WindowLimiter - reset forgets a key (a success), and only that key", () => {
  const { WindowLimiter } = testing;
  const limiter = new WindowLimiter({ max: 2, windowMs: 60_000, now: () => 0 });
  limiter.hit("a");
  limiter.hit("a");
  limiter.hit("b");
  limiter.hit("b");
  assert.equal(limiter.hit("a").allowed, false);
  limiter.reset("a");
  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("b").allowed, false, "the other key keeps its count");
  limiter.reset("never-seen");
});

test("C6: WindowLimiter - memory stays bounded: expired keys go first, then the oldest, and recent keys are kept", () => {
  const { WindowLimiter } = testing;
  let now = 0;
  const bounded = new WindowLimiter({ max: 1, windowMs: 1_000, maxKeys: 10, now: () => now });
  for (let index = 0; index < 500; index += 1) {
    now += 1;
    bounded.hit(`source-${index}`);
    assert.ok(bounded.size <= 10, `size ${bounded.size} after ${index + 1} keys`);
  }
  assert.equal(bounded.hit("source-499").allowed, false, "the newest key is still remembered");
  assert.equal(bounded.hit("source-0").allowed, true, "the oldest was evicted and starts again");

  const aging = new WindowLimiter({ max: 5, windowMs: 1_000, maxKeys: 4, now: () => now });
  now = 0;
  aging.hit("a");
  now = 10;
  aging.hit("b");
  now = 5_000;
  for (const key of ["c", "d", "e"]) aging.hit(key);
  assert.equal(aging.size, 3, "the two expired windows were dropped before anything alive");
  aging.hit("f");
  assert.equal(aging.size, 4);
  aging.hit("g");
  assert.equal(aging.size, 4, "now the oldest live window makes room");

  // The default bound is generous (about ten thousand keys) but it is a bound.
  const unbounded = new WindowLimiter({ max: 1, windowMs: 60_000, now: () => 0 });
  for (let index = 0; index < 25_000; index += 1) unbounded.hit(`k${index}`);
  assert.ok(unbounded.size <= 10_000, `default bound: ${unbounded.size}`);
  assert.ok(unbounded.size >= 5_000, "and not absurdly small");
});

test("C6: ConcurrencyLimiter - at most `max` slots per key, freed by their release function, never twice", () => {
  const { ConcurrencyLimiter } = testing;
  const limiter = new ConcurrencyLimiter(2);
  const first = limiter.enter("a");
  const second = limiter.enter("a");
  assert.equal(typeof first, "function");
  assert.equal(typeof second, "function");
  assert.equal(limiter.enter("a"), undefined, "the third caller of one key is refused");
  assert.equal(typeof limiter.enter("b"), "function", "another key has its own slots");
  first();
  first();
  assert.equal(typeof limiter.enter("a"), "function", "a freed slot is reusable");
  assert.equal(limiter.enter("a"), undefined, "a release that is called twice frees one slot, not two");
  second();
  assert.equal(typeof limiter.enter("a"), "function");
});

test("C6: ConcurrencyLimiter - keys that hold nothing are forgotten", () => {
  const { ConcurrencyLimiter } = testing;
  const limiter = new ConcurrencyLimiter(1);
  const releases = Array.from({ length: 1000 }, (_, index) => limiter.enter(`source-${index}`));
  assert.equal(limiter.size, 1000);
  for (const release of releases) release();
  assert.equal(limiter.size, 0);
});

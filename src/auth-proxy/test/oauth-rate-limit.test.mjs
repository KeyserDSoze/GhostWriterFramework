import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS } from "../src/oauth.js";
import {
  ALLOWED_ORIGIN,
  CLIENT_SECRETS,
  OAUTH_ROUTES,
  assertError,
  assertNoneOf,
  headerText,
  nextAddress,
  oauthCall,
  useProviderStub,
} from "./helpers.mjs";

const provider = useProviderStub();

const [, GOOGLE_REFRESH, , , , MICROSOFT_REVOKE] = OAUTH_ROUTES;

// Microsoft's revoke route answers without any provider call: the cheapest way to spend budget.
const spend = (address, route = MICROSOFT_REVOKE) => oauthCall(route.path, { json: route.request, address });

describe("OAuth broker: rate limit (best effort, per cf-connecting-ip)", () => {
  it("documents its limits: 30 requests per 60 second window per address", () => {
    assert.equal(RATE_LIMIT_MAX_REQUESTS, 30);
    assert.equal(RATE_LIMIT_WINDOW_MS, 60_000);
  });

  it("answers 429 rate_limited with Retry-After once an address exceeds the limit", async () => {
    const address = nextAddress();
    for (let index = 1; index <= RATE_LIMIT_MAX_REQUESTS; index += 1) {
      const response = await spend(address);
      assert.equal(response.status, 204, `request ${index}`);
    }
    const limited = await spend(address);
    const body = await assertError(limited, 429, "rate_limited");
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= RATE_LIMIT_WINDOW_MS / 1000, `Retry-After ${retryAfter}`);
    assert.equal(limited.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.match(limited.headers.get("access-control-expose-headers") ?? "", /Retry-After/i);
    assertNoneOf(`${JSON.stringify(body)}\n${headerText(limited)}`, CLIENT_SECRETS, "the 429 answer");
  });

  it("does not call a provider for a limited request", async () => {
    provider.reply(GOOGLE_REFRESH.reply);
    const address = nextAddress();
    for (let index = 0; index < RATE_LIMIT_MAX_REQUESTS + 5; index += 1) {
      await spend(address, GOOGLE_REFRESH);
    }
    assert.equal(provider.calls.length, RATE_LIMIT_MAX_REQUESTS);
  });

  it("keeps a separate budget for every address", async () => {
    const busy = nextAddress();
    for (let index = 0; index <= RATE_LIMIT_MAX_REQUESTS; index += 1) await spend(busy);
    assert.equal((await spend(busy)).status, 429);
    assert.equal((await spend(nextAddress())).status, 204);
  });

  it("counts every provider route and invalid requests against the same budget", async () => {
    provider.reply(GOOGLE_REFRESH.reply);
    const address = nextAddress();
    for (let index = 0; index < RATE_LIMIT_MAX_REQUESTS; index += 1) {
      if (index % 3 === 0) await oauthCall(GOOGLE_REFRESH.path, { json: {}, address });
      else if (index % 3 === 1) await spend(address, GOOGLE_REFRESH);
      else await spend(address);
    }
    await assertError(await spend(address), 429, "rate_limited");
  });

  it("starts a fresh window once the previous one has elapsed", async (t) => {
    let now = 5_000_000;
    t.mock.method(Date, "now", () => now);
    const address = nextAddress();
    for (let index = 0; index < RATE_LIMIT_MAX_REQUESTS; index += 1) await spend(address);
    await assertError(await spend(address), 429, "rate_limited");

    now += 20_000;
    const stillLimited = await spend(address);
    await assertError(stillLimited, 429, "rate_limited");
    assert.equal(stillLimited.headers.get("retry-after"), "40");

    now += RATE_LIMIT_WINDOW_MS;
    assert.equal((await spend(address)).status, 204);
  });

  it("never limits a request that carries no cf-connecting-ip", async () => {
    for (let index = 0; index < RATE_LIMIT_MAX_REQUESTS * 3; index += 1) {
      const response = await spend(null);
      assert.equal(response.status, 204, `request ${index + 1}`);
    }
  });

  it("does not count preflights, status checks or requests from refused origins", async () => {
    const address = nextAddress();
    for (let index = 0; index < RATE_LIMIT_MAX_REQUESTS * 2; index += 1) {
      await oauthCall(MICROSOFT_REVOKE.path, { method: "OPTIONS", address });
      await oauthCall("/oauth/status", { method: "GET", address });
      const refused = await oauthCall(MICROSOFT_REVOKE.path, { json: MICROSOFT_REVOKE.request, address, origin: "https://evil.example" });
      assert.equal(refused.status, 403);
    }
    for (let index = 0; index < RATE_LIMIT_MAX_REQUESTS; index += 1) {
      assert.equal((await spend(address)).status, 204, `request ${index + 1}`);
    }
  });
});

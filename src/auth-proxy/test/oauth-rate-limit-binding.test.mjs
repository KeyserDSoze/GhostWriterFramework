import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RATE_LIMIT_BINDING } from "../src/oauth.js";
import {
  ALLOWED_ORIGIN,
  CLIENT_SECRETS,
  OAUTH_ROUTES,
  assertError,
  assertNoneOf,
  captureConsole,
  configuredEnv,
  headerText,
  nextAddress,
  oauthCall,
  useProviderStub,
} from "./helpers.mjs";

useProviderStub();

// Microsoft's revoke route answers without any provider call.
const MICROSOFT_REVOKE = OAUTH_ROUTES.find((route) => route.label === "microsoft revoke");

/** A stand-in for the Workers Rate Limiting binding: allows `allowed` calls per key, then refuses. */
function fakeBinding({ allowed = Infinity, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async limit(options) {
      calls.push(options);
      if (fail) throw new Error(`binding failed for ${options.key}`);
      const count = calls.filter((call) => call.key === options.key).length;
      return { success: count <= allowed };
    },
  };
}

const spend = (env, address = nextAddress()) => oauthCall(MICROSOFT_REVOKE.path, { json: MICROSOFT_REVOKE.request, address }, env);

describe("OAuth broker: optional Workers Rate Limiting binding", () => {
  it("is named OAUTH_RATE_LIMITER, as declared in wrangler.toml", () => {
    assert.equal(RATE_LIMIT_BINDING, "OAUTH_RATE_LIMITER");
  });

  it("works exactly as before when there is no binding", async () => {
    for (const env of [configuredEnv(), configuredEnv({ [RATE_LIMIT_BINDING]: undefined }), configuredEnv({ [RATE_LIMIT_BINDING]: null })]) {
      assert.equal((await spend(env)).status, 204);
    }
  });

  it("ignores a binding that is not usable", async () => {
    for (const value of ["yes", 1, {}, { limit: "no" }]) {
      assert.equal((await spend(configuredEnv({ [RATE_LIMIT_BINDING]: value }))).status, 204, JSON.stringify(value));
    }
  });

  it("asks the binding once per POST, keyed by the caller's address", async () => {
    const binding = fakeBinding();
    const env = configuredEnv({ [RATE_LIMIT_BINDING]: binding });
    const address = nextAddress();
    assert.equal((await spend(env, address)).status, 204);
    assert.equal((await spend(env, address)).status, 204);
    assert.deepEqual(binding.calls, [{ key: address }, { key: address }]);
  });

  it("answers 429 rate_limited with Retry-After when the binding refuses, without calling a provider", async () => {
    const binding = fakeBinding({ allowed: 0 });
    const env = configuredEnv({ [RATE_LIMIT_BINDING]: binding });
    const limited = await spend(env);
    const body = await assertError(limited, 429, "rate_limited");
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter}`);
    assert.equal(limited.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assertNoneOf(`${JSON.stringify(body)}\n${headerText(limited)}`, CLIENT_SECRETS, "the 429 answer");
  });

  it("limits each address on its own", async () => {
    const binding = fakeBinding({ allowed: 2 });
    const env = configuredEnv({ [RATE_LIMIT_BINDING]: binding });
    const busy = nextAddress();
    assert.equal((await spend(env, busy)).status, 204);
    assert.equal((await spend(env, busy)).status, 204);
    assert.equal((await spend(env, busy)).status, 429);
    assert.equal((await spend(env, nextAddress())).status, 204);
  });

  it("lets the request through when the binding throws, and never logs or echoes the failure", async (t) => {
    const output = captureConsole(t);
    const env = configuredEnv({ [RATE_LIMIT_BINDING]: fakeBinding({ fail: true }) });
    const response = await spend(env);
    assert.equal(response.status, 204);
    assert.deepEqual(output.lines, []);
  });

  it("is not asked for status checks, preflights, refused origins, bad routes or callers without an address", async () => {
    const binding = fakeBinding();
    const env = configuredEnv({ [RATE_LIMIT_BINDING]: binding });
    await oauthCall("/oauth/status", { method: "GET" }, env);
    await oauthCall(MICROSOFT_REVOKE.path, { method: "OPTIONS" }, env);
    await oauthCall(MICROSOFT_REVOKE.path, { json: MICROSOFT_REVOKE.request, origin: "https://evil.example" }, env);
    await oauthCall("/oauth/unknown", { json: {} }, env);
    await oauthCall(MICROSOFT_REVOKE.path, { method: "GET" }, env);
    await oauthCall(MICROSOFT_REVOKE.path, { json: MICROSOFT_REVOKE.request, address: null }, env);
    assert.deepEqual(binding.calls, []);
  });

  it("is asked after the in-memory limit, which therefore still protects when the binding allows everything", async () => {
    const binding = fakeBinding();
    const env = configuredEnv({ [RATE_LIMIT_BINDING]: binding });
    const address = nextAddress();
    for (let index = 0; index < 30; index += 1) assert.equal((await spend(env, address)).status, 204);
    await assertError(await spend(env, address), 429, "rate_limited");
    assert.equal(binding.calls.length, 30, "the 31st request is refused before the binding is asked");
  });

  it("counts invalid requests too, as the in-memory limit does", async () => {
    const binding = fakeBinding();
    const env = configuredEnv({ [RATE_LIMIT_BINDING]: binding });
    const response = await oauthCall(MICROSOFT_REVOKE.path, { json: {} }, env);
    assert.equal(response.status, 400);
    assert.equal(binding.calls.length, 1);
  });
});

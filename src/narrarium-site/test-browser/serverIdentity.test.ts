import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NarrariumServerClient, ServerRequestError } from "narrarium-engine";
import { ServerAddressError } from "@/autopilot/serverAddress";
import { ServerIdentityError, forgetServerVerification, probeServerIdentity, verifiedClient, verifiedServer, verifiedServerInfo } from "@/autopilot/serverIdentity";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type PersonalServerSettings } from "@/types/settings";
import { createFakeIdentity, createFakeNetwork, type FakeIdentity } from "./helpers/fakePersonalServer";

const ORIGIN = "http://127.0.0.1:24242";
const TOKEN = "nrs_shared_client_token";

let identity: FakeIdentity;
let other: FakeIdentity;

function connection(patch: Partial<PersonalServerSettings> = {}): PersonalServerSettings {
  return { url: ORIGIN, token: TOKEN, serverId: identity.serverId, fingerprint: identity.fingerprint, ...patch };
}

beforeEach(async () => {
  forgetServerVerification();
  identity = await createFakeIdentity();
  other = await createFakeIdentity();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("verifiedServerInfo", () => {
  it("exposes that the signature was verified, with the fingerprint", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    const result = await verifiedServerInfo(new NarrariumServerClient({ baseUrl: ORIGIN, token: "", fetch: network.fetch }), identity.fingerprint);
    expect(result).toMatchObject({ verified: true, fingerprint: identity.fingerprint });
    expect(result.info.serverId).toBe(identity.serverId);
    expect(network.authenticated()).toHaveLength(0);
  });

  it("refuses another key than the pinned one, an unsigned answer and a forged signature", async () => {
    const changed = createFakeNetwork({ [ORIGIN]: { identity: other, token: TOKEN } });
    await expect(verifiedServerInfo(new NarrariumServerClient({ baseUrl: ORIGIN, token: "", fetch: changed.fetch }), identity.fingerprint)).rejects.toMatchObject({ name: "ServerIdentityError", reason: "changed" });

    const unsigned = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN, unsigned: true } });
    await expect(verifiedServerInfo(new NarrariumServerClient({ baseUrl: ORIGIN, token: "", fetch: unsigned.fetch }), identity.fingerprint)).rejects.toMatchObject({ reason: "invalid" });

    const forged = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN, forgeWith: other } });
    await expect(verifiedServerInfo(new NarrariumServerClient({ baseUrl: ORIGIN, token: "", fetch: forged.fetch }), identity.fingerprint)).rejects.toMatchObject({ reason: "invalid" });
  });

  it("reports a browser that cannot check Ed25519 as not verified instead of trusting the public fingerprint", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    vi.spyOn(crypto.subtle, "importKey").mockRejectedValue(new Error("Unrecognized algorithm name"));
    const result = await verifiedServerInfo(new NarrariumServerClient({ baseUrl: ORIGIN, token: "", fetch: network.fetch }), identity.fingerprint);
    expect(result.verified).toBe(false);
  });

  it("lets an unreachable server surface as a request error, not as an identity failure", async () => {
    const network = createFakeNetwork({});
    await expect(verifiedServerInfo(new NarrariumServerClient({ baseUrl: ORIGIN, token: "", fetch: network.fetch }))).rejects.toBeInstanceOf(ServerRequestError);
  });
});

describe("verifiedServer", () => {
  it("returns a client only after the pinned server signed a fresh nonce, and the token reaches that server only", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    const { client, info, fingerprint } = await verifiedServer({ connection: connection(), fetch: network.fetch });
    expect(fingerprint).toBe(identity.fingerprint);
    expect(info.serverId).toBe(identity.serverId);
    expect(network.requests).toHaveLength(1);
    expect(network.requests[0]).toMatchObject({ path: "/api/v1/info", authorization: null });
    expect(network.requests[0].url).toMatch(/nonce=[0-9a-f]{64}$/);

    await expect(client.session()).resolves.toMatchObject({ clientLabel: "Test device" });
    expect(network.authenticated().map((request) => [request.origin, request.authorization])).toEqual([[ORIGIN, `Bearer ${TOKEN}`]]);
  });

  it("uses a different nonce for every verification", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    await verifiedServer({ connection: connection(), fetch: network.fetch, fresh: true });
    await verifiedServer({ connection: connection(), fetch: network.fetch, fresh: true });
    const nonces = network.infoProbes().map((request) => new URL(request.url).searchParams.get("nonce"));
    expect(new Set(nonces).size).toBe(2);
  });

  it("refuses, before any request, when no fingerprint is pinned yet", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    await expect(verifiedServer({ connection: connection({ fingerprint: undefined }), fetch: network.fetch })).rejects.toMatchObject({ name: "ServerIdentityError", reason: "unpinned" });
    expect(network.requests).toHaveLength(0);
  });

  it("refuses a server with another identity and never sends it the token", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity: other, token: TOKEN } });
    await expect(verifiedServer({ connection: connection(), fetch: network.fetch })).rejects.toMatchObject({ reason: "changed" });
    expect(network.authenticated()).toHaveLength(0);
  });

  it("refuses a server that cannot prove its identity and never sends it the token", async () => {
    const unsigned = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN, unsigned: true } });
    await expect(verifiedServer({ connection: connection(), fetch: unsigned.fetch })).rejects.toMatchObject({ reason: "invalid" });
    expect(unsigned.authenticated()).toHaveLength(0);

    const forged = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN, forgeWith: other } });
    await expect(verifiedServer({ connection: connection(), fetch: forged.fetch })).rejects.toMatchObject({ reason: "invalid" });
    expect(forged.authenticated()).toHaveLength(0);
  });

  it("refuses a browser that cannot verify the signature, even when the public fingerprint matches", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    vi.spyOn(crypto.subtle, "importKey").mockRejectedValue(new Error("Unrecognized algorithm name"));
    await expect(verifiedServer({ connection: connection(), fetch: network.fetch })).rejects.toMatchObject({ reason: "unsupported" });
    expect(network.authenticated()).toHaveLength(0);
  });

  it("refuses an unusable address with a typed error and sends nothing", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    for (const [url, reason] of [["http://", "invalid"], ["http://example.com", "insecure"], ["https://user:pw@example.com", "credentials"], ["", "empty"]] as const) {
      await expect(verifiedServer({ connection: connection({ url }), fetch: network.fetch })).rejects.toEqual(expect.objectContaining({ name: "ServerAddressError", reason }));
    }
    expect(network.requests).toHaveLength(0);
  });

  it("never sends the token to an address that is only being typed", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    for (const prefix of ["https://h", "https://ht", "http://0.0.0.1", "https://my-server.exa", "http://127.0.0.1:2424"]) {
      await verifiedClient({ connection: connection({ url: prefix }), fetch: network.fetch }).catch(() => undefined);
    }
    expect(network.authenticated()).toHaveLength(0);
  });

  it("verifies once per address and fingerprint for 60 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T10:00:00.000Z"));
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    await verifiedClient({ connection: connection(), fetch: network.fetch });
    vi.setSystemTime(new Date("2026-11-21T10:00:59.000Z"));
    await verifiedClient({ connection: connection(), fetch: network.fetch });
    expect(network.infoProbes()).toHaveLength(1);

    vi.setSystemTime(new Date("2026-11-21T10:01:01.000Z"));
    await verifiedClient({ connection: connection(), fetch: network.fetch });
    expect(network.infoProbes()).toHaveLength(2);
  });

  it("does not reuse a verification for another address or another pinned fingerprint", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN }, "https://server.example.com": { identity, token: TOKEN } });
    await verifiedClient({ connection: connection(), fetch: network.fetch });
    await verifiedClient({ connection: connection({ url: "https://server.example.com" }), fetch: network.fetch });
    expect(network.infoProbes()).toHaveLength(2);

    await expect(verifiedClient({ connection: connection({ fingerprint: other.fingerprint }), fetch: network.fetch })).rejects.toMatchObject({ reason: "changed" });
    expect(network.infoProbes()).toHaveLength(3);
  });

  it("drops the verification after an HTTP error", async () => {
    const server = { identity, token: TOKEN, failWith: 500 as number | undefined };
    const network = createFakeNetwork({ [ORIGIN]: server });
    const client = await verifiedClient({ connection: connection(), fetch: network.fetch });
    await expect(client.session()).rejects.toMatchObject({ status: 500 });
    server.failWith = undefined;
    await verifiedClient({ connection: connection(), fetch: network.fetch });
    expect(network.infoProbes()).toHaveLength(2);
  });

  it("drops the verification after a network error", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    const flaky = await verifiedClient({ connection: connection(), fetch: async (input, init) => {
      if (String(input).includes("/session")) throw new TypeError("network down");
      return network.fetch(input, init);
    } });
    await expect(flaky.session()).rejects.toMatchObject({ code: "unreachable" });
    await verifiedClient({ connection: connection(), fetch: network.fetch });
    expect(network.infoProbes()).toHaveLength(2);
  });

  it("keeps the verification when the caller itself cancels a request", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN, hold: new Promise<void>(() => undefined) } });
    const controller = new AbortController();
    const client = await verifiedClient({ connection: connection(), fetch: network.fetch, signal: controller.signal });
    const pending = client.session();
    await vi.waitFor(() => expect(network.authenticated()).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await verifiedClient({ connection: connection(), fetch: network.fetch });
    expect(network.infoProbes()).toHaveLength(1);
  });

  it("cancels the requests of the client it returns when its signal aborts", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN, hold: new Promise<void>(() => undefined) } });
    const controller = new AbortController();
    const client = await verifiedClient({ connection: connection(), fetch: network.fetch, signal: controller.signal });
    const calls = [client.aiStatus(), client.session(), client.updates()].map((call) => call.catch((error: unknown) => error));
    await vi.waitFor(() => expect(network.authenticated()).toHaveLength(3));
    controller.abort();
    const results = await Promise.all(calls);
    expect(results.every((result) => result instanceof Error)).toBe(true);
    expect(network.authenticated().every((request) => request.signal?.aborted)).toBe(true);
  });

  it("stops before sending anything when the signal is already aborted", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    const controller = new AbortController();
    controller.abort();
    await expect(verifiedClient({ connection: connection(), fetch: network.fetch, signal: controller.signal })).rejects.toBeDefined();
    expect(network.authenticated()).toHaveLength(0);
  });

  it("still cancels requests in browsers without AbortSignal.any", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN, hold: new Promise<void>(() => undefined) } });
    const original = AbortSignal.any;
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true, writable: true });
    try {
      const controller = new AbortController();
      const client = await verifiedClient({ connection: connection(), fetch: network.fetch, signal: controller.signal });
      const pending = client.session().catch((error: unknown) => error);
      await vi.waitFor(() => expect(network.authenticated()).toHaveLength(1));
      controller.abort();
      expect(await pending).toBeInstanceOf(Error);
      expect(network.authenticated()[0].signal?.aborted).toBe(true);
    } finally {
      Object.defineProperty(AbortSignal, "any", { value: original, configurable: true, writable: true });
    }
  });

  it("reads the stored connection and its pinned fingerprint when none is given", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    vi.stubGlobal("fetch", network.fetch);
    try {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, personalServer: connection() } });
      await expect(verifiedClient()).resolves.toBeInstanceOf(NarrariumServerClient);
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, personalServer: connection({ fingerprint: other.fingerprint }) } });
      forgetServerVerification();
      await expect(verifiedClient()).rejects.toBeInstanceOf(ServerIdentityError);
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, personalServer: undefined } });
      await expect(verifiedClient()).rejects.toBeInstanceOf(ServerAddressError);
    } finally {
      vi.unstubAllGlobals();
      useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
    }
  });
});

describe("probeServerIdentity", () => {
  it("returns the identity to pin the first time, and refuses a different one afterwards", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    await expect(probeServerIdentity(ORIGIN, undefined, { fetch: network.fetch })).resolves.toMatchObject({ fingerprint: identity.fingerprint, info: { serverId: identity.serverId } });
    await expect(probeServerIdentity(ORIGIN, other.fingerprint, { fetch: network.fetch })).rejects.toMatchObject({ reason: "changed" });
    expect(network.authenticated()).toHaveLength(0);
  });

  it("refuses to pin a server whose signature this browser cannot check", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    vi.spyOn(crypto.subtle, "importKey").mockRejectedValue(new Error("Unrecognized algorithm name"));
    await expect(probeServerIdentity(ORIGIN, undefined, { fetch: network.fetch })).rejects.toMatchObject({ reason: "unsupported" });
  });

  it("lets a later verified call reuse what the probe just checked", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    await probeServerIdentity(ORIGIN, undefined, { fetch: network.fetch });
    await verifiedClient({ connection: connection(), fetch: network.fetch });
    expect(network.infoProbes()).toHaveLength(1);
  });
});

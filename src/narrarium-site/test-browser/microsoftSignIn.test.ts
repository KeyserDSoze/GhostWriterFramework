import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountEntityUtils, AuthorityType, ProtocolMode } from "@azure/msal-common";
import { ConnectFlowError } from "@/account/connectErrors";
import {
  MICROSOFT_CALLBACK_CHANNEL_PREFIX,
  MICROSOFT_CALLBACK_MESSAGE,
  beginMicrosoftSignIn,
  microsoftCallbackUrl,
  microsoftIdentityFromClientInfo,
  pkceChallenge,
  resetMicrosoftSignInForTests,
  type MicrosoftSignInSession,
} from "@/account/microsoftSignIn";
import { MICROSOFT_CLIENT_ID } from "@/config/publicClients";
import { SECRETS, createFakePopup, dispatchWindowMessage, spyOnConsole, type FakePopup } from "./oauthTestKit";

let popup: FakePopup;
let open: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  popup = createFakePopup();
  open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
});

afterEach(() => {
  resetMicrosoftSignInForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

interface Started { session: MicrosoftSignInSession; url: URL; state: string; challenge: string; settled: () => { kind: "pending" | "resolved" | "rejected"; value?: unknown } }

/** Starts a sign-in, waits until the popup was sent to Microsoft and reads what it was told. */
async function start(options: Parameters<typeof beginMicrosoftSignIn>[0] = {}): Promise<Started> {
  const session = beginMicrosoftSignIn(options);
  let outcome: { kind: "pending" | "resolved" | "rejected"; value?: unknown } = { kind: "pending" };
  session.result.then((value) => { outcome = { kind: "resolved", value }; }, (value: unknown) => { outcome = { kind: "rejected", value }; });
  await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalledTimes(1));
  const url = new URL(popup.location.replace.mock.calls[0][0] as string);
  return { session, url, state: url.searchParams.get("state")!, challenge: url.searchParams.get("code_challenge")!, settled: () => outcome };
}

const message = (state: string, extra: Record<string, unknown> = {}) => ({ type: MICROSOFT_CALLBACK_MESSAGE, state, code: SECRETS.code, ...extra });
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("PKCE", () => {
  it("computes the S256 challenge as RFC 7636 does (Appendix B)", async () => {
    await expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("uses a random verifier of at least 64 URL-safe characters and sends only its hash to Microsoft", async () => {
    const first = await start();
    first.session.cancel();
    await first.session.result.catch(() => undefined);
    popup.location.replace.mockClear();
    const second = await start();

    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.challenge).not.toBe(first.challenge);
    expect(second.state).not.toBe(first.state);

    dispatchWindowMessage(message(second.state), { source: popup });
    const authorization = await second.session.result;
    expect(authorization.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64,128}$/);
    expect(createHash("sha256").update(authorization.codeVerifier).digest("base64url")).toBe(second.challenge);
    expect(second.url.toString()).not.toContain(authorization.codeVerifier);
  });
});

describe("the authorization request", () => {
  it("is exactly the Microsoft authorization-code request the broker expects", async () => {
    const { url, state, challenge } = await start();

    expect(`${url.origin}${url.pathname}`).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: MICROSOFT_CLIENT_ID,
      response_type: "code",
      redirect_uri: "http://localhost:3000/auth/microsoft-callback.html",
      response_mode: "query",
      scope: "User.Read Files.ReadWrite offline_access openid profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
      client_info: "1",
    });
    expect(state.length).toBeGreaterThanOrEqual(22);
  });

  it("follows the base path the site is published under", () => {
    expect(microsoftCallbackUrl()).toBe("http://localhost:3000/auth/microsoft-callback.html");
    vi.stubEnv("BASE_URL", "/narrarium/");
    expect(microsoftCallbackUrl()).toBe("http://localhost:3000/narrarium/auth/microsoft-callback.html");
  });

  it("opens the window in the click itself, before anything is awaited, so no pop-up blocker objects", () => {
    const session = beginMicrosoftSignIn();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe("about:blank");
    expect(String(open.mock.calls[0][1])).toBeTruthy();
    expect(String(open.mock.calls[0][2])).toMatch(/width=\d+/);
    expect(String(open.mock.calls[0][2])).not.toMatch(/noopener|noreferrer/);
    session.cancel();
    return session.result.catch(() => undefined);
  });

  it("says so, without opening a window, when the browser has no WebCrypto", () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto), randomUUID: globalThis.crypto.randomUUID.bind(globalThis.crypto) });
    try {
      expect(() => beginMicrosoftSignIn()).toThrowError(expect.objectContaining({ code: "unsupported" }));
      expect(open).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a blocked pop-up as such", () => {
    open.mockReturnValue(null);
    expect(() => beginMicrosoftSignIn()).toThrowError(expect.objectContaining({ code: "popup_blocked" }));
    open.mockImplementation(() => { throw new Error("denied"); });
    expect(() => beginMicrosoftSignIn()).toThrowError(expect.objectContaining({ code: "popup_blocked" }));
  });
});

describe("the answer from the callback page", () => {
  it("hands over the code with the verifier and the redirect URI once the window it opened reports it", async () => {
    const { session, state } = await start();
    dispatchWindowMessage(message(state), { source: popup });
    await expect(session.result).resolves.toEqual({ code: SECRETS.code, codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{64,}$/), redirectUri: "http://localhost:3000/auth/microsoft-callback.html" });
    expect(popup.close).toHaveBeenCalled();
  });

  it("rejects a state that is not the one it sent, and never hands over the code", async () => {
    const { session } = await start();
    dispatchWindowMessage(message("some-other-state"), { source: popup });
    const failure = await session.result.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ConnectFlowError);
    expect(failure).toMatchObject({ code: "state_mismatch" });
    expect(JSON.stringify(failure)).not.toContain(SECRETS.code);
    expect(String((failure as Error).message)).not.toContain(SECRETS.code);
  });

  it("ignores a message from another origin, and carries on waiting", async () => {
    const { session, state, settled } = await start();
    dispatchWindowMessage(message(state), { source: popup, origin: "https://evil.example" });
    await flush();
    expect(settled().kind).toBe("pending");
    dispatchWindowMessage(message(state), { source: popup });
    await expect(session.result).resolves.toMatchObject({ code: SECRETS.code });
  });

  it.each([
    ["another window", () => ({ location: {}, close: vi.fn() })],
    ["no window at all", () => null],
    ["the page itself", () => window],
  ])("ignores a message that comes from %s, and carries on waiting", async (_label, source) => {
    const { session, state, settled } = await start();
    dispatchWindowMessage(message(state), { source: source() });
    await flush();
    expect(settled().kind).toBe("pending");
    dispatchWindowMessage(message(state), { source: popup });
    await expect(session.result).resolves.toMatchObject({ code: SECRETS.code });
  });

  it.each([
    ["is not an object", "hello"],
    ["is null", null],
    ["has another type", { type: "something-else", state: "x", code: "y" }],
    ["has no type", { state: "x", code: "y" }],
  ])("ignores a message that %s", async (_label, data) => {
    const { session, state, settled } = await start();
    dispatchWindowMessage(data, { source: popup });
    await flush();
    expect(settled().kind).toBe("pending");
    dispatchWindowMessage(message(state), { source: popup });
    await expect(session.result).resolves.toMatchObject({ code: SECRETS.code });
  });

  it("rejects an answer from the right window whose code is unusable", async () => {
    for (const code of ["", 5, "x".repeat(5000), "with space"]) {
      const { session, state } = await start();
      dispatchWindowMessage(message(state, { code }), { source: popup });
      await expect(session.result).rejects.toMatchObject({ code: "invalid_response" });
      resetMicrosoftSignInForTests();
      popup.location.replace.mockClear();
    }
  });

  it("treats access_denied as the user declining, and any other provider error as such", async () => {
    const denied = await start();
    dispatchWindowMessage({ type: MICROSOFT_CALLBACK_MESSAGE, state: denied.state, error: "access_denied" }, { source: popup });
    await expect(denied.session.result).rejects.toMatchObject({ code: "access_denied" });

    resetMicrosoftSignInForTests();
    popup.location.replace.mockClear();
    const refused = await start();
    dispatchWindowMessage({ type: MICROSOFT_CALLBACK_MESSAGE, state: refused.state, error: "invalid_scope" }, { source: popup });
    await expect(refused.session.result).rejects.toMatchObject({ code: "provider_error", providerError: "invalid_scope" });
  });

  it("never repeats a provider error that is not a plain error code", async () => {
    const { session, state } = await start();
    dispatchWindowMessage({ type: MICROSOFT_CALLBACK_MESSAGE, state, error: `<script>${SECRETS.code}</script>` }, { source: popup });
    const failure = await session.result.catch((cause: unknown) => cause) as ConnectFlowError;
    expect(failure.code).toBe("provider_error");
    expect(failure.providerError).toBeUndefined();
    expect(failure.message).not.toContain(SECRETS.code);
  });

  it("settles only once: a second message changes nothing", async () => {
    const { session, state } = await start();
    dispatchWindowMessage(message(state), { source: popup });
    const first = await session.result;
    dispatchWindowMessage(message(state, { code: "second" }), { source: popup });
    await flush();
    await expect(session.result).resolves.toBe(first);
  });

  it("also takes the answer on a BroadcastChannel named after the state, in case the browser cut the link to the opener", async () => {
    const { session, state } = await start();
    const channel = new BroadcastChannel(`${MICROSOFT_CALLBACK_CHANNEL_PREFIX}${state}`);
    channel.postMessage(message(state));
    channel.close();
    await expect(session.result).resolves.toMatchObject({ code: SECRETS.code });
  });

  it("checks the state on that channel as well", async () => {
    const { session, state } = await start();
    const channel = new BroadcastChannel(`${MICROSOFT_CALLBACK_CHANNEL_PREFIX}${state}`);
    channel.postMessage(message("forged"));
    channel.close();
    await expect(session.result).rejects.toMatchObject({ code: "state_mismatch" });
  });

  it("gives up after the time allowed and closes the window", async () => {
    vi.useFakeTimers();
    const session = beginMicrosoftSignIn({ timeoutMs: 1_000 });
    const failure = session.result.catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await failure).toMatchObject({ code: "timed_out" });
    expect(popup.close).toHaveBeenCalled();
  });

  it("can be cancelled, which closes the window and stops listening", async () => {
    const { session, state } = await start();
    session.cancel();
    await expect(session.result).rejects.toMatchObject({ code: "cancelled" });
    expect(popup.close).toHaveBeenCalled();
    dispatchWindowMessage(message(state), { source: popup });
    await flush();
    await expect(session.result).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancels the sign-in that was already waiting when a new one begins", async () => {
    const first = await start();
    popup.location.replace.mockClear();
    const second = beginMicrosoftSignIn();
    await expect(first.session.result).rejects.toMatchObject({ code: "cancelled" });
    second.cancel();
    await second.result.catch(() => undefined);
  });

  it("stays silent: no console output, and the verifier, state and code never leave through anything it logs", async () => {
    const spy = spyOnConsole();
    const { session, state } = await start();
    dispatchWindowMessage(message(state), { source: popup });
    await session.result;
    expect(spy.count()).toBe(0);
  });
});

describe("the account identity, which must be the one MSAL would build", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const samples = {
    "a personal Microsoft account": { uid: "00000000-0000-0000-4d3c-0f1e2a3b4c5d", utid: "9188040d-6c67-4c5b-b112-36a304b66dad" },
    "a work or school account": { uid: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42", utid: "72f988bf-86f1-41af-91ab-2d7cd011db47" },
    "a work account in an EU data boundary": { uid: "0c9d8e7f-6a5b-4c3d-9e2f-1a0b8c7d6e5f", utid: "e3b0c442-98fc-4c14-9afb-f4c8996fb924", xms_tdbr: "EU" },
  } as const;

  it("is <uid>.<utid> as the home account and the uid as the local account", () => {
    expect(microsoftIdentityFromClientInfo(encode(samples["a personal Microsoft account"]))).toEqual({
      homeAccountId: "00000000-0000-0000-4d3c-0f1e2a3b4c5d.9188040d-6c67-4c5b-b112-36a304b66dad",
      localAccountId: "00000000-0000-0000-4d3c-0f1e2a3b4c5d",
    });
    expect(microsoftIdentityFromClientInfo(encode(samples["a work or school account"]))).toEqual({
      homeAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42.72f988bf-86f1-41af-91ab-2d7cd011db47",
      localAccountId: "f2a1c5e0-3b7d-4a98-8c3e-5d1f0a9b7c42",
    });
  });

  it.each(Object.entries(samples))("is identical to what MSAL itself builds from client_info for %s", (_label, info) => {
    const raw = encode(info);
    const base64Decode = (input: string) => Buffer.from(input, "base64url").toString("utf8");
    const logger = { warning: () => undefined } as never;
    const homeAccountId = AccountEntityUtils.generateHomeAccountId(raw, AuthorityType.Default, logger, { base64Decode } as never, "correlation");
    const authority = { authorityType: AuthorityType.Default, protocolMode: ProtocolMode.AAD, getPreferredCache: () => "login.windows.net" };
    const entity = AccountEntityUtils.createAccountEntity({ homeAccountId, idTokenClaims: { sub: "pairwise-subject-that-is-not-the-account-id", oid: "object-id-that-is-not-it-either" } as never, clientInfo: raw }, authority as never, base64Decode);
    const account = AccountEntityUtils.getAccountInfo(entity);

    expect(microsoftIdentityFromClientInfo(raw)).toEqual({ homeAccountId: account.homeAccountId, localAccountId: account.localAccountId });
  });

  it("accepts base64url with or without padding, and plain base64", () => {
    const json = JSON.stringify({ uid: "a", utid: "b" });
    for (const raw of [Buffer.from(json).toString("base64url"), Buffer.from(json).toString("base64"), `${Buffer.from(json).toString("base64url")}==`]) {
      expect(microsoftIdentityFromClientInfo(raw)).toEqual({ homeAccountId: "a.b", localAccountId: "a" });
    }
  });

  it.each([
    ["is empty", ""],
    ["is not base64", "%%% not base64 %%%"],
    ["is not JSON", Buffer.from("hello").toString("base64url")],
    ["is a JSON list", encode(["a", "b"])],
    ["is a JSON string", encode("uid.utid")],
    ["has no uid", encode({ utid: "b" })],
    ["has no utid", encode({ uid: "a" })],
    ["has an empty uid", encode({ uid: "", utid: "b" })],
    ["has a uid that is not text", encode({ uid: 5, utid: "b" })],
    ["has an absurdly long uid", encode({ uid: "a".repeat(500), utid: "b" })],
  ])("refuses client_info that %s, instead of guessing an identity that could be another account's", (_label, raw) => {
    expect(() => microsoftIdentityFromClientInfo(raw)).toThrowError(expect.objectContaining({ code: "invalid_response" }));
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MICROSOFT_CALLBACK_CHANNEL_PREFIX, MICROSOFT_CALLBACK_MESSAGE, beginMicrosoftSignIn, resetMicrosoftSignInForTests } from "@/account/microsoftSignIn";
import { SECRETS, createFakePopup, dispatchWindowMessage, spyOnConsole, type FakePopup } from "./oauthTestKit";

const PAGE = "/auth/microsoft-callback.html";
const ORIGIN = "http://localhost:3000";
let closeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
});

afterEach(() => {
  delete (window as unknown as { opener?: unknown }).opener;
  window.history.replaceState(null, "", "/");
  resetMicrosoftSignInForTests();
});

/** Loads the callback page's script the way the browser would, on a page that Microsoft just redirected to. */
async function loadCallback(search: string, opener: { postMessage: (data: unknown, targetOrigin: string) => void } | null) {
  vi.resetModules();
  window.history.replaceState(null, "", `${PAGE}${search}`);
  Object.defineProperty(window, "opener", { configurable: true, value: opener });
  await import("@/microsoftCallback");
}

const query = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;

describe("the page Microsoft redirects the sign-in window to", () => {
  it("hands the code and the state to the window that opened it, aimed at the site's own origin only, then closes", async () => {
    const postMessage = vi.fn();
    await loadCallback(query({ code: SECRETS.code, state: "state-123", session_state: "ignored" }), { postMessage });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: MICROSOFT_CALLBACK_MESSAGE, code: SECRETS.code, state: "state-123" }, ORIGIN);
    expect(postMessage.mock.calls[0][1]).not.toBe("*");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("passes on only the error code when the user declined or Microsoft refused, never its description", async () => {
    const postMessage = vi.fn();
    await loadCallback(query({ error: "access_denied", error_description: `AADSTS65004: the user declined ${SECRETS.code}`, state: "state-123" }), { postMessage });

    expect(postMessage).toHaveBeenCalledWith({ type: MICROSOFT_CALLBACK_MESSAGE, error: "access_denied", state: "state-123" }, ORIGIN);
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain("AADSTS65004");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("takes the code out of the address bar, so it does not stay in the history", async () => {
    await loadCallback(query({ code: SECRETS.code, state: "state-123" }), { postMessage: vi.fn() });
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain(SECRETS.code);
    expect(window.location.pathname).toBe(PAGE);
  });

  it("also broadcasts on a channel named after the state, for browsers that cut the link to the opener", async () => {
    const listener = new BroadcastChannel(`${MICROSOFT_CALLBACK_CHANNEL_PREFIX}state-123`);
    const received = new Promise<unknown>((resolve) => { listener.onmessage = (event) => resolve(event.data); });
    await loadCallback(query({ code: SECRETS.code, state: "state-123" }), null);
    await expect(received).resolves.toEqual({ type: MICROSOFT_CALLBACK_MESSAGE, code: SECRETS.code, state: "state-123" });
    listener.close();
  });

  it("does not fail when the opener cannot be reached", async () => {
    const postMessage = vi.fn(() => { throw new DOMException("blocked", "SecurityError"); });
    await expect(loadCallback(query({ code: SECRETS.code, state: "state-123" }), { postMessage })).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no code and no error", query({ state: "state-123" })],
    ["no state", query({ code: SECRETS.code })],
    ["an empty code", query({ code: "", state: "state-123" })],
    ["an enormous code", query({ code: "x".repeat(5_000), state: "state-123" })],
    ["an enormous state", query({ code: SECRETS.code, state: "s".repeat(500) })],
    ["nothing at all", ""],
  ])("sends nothing and stays open for %s", async (_label, search) => {
    const postMessage = vi.fn();
    const listener = new BroadcastChannel(`${MICROSOFT_CALLBACK_CHANNEL_PREFIX}state-123`);
    const heard = vi.fn();
    listener.onmessage = heard;
    await loadCallback(search, { postMessage });
    await new Promise((resolve) => setTimeout(resolve, 30));
    listener.close();

    expect(postMessage).not.toHaveBeenCalled();
    expect(heard).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("writes nothing to the console", async () => {
    const spy = spyOnConsole();
    await loadCallback(query({ code: SECRETS.code, state: "state-123" }), { postMessage: vi.fn() });
    expect(spy.count()).toBe(0);
  });

  it("is a self-contained script: no imports, no logging", () => {
    const source = readFileSync(resolve(process.cwd(), "src/microsoftCallback.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\bconsole\s*\./);
    expect(source).not.toMatch(/postMessage\([^)]*["']\*["']/);
  });
});

describe("the page and the app agree on the message", () => {
  let popup: FakePopup;
  beforeEach(() => {
    popup = createFakePopup();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  });

  async function started() {
    const session = beginMicrosoftSignIn();
    await vi.waitFor(() => expect(popup.location.replace).toHaveBeenCalledTimes(1));
    const url = new URL(popup.location.replace.mock.calls[0][0] as string);
    return { session, state: url.searchParams.get("state")! };
  }

  it("delivers the code to the sign-in that is waiting, through the opener", async () => {
    const { session, state } = await started();
    await loadCallback(query({ code: SECRETS.code, state }), { postMessage: (data, origin) => dispatchWindowMessage(data, { origin, source: popup }) });
    await expect(session.result).resolves.toMatchObject({ code: SECRETS.code, redirectUri: `${ORIGIN}${PAGE}` });
  });

  it("delivers it through the channel when there is no opener", async () => {
    const { session, state } = await started();
    await loadCallback(query({ code: SECRETS.code, state }), null);
    await expect(session.result).resolves.toMatchObject({ code: SECRETS.code });
  });

  it("delivers a refusal as the user declining", async () => {
    const { session, state } = await started();
    await loadCallback(query({ error: "access_denied", state }), { postMessage: (data, origin) => dispatchWindowMessage(data, { origin, source: popup }) });
    await expect(session.result).rejects.toMatchObject({ code: "access_denied" });
  });

  it("makes the app reject an answer that carries a state it never sent", async () => {
    const { session } = await started();
    await loadCallback(query({ code: SECRETS.code, state: "forged-state" }), { postMessage: (data, origin) => dispatchWindowMessage(data, { origin, source: popup }) });
    await expect(session.result).rejects.toMatchObject({ code: "state_mismatch" });
  });
});

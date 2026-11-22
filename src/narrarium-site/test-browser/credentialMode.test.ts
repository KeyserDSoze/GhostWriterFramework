import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { credentialMode } from "@/account/credentialMode";

afterEach(() => vi.unstubAllGlobals());

describe("how a connection stays signed in", () => {
  it("is a session connection without a refresh token, remembered or not", () => {
    expect(credentialMode({ rememberMe: true })).toBe("session");
    expect(credentialMode({ rememberMe: false })).toBe("session");
  });

  it("is long-lived, and survives closing the app, only when it is remembered", () => {
    expect(credentialMode({ refreshToken: "rt", rememberMe: true })).toBe("long-lived");
    expect(credentialMode({ refreshToken: "rt", rememberMe: false })).toBe("long-lived-memory");
  });

  it("is long-lived for this tab only when the browser cannot keep the token safely", () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto), randomUUID: globalThis.crypto.randomUUID.bind(globalThis.crypto) });
    expect(credentialMode({ refreshToken: "rt", rememberMe: true })).toBe("long-lived-memory");
  });
});

import type { TFunction } from "i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GITHUB_CONNECTION_PROBLEM_CODES } from "narrarium-engine";

// The Client ID is a constant of the build, read when `@/config/publicClients` is imported: the test says it by this variable.
const build = vi.hoisted(() => ({ clientId: "" }));
vi.mock("@/config/publicClients", () => ({ get GITHUB_APP_CLIENT_ID() { return build.clientId; } }));

import i18n from "@/i18n";
import { knownProblemCode, pollDelayMs, safeVerificationAddress, serverGitHubOffer, serverGitHubSite } from "@/autopilot/serverGitHub";
import { describeServerGitHubError, serverGitHubProblemText } from "@/autopilot/serverGitHubText";
import { ServerRequestError } from "narrarium-engine";

const SITE = { clientId: "Iv1.0123456789abcdef", broker: "https://auth.example.com" };

afterEach(() => {
  build.clientId = "";
  vi.unstubAllEnvs();
  delete window.__serverGitHubSiteForTests;
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("what this build says to the server when the connection starts", () => {
  it("is the Client ID of the app and the broker of the build, and nothing else", () => {
    build.clientId = SITE.clientId;
    vi.stubEnv("VITE_AUTH_BROKER_BASE", "https://auth.example.com/");
    expect(serverGitHubSite()).toEqual(SITE);
  });

  it("is nothing while the build has no app or no broker: the connection is not offered", () => {
    build.clientId = "";
    vi.stubEnv("VITE_AUTH_BROKER_BASE", "https://auth.example.com");
    expect(serverGitHubSite()).toBeNull();
    build.clientId = SITE.clientId;
    vi.stubEnv("VITE_AUTH_BROKER_BASE", "");
    vi.stubEnv("VITE_GITHUB_MODELS_BASE", "");
    expect(serverGitHubSite()).toBeNull();
  });

  it("does not take a broker that the browser's own sign-in would refuse (plain http away from this computer)", () => {
    build.clientId = SITE.clientId;
    vi.stubEnv("VITE_AUTH_BROKER_BASE", "http://auth.example.com");
    expect(serverGitHubSite()).toBeNull();
    vi.stubEnv("VITE_AUTH_BROKER_BASE", "http://127.0.0.1:8787");
    expect(serverGitHubSite()).toEqual({ clientId: SITE.clientId, broker: "http://127.0.0.1:8787" });
  });

  it("is never changed by what a page puts on its window, except in a build for the end-to-end tests", () => {
    build.clientId = SITE.clientId;
    vi.stubEnv("VITE_AUTH_BROKER_BASE", SITE.broker);
    window.__serverGitHubSiteForTests = { clientId: "Iv1.evil", broker: "https://evil.example.com" };
    expect(serverGitHubSite()).toEqual(SITE);
  });
});

describe("whether the server's connection can be offered", () => {
  it("needs the feature on the server and an app and a broker in the build", () => {
    const features = ["github", "server-github-connection"];
    expect(serverGitHubOffer({ features }, SITE)).toBe("ready");
    expect(serverGitHubOffer({ features }, null)).toBe("no-site");
    expect(serverGitHubOffer({ features: ["github"] }, SITE)).toBe("old-server");
    expect(serverGitHubOffer(null, SITE)).toBe("old-server");
    expect(serverGitHubOffer({ features: "server-github-connection" as never }, SITE)).toBe("old-server");
  });
});

describe("the address the owner opens", () => {
  it("is GitHub's page over https, or this computer's own, and never a link that an answer could make into something else", () => {
    expect(safeVerificationAddress("https://github.com/login/device")).toBe("https://github.com/login/device");
    expect(safeVerificationAddress("http://127.0.0.1:5000/login/device")).toBe("http://127.0.0.1:5000/login/device");
    for (const bad of ["http://github.com/login/device", "javascript:alert(1)", "https://user:pass@github.com/", "data:text/html,x", "github.com/login/device", "", undefined]) expect(safeVerificationAddress(bad)).toBeNull();
  });
});

describe("how often the server is asked while it waits for the code", () => {
  it("follows the interval it asks GitHub at, between two and ten seconds, and grows with failures up to half a minute", () => {
    const pending = (interval: number) => ({ pending: { userCode: "X", verificationUri: "https://github.com/login/device", expiresAt: "2026-11-28T10:00:00.000Z", interval } });
    expect(pollDelayMs(pending(5))).toBe(5000);
    expect(pollDelayMs(pending(1))).toBe(2000);
    expect(pollDelayMs(pending(60))).toBe(10_000);
    expect(pollDelayMs(null)).toBe(5000);
    expect(pollDelayMs(pending(5), 1)).toBe(10_000);
    expect(pollDelayMs(pending(5), 9)).toBe(30_000);
  });
});

describe("the words of a problem", () => {
  const t = ((key: string, options?: Record<string, unknown>) => i18n.t(key, options as never)) as TFunction;

  it("tells every code the server can say with the sentence of this site, in either language, and never the server's English", async () => {
    for (const language of ["en", "it"]) {
      await i18n.changeLanguage(language);
      for (const code of GITHUB_CONNECTION_PROBLEM_CODES) {
        const text = serverGitHubProblemText(t, { code, message: "THE SERVER'S ENGLISH" });
        expect(text, `${language}: ${code}`).not.toBe("THE SERVER'S ENGLISH");
        expect(text).not.toMatch(/^serverGitHub\./);
      }
    }
    await i18n.changeLanguage("en");
  });

  it("names what to switch on in the GitHub App, as the owner will read it on GitHub", () => {
    expect(serverGitHubProblemText(t, { code: "device-flow-disabled", message: "" })).toContain("turn on “Enable Device Flow”");
    expect(serverGitHubProblemText(t, { code: "expiring-tokens-off", message: "" })).toContain("turn on “Expire user authorization tokens”");
  });

  it("falls back to the server's own message for a code it does not know (a newer server may have more)", () => {
    expect(knownProblemCode("something-new")).toBe(false);
    expect(serverGitHubProblemText(t, { code: "something-new", message: "A new thing happened." })).toBe("A new thing happened.");
  });

  it("says a lost connection in its own words, and a renewal that did not go through in others", () => {
    expect(serverGitHubProblemText(t, { code: "renewal-failed", message: "x" }, "needs-reconnect")).toMatch(/no longer accepts/);
    expect(serverGitHubProblemText(t, { code: "renewal-failed", message: "x" }, "connected")).toMatch(/did not go through/);
  });

  it("tells a failed request in the language of the app", async () => {
    expect(describeServerGitHubError(new ServerRequestError("x", 409, "github_connection_exists"))).toMatch(/already connected/);
    expect(describeServerGitHubError(new ServerRequestError("x", 422, "invalid_url"))).toMatch(/does not accept the sign-in broker/);
    expect(describeServerGitHubError(new ServerRequestError("x", 0, "unreachable"))).toMatch(/cannot be reached/);
    expect(describeServerGitHubError(new Error("plain"))).toBe("plain");
  });
});

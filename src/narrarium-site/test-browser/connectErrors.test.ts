import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { ConnectFlowError, describeConnectError, type ConnectFlowErrorCode } from "@/account/connectErrors";
import { BrokerError, type BrokerErrorCode } from "@/account/credentialBroker";
import { SECRETS } from "./oauthTestKit";

/** A stand-in for the translator that shows which text was asked for, and with what. */
const t = ((key: string, values?: Record<string, string>) => (values ? `${key} ${JSON.stringify(values)}` : key)) as unknown as TFunction;

describe("what the page says when a sign-in does not work", () => {
  it.each([
    ["unsupported", "accountSync.connectError.unsupported"],
    ["popup_blocked", "accountSync.connectError.popupBlocked"],
    ["access_denied", "accountSync.connectError.denied"],
    ["timed_out", "accountSync.connectError.timedOut"],
    ["state_mismatch", "accountSync.connectError.stateMismatch"],
    ["invalid_response", "accountSync.connectError.invalidResponse"],
    ["wrong_account", "accountSync.connectError.wrongAccount"],
  ] as Array<[ConnectFlowErrorCode, string]>)("%s asks for %s", (code, key) => {
    expect(describeConnectError(new ConnectFlowError(code), t)).toBe(key);
  });

  it("says nothing when the app itself cancelled the sign-in", () => {
    expect(describeConnectError(new ConnectFlowError("cancelled"), t)).toBeNull();
  });

  it("names the provider's error code, and only a plain one", () => {
    expect(describeConnectError(new ConnectFlowError("provider_error", undefined, { providerError: "invalid_scope" }), t)).toBe('accountSync.connectError.providerError {"code":"invalid_scope"}');
    expect(describeConnectError(new ConnectFlowError("provider_error"), t)).toBe('accountSync.connectError.providerError {"code":"unknown"}');
  });

  it.each([
    ["invalid_grant", "accountSync.connectError.codeRejected"],
    ["rate_limited", "accountSync.connectError.rateLimited"],
    ["not_configured", "accountSync.connectError.brokerUnavailable"],
    ["upstream", "accountSync.connectError.brokerUnavailable"],
    ["network", "accountSync.connectError.brokerUnavailable"],
  ] as Array<[BrokerErrorCode, string]>)("a broker failure %s asks for %s", (code, key) => {
    expect(describeConnectError(new BrokerError(code, `HTTP failure mentioning ${SECRETS.refresh}`), t)).toBe(key);
  });

  it("quotes why the provider refused, when the broker says", () => {
    const refused = new BrokerError("upstream", "failed", { status: 502, providerDetail: "invalid_request AADSTS9002327" });
    expect(describeConnectError(refused, t)).toBe('accountSync.connectError.providerRefused {"detail":"invalid_request AADSTS9002327"}');
  });

  it("leaves other errors to the caller", () => {
    expect(describeConnectError(new Error("Google profile failed (401)."), t)).toBeNull();
    expect(describeConnectError("boom", t)).toBeNull();
  });

  it("builds its own messages from fixed text, never from what the provider or the user sent", () => {
    const error = new ConnectFlowError("provider_error", undefined, { providerError: "invalid_scope" });
    expect(error.message).toBe("The provider refused the sign-in.");
    expect(JSON.stringify(error)).not.toContain(SECRETS.code);
  });
});

import { describe, expect, it } from "vitest";
import { classifyRepositoryError } from "@/repository/repositoryError";
import { clearTokenHealth, readTokenHealth, recordRepositoryReadValidated, tokenExpirationFromHeaders, tokenExpirationWarning } from "@/repository/tokenHealth";
import { effectiveRemoteStatus, type LocalRepositoryMeta } from "@/repository/localRepository";

function response(status: number, message: string, headers: Record<string, string> = {}) {
  return { status, message: `${message}\nhttps://docs.github.com/rest`, response: { status, headers, data: { message } } };
}

describe("repository availability classification", () => {
  it.each([
    [response(401, "Bad credentials"), "credential-invalid"],
    [response(403, "Forbidden"), "permission-unverified"],
    [response(403, "Resource not accessible by personal access token"), "permission"],
    [response(403, "SAML SSO authorization required"), "sso-required"],
    [response(403, "API rate limit exceeded", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" }), "rate-limit"],
    [response(403, "You have exceeded a secondary rate limit"), "abuse-limit"],
    [response(500, "Internal Server Error"), "service-unavailable"],
    [response(422, "Protected branch update failed: required status check"), "branch-protected"],
    [new TypeError("Failed to fetch token=secret"), "network"],
  ])("classifies without exposing raw errors", (error, kind) => {
    const classified = classifyRepositoryError(error, "read");
    expect(classified.kind).toBe(kind);
    expect(classified.message).not.toContain("docs.github.com");
    expect(classified.message).not.toContain("secret");
  });

  it("preserves stale changed semantics while unverified", () => {
    const meta = { remoteStatus: "unverified", remoteChanged: true, lastKnownChanged: true } as LocalRepositoryMeta;
    expect(effectiveRemoteStatus(meta)).toBe("unverified");
    expect(meta.lastKnownChanged).toBe(true);
  });

  it("returns to verified state after an outage", () => {
    const meta = { remoteStatus: "unavailable", lastKnownChanged: true } as LocalRepositoryMeta;
    expect(effectiveRemoteStatus(meta)).toBe("unavailable");
    meta.remoteStatus = "clean";
    meta.lastKnownChanged = false;
    expect(effectiveRemoteStatus(meta)).toBe("clean");
  });

  it("parses expiration headers and warning thresholds", () => {
    expect(tokenExpirationFromHeaders({ "github-authentication-token-expiration": "2026-09-01 00:00:00 UTC" })).toBe("2026-09-01T00:00:00.000Z");
    expect(tokenExpirationWarning("2026-09-01T00:00:00.000Z", Date.parse("2026-08-26T00:00:00.000Z"))).toBe("seven-days");
    expect(tokenExpirationWarning()).toBe("unknown");
  });

  it("isolates token health by account, exact repository, and case-sensitive branch", async () => {
    clearTokenHealth();
    const target = { accountIdentity: "google:one", token: "secret", owner: "Owner", repo: "Repo", branch: "Main" };
    await recordRepositoryReadValidated(target);
    expect(await readTokenHealth({ ...target, owner: "owner", repo: "repo" })).toMatchObject({ permissionStatus: "read-validated" });
    expect(await readTokenHealth({ ...target, repo: "other" })).toBeNull();
    expect(await readTokenHealth({ ...target, branch: "main" })).toBeNull();
    expect(await readTokenHealth({ ...target, accountIdentity: "google:two" })).toBeNull();
  });

});

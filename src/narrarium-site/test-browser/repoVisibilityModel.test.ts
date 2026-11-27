import { describe, expect, it } from "vitest";
import type { AppInstallation } from "@/github/githubAppInstall";
import { appAdministration, classifyVisibilityFailure, confirmationMatches, summarizeKept, visibilityAvailability } from "@/repoVisibility/model";

const installation = (account: string, permissions?: Record<string, string>, extra: Partial<AppInstallation> = {}): AppInstallation => ({ id: 1, account, accountType: "User", selection: "all", repositories: [], suspended: false, settingsUrl: "https://github.com/settings/installations/1", ...(permissions ? { permissions } : {}), ...extra });

describe("what the GitHub app was granted for Administration", () => {
  it("is read from the installation that covers the owner of the repository", () => {
    expect(appAdministration([installation("Keyser", { administration: "write", contents: "write" })], "keyser")).toBe("write");
    expect(appAdministration([installation("keyser", { administration: "read" })], "keyser")).toBe("read");
    expect(appAdministration([installation("keyser", { contents: "write" })], "keyser")).toBe("none");
  });

  it("is unknown when GitHub did not say, the app is not installed on that owner, it is suspended, or nothing was read", () => {
    expect(appAdministration([installation("keyser")], "keyser")).toBe("unknown");
    expect(appAdministration([installation("someone", { administration: "write" })], "keyser")).toBe("unknown");
    expect(appAdministration([installation("keyser", { administration: "write" }, { suspended: true })], "keyser")).toBe("unknown");
    expect(appAdministration(null, "keyser")).toBe("unknown");
  });
});

describe("whether the credential can change the visibility", () => {
  it("is explained, not tried, when GitHub says the person is no administrator, or the app lacks Administration write", () => {
    expect(visibilityAvailability({ tokenKind: "classic", canAdminister: false, appAdministration: "unknown" })).toEqual({ state: "no-admin-right" });
    expect(visibilityAvailability({ tokenKind: "app", canAdminister: true, appAdministration: "none" })).toEqual({ state: "app-permission-missing" });
    expect(visibilityAvailability({ tokenKind: "app", canAdminister: true, appAdministration: "read" })).toEqual({ state: "app-permission-missing" });
  });

  it("is ok when the app has write, or a classic token's user is an administrator", () => {
    expect(visibilityAvailability({ tokenKind: "app", canAdminister: true, appAdministration: "write" })).toEqual({ state: "ok" });
    expect(visibilityAvailability({ tokenKind: "classic", canAdminister: true, appAdministration: "unknown" })).toEqual({ state: "ok" });
  });

  it("is only tried, with a refusal explained, when GitHub does not say in advance (a fine-grained token, an app whose installation was not read)", () => {
    expect(visibilityAvailability({ tokenKind: "fine-grained", canAdminister: true, appAdministration: "unknown" })).toEqual({ state: "unverified" });
    expect(visibilityAvailability({ tokenKind: "app", canAdminister: true, appAdministration: "unknown" })).toEqual({ state: "unverified" });
    expect(visibilityAvailability({ tokenKind: "unknown", canAdminister: null, appAdministration: "unknown" })).toEqual({ state: "unverified" });
  });
});

describe("the confirmation of making a repository public", () => {
  it("is the name of the repository, exactly, with the spaces around it ignored", () => {
    expect(confirmationMatches("jesus", "jesus")).toBe(true);
    expect(confirmationMatches("  jesus \n", "jesus")).toBe(true);
    expect(confirmationMatches("Jesus", "jesus")).toBe(false);
    expect(confirmationMatches("keyser/jesus", "jesus")).toBe(false);
    expect(confirmationMatches("jesu", "jesus")).toBe(false);
    expect(confirmationMatches("", "")).toBe(false);
  });
});

describe("what Narrarium keeps in the repository", () => {
  it("is what the working copy has of secrets/, director.md, conversations/ and drafts/, with the number of files", () => {
    const paths = ["book.md", "chapters/001/chapter.md", "secrets/the-key.md", "secrets/other.md", "director.md", "drafts/001/a.md", "conversations/2026-11-01.md", "conversations/2026-11-02.md", "conversations/README.md", "secretsauce.md"];
    expect(summarizeKept(paths)).toEqual([
      { path: "secrets/", kind: "folder", count: 2 },
      { path: "director.md", kind: "file", count: 1 },
      { path: "conversations/", kind: "folder", count: 3 },
      { path: "drafts/", kind: "folder", count: 1 },
    ]);
    expect(summarizeKept(["book.md"])).toEqual([]);
  });
});

describe("a refusal to change the visibility", () => {
  const failure = (status: number | undefined, message = "", headers: Record<string, string> = {}) => Object.assign(new Error(message), { ...(status ? { status } : {}), response: { headers } });

  it("is a missing permission for the «forbidden» and «not found» an app or token without Administration gets", () => {
    expect(classifyVisibilityFailure(failure(403, "Resource not accessible by integration"))).toEqual({ kind: "permission", status: 403 });
    expect(classifyVisibilityFailure(failure(404, "Not Found"))).toEqual({ kind: "permission", status: 404 });
    expect(classifyVisibilityFailure(failure(403, "Must have admin rights to Repository."))).toEqual({ kind: "permission", status: 403 });
  });

  it("is a policy, with GitHub's own words, when an organization or a rule forbids it", () => {
    expect(classifyVisibilityFailure(failure(422, "Visibility change is not allowed because of an organization policy."))).toMatchObject({ kind: "policy", status: 422, message: "Visibility change is not allowed because of an organization policy." });
    expect(classifyVisibilityFailure(failure(403, "The organization has disabled changing repository visibility"))).toMatchObject({ kind: "policy", status: 403 });
  });

  it("keeps links and long text out of what is shown", () => {
    const result = classifyVisibilityFailure(failure(422, `Not allowed, see https://docs.github.com/some/page ${"x".repeat(500)}`));
    expect(result.kind).toBe("policy");
    expect(result.message).not.toContain("https://");
    expect(result.message!.length).toBeLessThanOrEqual(240);
  });

  it("tells the other refusals apart", () => {
    expect(classifyVisibilityFailure(failure(undefined, "Failed to fetch"))).toEqual({ kind: "network" });
    expect(classifyVisibilityFailure(failure(401, "Bad credentials"))).toEqual({ kind: "credential", status: 401 });
    expect(classifyVisibilityFailure(failure(403, "x", { "x-ratelimit-remaining": "0" })).kind).toBe("rate-limit");
    expect(classifyVisibilityFailure(failure(429, "slow down")).kind).toBe("rate-limit");
    expect(classifyVisibilityFailure(failure(403, "SAML enforcement", { "x-github-sso": "required" })).kind).toBe("sso");
    expect(classifyVisibilityFailure(failure(500, "boom"))).toMatchObject({ kind: "other", status: 500 });
  });
});

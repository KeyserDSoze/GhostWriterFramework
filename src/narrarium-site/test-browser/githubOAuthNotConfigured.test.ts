import { describe, expect, it } from "vitest";
import { createGitHubAppAuthorizationUrl } from "@/github/githubOAuth";

describe("without the app's public client id in the build", () => {
  it("does not start a sign-in", async () => {
    await expect(createGitHubAppAuthorizationUrl({ rememberMe: true })).rejects.toThrow(/not configured/);
  });
});

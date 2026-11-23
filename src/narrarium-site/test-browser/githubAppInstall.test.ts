import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallationsError, installAppUrl, loadAppInstallations, repositoryReach } from "@/github/githubAppInstall";
import { createFakeNetwork, jsonResponse, type FakeNetwork } from "./oauthTestKit";

let net: FakeNetwork;
beforeEach(() => { net = createFakeNetwork(); vi.stubGlobal("fetch", net.fetch); });
afterEach(() => vi.unstubAllGlobals());

const INSTALLATIONS = "https://api.github.com/user/installations?per_page=100&page=1";
const repos = (id: number, page = 1) => `https://api.github.com/user/installations/${id}/repositories?per_page=100&page=${page}`;
const raw = (id: number, account: string, selection: "all" | "selected", extra: Record<string, unknown> = {}) => ({ id, app_slug: "narrarium", account: { login: account, type: account === "me" ? "User" : "Organization" }, repository_selection: selection, html_url: `https://github.com/settings/installations/${id}`, ...extra });
const names = (list: string[]) => ({ total_count: list.length, repositories: list.map((full_name) => ({ full_name })) });

describe("where the GitHub App is installed", () => {
  it("none yet: the app reaches no repository, and the install link goes to the app's page", async () => {
    net.reply("GET", INSTALLATIONS, { total_count: 0, installations: [] });
    expect(await loadAppInstallations("ghu_x", { slug: "narrarium" })).toEqual([]);
    expect(installAppUrl("narrarium")).toBe("https://github.com/apps/narrarium/installations/new");
    expect(repositoryReach([], "me", "one")).toBe("not-installed");
    expect(net.calls[0].headers.authorization).toBe("Bearer ghu_x");
  });

  it("all repositories: nothing more is asked, and every repository of the account is reached", async () => {
    net.reply("GET", INSTALLATIONS, { installations: [raw(1, "me", "all")] });
    const installs = await loadAppInstallations("ghu_x", { slug: "narrarium" });
    expect(installs).toMatchObject([{ id: 1, account: "me", accountType: "User", selection: "all", repositories: [], suspended: false }]);
    expect(net.calls).toHaveLength(1);
    expect(repositoryReach(installs, "me", "anything")).toBe("all");
    expect(repositoryReach(installs, "ME", "Anything")).toBe("all");
  });

  it("selected repositories: lists them (sorted, every page) and tells a book that is among them from one that is not", async () => {
    net.reply("GET", INSTALLATIONS, { installations: [raw(2, "me", "selected")] });
    net.on("GET", repos(2, 1), () => jsonResponse(names(["me/two", "me/one"]), 200, { link: `<${repos(2, 2)}>; rel="next"` }));
    net.reply("GET", repos(2, 2), names(["me/three"]));
    const installs = await loadAppInstallations("ghu_x", { slug: "narrarium" });
    expect(installs[0].repositories).toEqual(["me/one", "me/three", "me/two"]);
    expect(repositoryReach(installs, "me", "one")).toBe("selected");
    expect(repositoryReach(installs, "me", "ONE")).toBe("selected");
    expect(repositoryReach(installs, "me", "four")).toBe("outside-selection");
  });

  it("an organization that has not approved the app: its books are not reached, and the account is not among the installations", async () => {
    net.reply("GET", INSTALLATIONS, { installations: [raw(1, "me", "all")] });
    const installs = await loadAppInstallations("ghu_x", { slug: "narrarium" });
    expect(repositoryReach(installs, "acme-org", "book")).toBe("not-installed");
  });

  it("an organization installation keeps its own settings page, for the owner to change it", async () => {
    net.reply("GET", INSTALLATIONS, { installations: [raw(7, "acme", "all", { html_url: "https://github.com/organizations/acme/settings/installations/7" }), raw(8, "other", "all", { html_url: "https://evil.example/x" })] });
    const [acme, other] = await loadAppInstallations("ghu_x", { slug: "narrarium" });
    expect(acme).toMatchObject({ accountType: "Organization", settingsUrl: "https://github.com/organizations/acme/settings/installations/7" });
    expect(other.settingsUrl).toBe("https://github.com/organizations/other/settings/installations/8");
  });

  it("a suspended installation reaches nothing", async () => {
    net.reply("GET", INSTALLATIONS, { installations: [raw(1, "me", "all", { suspended_at: "2026-11-01T00:00:00Z" })] });
    const installs = await loadAppInstallations("ghu_x", { slug: "narrarium" });
    expect(installs[0].suspended).toBe(true);
    expect(repositoryReach(installs, "me", "one")).toBe("suspended");
  });

  it("only this app's installations count", async () => {
    net.reply("GET", INSTALLATIONS, { installations: [raw(1, "me", "all", { app_slug: "another-app" }), raw(2, "me", "all")] });
    expect((await loadAppInstallations("ghu_x", { slug: "narrarium" })).map((entry) => entry.id)).toEqual([2]);
  });

  describe("what goes wrong, in a class the page can word", () => {
    const failure = async () => (await loadAppInstallations("ghu_x", { slug: "narrarium" }).catch((cause: unknown) => cause)) as InstallationsError;
    it("401 is «reconnect»", async () => {
      net.reply("GET", INSTALLATIONS, { message: "Bad credentials" }, 401);
      expect(await failure()).toMatchObject({ reason: "reconnect", status: 401 });
    });
    it("a SAML-protected organization is the single sign-on hint", async () => {
      net.reply("GET", INSTALLATIONS, { message: "Resource protected by organization SAML enforcement." }, 403);
      expect((await failure()).reason).toBe("sso");
      net.reply("GET", INSTALLATIONS, { message: "Forbidden" }, 403, { "X-GitHub-SSO": "required; url=https://github.com/orgs/x/sso" });
      expect((await failure()).reason).toBe("sso");
    });
    it("the rate limit", async () => {
      net.reply("GET", INSTALLATIONS, { message: "API rate limit exceeded" }, 403);
      expect((await failure()).reason).toBe("rate-limit");
      net.reply("GET", INSTALLATIONS, {}, 429);
      expect((await failure()).reason).toBe("rate-limit");
    });
    it("a dead network, and anything else", async () => {
      net.on("GET", INSTALLATIONS, () => { throw new TypeError("Failed to fetch"); });
      expect((await failure()).reason).toBe("network");
      net.reply("GET", INSTALLATIONS, {}, 500);
      expect(await failure()).toMatchObject({ reason: "unknown", status: 500 });
    });
  });
});

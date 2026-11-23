import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/cloudWriteBarrier", () => ({ registerCloudAccount: () => undefined, beginCloudWrite: async () => async () => undefined, fencedCloudMutation: (_p: string, _t: string, input: RequestInfo | URL, init: RequestInit) => fetch(input, init) }));
vi.mock("@/drive/jsonFile", () => ({ ensureMsFolder: async () => undefined }));
vi.mock("@/github/githubClient", () => ({ createGitHubClient: () => ({ rest: {} }) }));
const tokens = vi.hoisted(() => ({ google: vi.fn(), microsoft: vi.fn() }));
vi.mock("@/account/googleConnectionToken", () => ({ acquireGoogleConnectionToken: tokens.google }));
vi.mock("@/account/microsoftConnectionToken", () => ({ acquireMicrosoftConnectionToken: tokens.microsoft }));

import { callsCopier, configureCopyServices, copyServices, openSiteTarget, resetCopyServicesForTests } from "@/autopilot/calls/copies/services";
import { startCopiesRuntime, stopCopiesRuntimeForTests } from "@/autopilot/calls/copies/runtime";
import { MemoryCopyLedger, MemoryCopyOutbox } from "@/autopilot/calls/copies/stores";
import { AccountCredentialError, useConnectionStore } from "@/account/connectionStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const book = (patch: Partial<BookEntry> = {}): BookEntry => ({ id: "book-1", owner: "me", repo: "book", name: "Book", tokenIndex: null, addedAt: "2026-11-01T00:00:00.000Z", ...patch });

function settings(books: BookEntry[], token = "ghp_x") {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: token, books } });
}

beforeEach(() => {
  tokens.google.mockReset().mockResolvedValue("google-token");
  tokens.microsoft.mockReset().mockResolvedValue("ms-token");
  useConnectionStore.setState({ hydrated: true, configuration: {} });
});
afterEach(() => {
  stopCopiesRuntimeForTests();
  resetCopyServicesForTests();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("the target of a book, from the site's own connections", () => {
  it("is refused as «unavailable» for a book that has no GitHub repository, and as «reconnect» without a token", async () => {
    settings([book({ storageMode: "local-only" })]);
    await expect(openSiteTarget("book-1", "github")).rejects.toMatchObject({ code: "unavailable" });
    settings([book()], "");
    await expect(openSiteTarget("book-1", "github")).rejects.toMatchObject({ code: "reconnect" });
    settings([]);
    await expect(openSiteTarget("book-1", "github")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("is GitHub's dedicated branch for a book on GitHub with its token", async () => {
    settings([book()]);
    expect(await openSiteTarget("book-1", "github")).toMatchObject({ kind: "github" });
  });

  it("asks to reconnect Google Drive and OneDrive when they are not connected", async () => {
    await expect(openSiteTarget("book-1", "google-drive")).rejects.toMatchObject({ code: "reconnect" });
    await expect(openSiteTarget("book-1", "onedrive")).rejects.toMatchObject({ code: "reconnect" });
  });

  it("uses the token of the connection (broker or session) and its account, for Drive and for OneDrive", async () => {
    useConnectionStore.setState({
      hydrated: true,
      configuration: {
        google: { backend: "google-drive", method: "google", identity: { provider: "google", providerAccountId: "g-1", displayName: "W" }, accessToken: "t", rememberMe: true, replica: { enabled: true, status: "idle" } },
        microsoft: { backend: "onedrive", method: "microsoft", identity: { provider: "microsoft", providerAccountId: "m-1", displayName: "W" }, accessToken: "t", homeAccountId: "m-1", localAccountId: "l", rememberMe: true, replica: { enabled: true, status: "idle" } },
      },
    });
    expect(await openSiteTarget("book-1", "google-drive")).toMatchObject({ kind: "google-drive" });
    expect(await openSiteTarget("book-1", "onedrive")).toMatchObject({ kind: "onedrive" });
    expect(tokens.google).toHaveBeenCalledTimes(1);
    expect(tokens.microsoft).toHaveBeenCalledTimes(1);
  });

  it("turns a lapsed sign-in into «reconnect» when the copier checks the place", async () => {
    useConnectionStore.setState({ hydrated: true, configuration: { microsoft: { backend: "onedrive", method: "microsoft", identity: { provider: "microsoft", providerAccountId: "m-1", displayName: "W" }, accessToken: "t", homeAccountId: "m-1", localAccountId: "l", rememberMe: true, replica: { enabled: true, status: "idle" } } } });
    tokens.microsoft.mockRejectedValue(new AccountCredentialError("onedrive", "expired", "timed_out"));
    expect(await callsCopier().check("book-1", "onedrive")).toBe("reconnect");
  });
});

describe("what the host owns", () => {
  it("is read at each call: services configured after the copier was made are used", async () => {
    const copier = callsCopier();
    const outbox = new MemoryCopyOutbox();
    configureCopyServices({ outbox, ledger: new MemoryCopyLedger(), scope: () => "scope-x" });
    await outbox.put({ bookId: "book-1", taskId: "t", target: "github", attempts: 0, nextAt: 0, error: null, scope: "scope-x" });
    expect(await copier.status("book-1", "github")).toMatchObject({ waiting: 1 });
    expect(copyServices().store()).toBeNull();
  });

  it("starts once, from the books that have a target", async () => {
    settings([book({ aiCallsCopy: "github" }), book({ id: "book-2" })]);
    const first = startCopiesRuntime();
    expect(startCopiesRuntime()).toBe(first);
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({
  server: null as unknown as { verified: () => unknown; calls: string[] },
  local: null as unknown,
}));

vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn() }) }));
vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { autopilotRuntime, describeAutopilotError } from "@/autopilot/runtime";
import { AutopilotCampaignRefusedError, AutopilotReviewUnsupportedError } from "@/autopilot/campaign";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";

const T0 = "2026-11-26T10:00:00.000Z";
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: T0 };
const SERVER_BOOK: BookEntry = { ...BOOK, autopilotHost: "server" };
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  mocks.local = new MemoryBookStore();
  mocks.server = new FakeBookServer();
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) } });
});

afterEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("«Review the book again» through the runtime of the autopilot", () => {
  it("in this browser: the engine's refusal of a book that is not finished comes back with its code, in the author's words", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK] } });
    const refused = await autopilotRuntime.reviewBook(BOOK.id, { targetScore: 8 }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(AutopilotCampaignRefusedError);
    expect((refused as AutopilotCampaignRefusedError).code).toBe("not_finished");
    expect(describeAutopilotError(refused)).toBe(i18n.t("autopilot.campaign.errors.not_finished"));
  });

  it("on a personal server that predates it: nothing is sent, and the author is told to update the server", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [SERVER_BOOK], personalServer: CONNECTION } });
    const refused = await autopilotRuntime.reviewBook(BOOK.id, { targetScore: 8 }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(AutopilotReviewUnsupportedError);
    expect(describeAutopilotError(refused)).toBe(i18n.t("autopilot.reviewBook.oldServer", { version: "0.1.19" }));
    expect(mocks.server.calls.filter((call) => call !== "info")).toEqual([]);
  });
});

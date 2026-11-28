import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, seedBookFiles } from "narrarium-engine/testing";
import { AUTOPILOT_STATE_FILE, SERVER_FEATURE_AUTOPILOT_DESIGN_REVIEW, ServerRequestError, type AutopilotState } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ local: null as unknown, server: null as unknown as { verified: () => unknown; calls: string[] } }));

vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn() }) }));
vi.mock("@/autopilot/browserAi", () => ({ createBrowserAi: () => ({ complete: async () => { throw new Error("no AI in this test"); } }) }));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));

import i18n from "@/i18n";
import "@/i18n/design";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { BrowserAutopilotRuntime, describeAutopilotError } from "@/autopilot/runtime";
import { AutopilotDesignRefusedError, AutopilotDesignReviewUnsupportedError, designRefusal } from "@/autopilot/designReview";
import { DESIGN_REVIEW_SERVER_VERSION } from "@/outline/designReviewModel";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { AutopilotDesignError } from "narrarium-engine";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";
import { finding, pitch, stateOf } from "./helpers/designReviewFixtures";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

// The choice of a pitch and the decisions about the findings of a design, through the runtime of the autopilot: in this browser, on a personal server that has the reviews of a design
// and on one that predates them. The engine and the server are tested apart; here is what the site does with them, and what it tells the author when they refuse.

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const SERVER_BOOK: BookEntry = { ...BOOK, autopilotHost: "server" };
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };

// The ids of the findings are what the engine makes of them (`a-` for the analysis, then eight hexadecimal digits): a file with any other is not read.
const FIXABLE = "a-aaaaaaa1";
const HERS = "a-aaaaaaa2";

/** A paused design that proposed two pitches and found two things wrong with its structure: one the autopilot can fix, one that concerns only the author's entries. */
function designState(conceptDone = false): AutopilotState {
  return {
    ...stateOf(
      {
        alternatives: { pitches: [pitch("p1", "The Glass Tide"), pitch("p2", "The Salt Ledger")], evaluations: {}, recommended: { id: "p2", reason: "Sharper stakes." } },
        coherence: {
          sig: "abc12345",
          round: 1,
          at: "2026-11-28T09:00:00.000Z",
          summary: "",
          findings: [finding({ id: FIXABLE, text: "The harbor master dies twice." }), finding({ id: HERS, text: "Her own entry contradicts chapter 3.", owner: "author", chapters: [1], requires: [1] })],
        },
      },
      (state) => { state.concept = { done: conceptDone, generated: conceptDone, secrets: [] }; },
    ),
    status: "paused",
  };
}

const savedState = (store: MemoryBookStore): AutopilotState => JSON.parse(store.files.get(AUTOPILOT_STATE_FILE) ?? "null");
const bookWith = (state: AutopilotState) => new MemoryBookStore({ ...seedBookFiles(), [AUTOPILOT_STATE_FILE]: JSON.stringify(state) });
const refusal = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error as AutopilotDesignRefusedError);

let local: MemoryBookStore;
/** A runtime of its own for every test: it keeps the session of a book, with the store the book had when it began. */
let autopilotRuntime: BrowserAutopilotRuntime;
const runtimeOf = () => new BrowserAutopilotRuntime({ channel: () => null, connect: (async () => mocks.server.verified()) as never });
/** The book in another state: a new runtime, since the session of the first one is of the store it began with. */
function restart(store: MemoryBookStore) {
  mocks.local = store;
  autopilotRuntime = runtimeOf();
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  local = bookWith(designState());
  mocks.local = local;
  mocks.server = new FakeBookServer();
  installNavigatorLocks(new FakeLockRegistry().forTab("this-tab") as never);
  autopilotRuntime = runtimeOf();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], aiIntegrations: [{ id: "ai-1" } as never] } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [] });
});

afterEach(() => {
  delete (navigator as { locks?: unknown }).locks;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("the choice of a pitch and the decisions about the findings of a book that runs in this browser", () => {
  it("chooses a pitch: it is saved with the author as who chose, and the page sees it", async () => {
    await autopilotRuntime.chooseDesignPitch(BOOK.id, { id: "p1" });
    expect(savedState(local).design?.alternatives?.selected).toMatchObject({ id: "p1", by: "author" });
    expect(useAutopilotStore.getState().views[BOOK.id].snapshot?.state?.design?.alternatives?.selected?.id).toBe("p1");
  });

  it("decides about a finding the four ways, each saved with the author as who decided", async () => {
    const status = () => savedState(local).design?.coherence?.findings.find((entry) => entry.id === FIXABLE);
    await autopilotRuntime.decideDesignFinding(BOOK.id, { id: FIXABLE, action: "fix" });
    expect(status()).toMatchObject({ status: "fixing" });
    await autopilotRuntime.decideDesignFinding(BOOK.id, { id: FIXABLE, action: "mine" });
    expect(status()).toMatchObject({ status: "mine", decision: { by: "author" } });
    await autopilotRuntime.decideDesignFinding(BOOK.id, { id: FIXABLE, action: "dismiss", reason: "It is deliberate." });
    expect(status()).toMatchObject({ status: "dismissed", decision: { by: "author", reason: "It is deliberate." } });
    await autopilotRuntime.decideDesignFinding(BOOK.id, { id: FIXABLE, action: "reopen" });
    expect(status()).toMatchObject({ status: "open" });
    expect(useAutopilotStore.getState().views[BOOK.id].snapshot?.state?.design?.coherence?.findings.find((entry) => entry.id === FIXABLE)?.status).toBe("open");
  });

  it("is refused by the engine with its code, in the author's words, and nothing is saved", async () => {
    const before = local.files.get(AUTOPILOT_STATE_FILE);
    const unknown = await refusal(autopilotRuntime.chooseDesignPitch(BOOK.id, { id: "p9" }));
    expect(unknown).toBeInstanceOf(AutopilotDesignRefusedError);
    expect(unknown?.code).toBe("unknown_pitch");
    expect(describeAutopilotError(unknown)).toBe(i18n.t("designReview.errors.unknown_pitch"));
    const hers = await refusal(autopilotRuntime.decideDesignFinding(BOOK.id, { id: HERS, action: "fix" }));
    expect(hers?.code).toBe("not_fixable");
    expect(describeAutopilotError(hers)).toBe(i18n.t("designReview.errors.not_fixable"));
    expect((await refusal(autopilotRuntime.decideDesignFinding(BOOK.id, { id: "a-bbbbbbbb", action: "mine" })))?.code).toBe("unknown_finding");
    expect(local.files.get(AUTOPILOT_STATE_FILE)).toBe(before);
  });

  it("refuses to choose again once the concept is made of a pitch, and a decision where there is no analysis or no pitch", async () => {
    restart(bookWith(designState(true)));
    expect((await refusal(autopilotRuntime.chooseDesignPitch(BOOK.id, { id: "p1" })))?.code).toBe("pitch_locked");
    restart(bookWith({ ...stateOf(), status: "paused" }));
    expect((await refusal(autopilotRuntime.chooseDesignPitch(BOOK.id, { id: "p1" })))?.code).toBe("no_pitches");
    expect((await refusal(autopilotRuntime.decideDesignFinding(BOOK.id, { id: "a-cccccccc", action: "fix" })))?.code).toBe("no_findings");
  });
});

describe("the same on a personal server", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [SERVER_BOOK], aiIntegrations: [{ id: "ai-1" } as never], personalServer: CONNECTION } });
  });

  it("that predates the reviews of a design: nothing is sent, and the author is told to update it", async () => {
    const asked = [
      () => autopilotRuntime.chooseDesignPitch(BOOK.id, { id: "p1" }),
      () => autopilotRuntime.decideDesignFinding(BOOK.id, { id: FIXABLE, action: "fix" }),
    ];
    for (const ask of asked) {
      const error = await ask().then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(AutopilotDesignReviewUnsupportedError);
      expect(describeAutopilotError(error)).toBe(i18n.t("designReview.oldServer", { version: DESIGN_REVIEW_SERVER_VERSION }));
    }
    expect(DESIGN_REVIEW_SERVER_VERSION).toBe("0.1.28");
    expect((mocks.server as unknown as FakeBookServer).calls.filter((call) => call !== "info")).toEqual([]);
  });

  it("that has them: the choice and the decision are made on the server's copy of the book, and come back to this browser", async () => {
    const server = new FakeBookServer({ ...seedBookFiles(), [AUTOPILOT_STATE_FILE]: JSON.stringify(designState()) });
    server.engine = true;
    server.extraFeatures = [SERVER_FEATURE_AUTOPILOT_DESIGN_REVIEW];
    mocks.server = server;
    await autopilotRuntime.chooseDesignPitch(BOOK.id, { id: "p2" });
    expect(server.calls).toContain("chooseDesignPitch");
    expect(savedState(server.store).design?.alternatives?.selected).toMatchObject({ id: "p2", by: "author" });
    await autopilotRuntime.decideDesignFinding(BOOK.id, { id: FIXABLE, action: "fix" });
    expect(server.calls).toContain("decideDesignFinding");
    expect(savedState(server.store).design?.coherence?.findings.find((entry) => entry.id === FIXABLE)?.status).toBe("fixing");
    expect(useAutopilotStore.getState().views[BOOK.id].snapshot?.state?.design?.alternatives?.selected?.id).toBe("p2");
  });

  it("that refuses: its code comes back as the engine's own, in the author's words", async () => {
    const server = new FakeBookServer({ ...seedBookFiles(), [AUTOPILOT_STATE_FILE]: JSON.stringify(designState(true)) });
    server.engine = true;
    server.extraFeatures = [SERVER_FEATURE_AUTOPILOT_DESIGN_REVIEW];
    mocks.server = server;
    restart(bookWith(designState(true)));
    const locked = await refusal(autopilotRuntime.chooseDesignPitch(BOOK.id, { id: "p1" }));
    expect(locked).toBeInstanceOf(AutopilotDesignRefusedError);
    expect(locked?.code).toBe("pitch_locked");
    expect(describeAutopilotError(locked)).toBe(i18n.t("designReview.errors.pitch_locked"));
  });
});

describe("what a refusal is", () => {
  it("is the engine's refusal here and the server's answer there, with its code; anything else is left alone", () => {
    const here = designRefusal(new AutopilotDesignError("pitch_locked", "locked"));
    expect(here).toBeInstanceOf(AutopilotDesignRefusedError);
    expect((here as AutopilotDesignRefusedError).code).toBe("pitch_locked");
    for (const status of [400, 409]) expect(designRefusal(new ServerRequestError("x", status, "not_fixable"))).toBeInstanceOf(AutopilotDesignRefusedError);
    // The codes the design had before the reviews are not these, and a status that is not a refusal is an error of the server.
    const written = new AutopilotDesignError("design_written", "written");
    expect(designRefusal(written)).toBe(written);
    const busy = new ServerRequestError("x", 503, "not_fixable");
    expect(designRefusal(busy)).toBe(busy);
    const other = new Error("boom");
    expect(designRefusal(other)).toBe(other);
  });

  it("says the author's words in the language of the app, and the engine's own when a code has none", async () => {
    await i18n.changeLanguage("it");
    try {
      expect(describeAutopilotError(new AutopilotDesignRefusedError("pitch_locked", "locked"))).toBe(i18n.t("designReview.errors.pitch_locked"));
      expect(describeAutopilotError(new AutopilotDesignRefusedError("pitch_locked", "locked"))).not.toBe(i18n.getFixedT("en")("designReview.errors.pitch_locked"));
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

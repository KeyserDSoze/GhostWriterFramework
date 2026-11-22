import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, seedBookFiles } from "narrarium-engine/testing";
import { AUTOPILOT_STATE_FILE, SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RULES, ServerRequestError, createAutopilotState, summarizeAutopilotState, type AutopilotSnapshot, type NarrariumServerClient, type ServerInfo } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ local: null as unknown }));

vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/autopilot/browserAi", () => ({ createBrowserAi: () => ({ complete: async () => { throw new Error("no AI in this test"); } }) }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { BrowserAutopilotRuntime } from "@/autopilot/runtime";
import { AutopilotRulesUnsupportedError, RULES_SERVER_VERSION, ruleErrorCode, serverEditsRules } from "@/autopilot/rules";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { SERVER_INFO, PIN } from "./helpers/fakeBookServer";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const SERVER_BOOK: BookEntry = { ...BOOK, autopilotHost: "server" };
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const RULES = ["Keep the tone ironic.", "Never name the ledger before chapter 9."];
const RULES_INFO = { ...SERVER_INFO, serverVersion: "0.1.6", features: [SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RULES] } as ServerInfo;

let local: MemoryBookStore;

function storedState(constraints = RULES) {
  return { ...createAutopilotState(new Date("2026-11-21T10:00:00.000Z")), status: "paused" as const, constraints: [...constraints] };
}

const savedRules = () => JSON.parse(local.files.get(AUTOPILOT_STATE_FILE) ?? "null")?.constraints;

/** A personal server that keeps the rules of the book, as the real one does since 0.1.6; `info` says whether it announces it. */
function serverWith(info: ServerInfo) {
  const calls: Array<[string, ...unknown[]]> = [];
  let rules = [...RULES];
  const snapshot = (): AutopilotSnapshot => {
    const state = { ...storedState(rules) };
    return { bookId: BOOK.id, state, summary: summarizeAutopilotState(state), activities: [], live: null, running: false, host: null };
  };
  const client = {
    async updateRule(bookId: string, index: number, text: string, expectedText?: string) {
      calls.push(["updateRule", bookId, index, text, expectedText]);
      if (rules[index] === undefined) throw new ServerRequestError(`There is no rule number ${index + 1}.`, 404, "rule_not_found");
      if (expectedText !== undefined && rules[index] !== expectedText) throw new ServerRequestError("The rule changed in the meantime.", 409, "rule_changed");
      rules = rules.map((rule, position) => (position === index ? text : rule));
      return snapshot();
    },
    async removeRule(bookId: string, index: number, expectedText?: string) {
      calls.push(["removeRule", bookId, index, expectedText]);
      if (expectedText !== undefined && rules[index] !== expectedText) throw new ServerRequestError("The rule changed in the meantime.", 409, "rule_changed");
      rules = rules.filter((_, position) => position !== index);
      return snapshot();
    },
    async autopilot() {
      calls.push(["autopilot"]);
      return snapshot();
    },
  } as unknown as NarrariumServerClient;
  return { calls, connect: async () => ({ client, info, fingerprint: PIN }) };
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  local = new MemoryBookStore({ ...seedBookFiles(), [AUTOPILOT_STATE_FILE]: JSON.stringify(storedState()) });
  mocks.local = local;
  installNavigatorLocks(new FakeLockRegistry().forTab("this-tab") as never);
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], aiIntegrations: [{ id: "ai-1" } as never], personalServer: CONNECTION } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [] });
});

afterEach(() => {
  delete (navigator as { locks?: unknown }).locks;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("a permanent rule of a book that runs in this browser", () => {
  const runtime = () => new BrowserAutopilotRuntime({ channel: () => null });

  it("is changed in the state of the book, and the page sees it", async () => {
    const instance = runtime();
    await instance.updateRule(BOOK.id, 1, "Never name the ledger before chapter 10.", RULES[1]);
    expect(savedRules()).toEqual([RULES[0], "Never name the ledger before chapter 10."]);
    expect(useAutopilotStore.getState().views[BOOK.id].snapshot?.state?.constraints).toEqual([RULES[0], "Never name the ledger before chapter 10."]);
  });

  it("is removed, and the rules after it move up", async () => {
    await runtime().removeRule(BOOK.id, 0, RULES[0]);
    expect(savedRules()).toEqual([RULES[1]]);
  });

  it("is never overwritten when it changed in the meantime: the engine refuses, and the code says why", async () => {
    const error = await runtime().updateRule(BOOK.id, 0, "Something else.", "A rule the author saw before it changed.").catch((caught: unknown) => caught);
    expect(ruleErrorCode(error)).toBe("rule_changed");
    expect(savedRules()).toEqual(RULES);
    expect(ruleErrorCode(await runtime().removeRule(BOOK.id, 5, "Gone.").catch((caught: unknown) => caught))).toBe("rule_not_found");
    expect(ruleErrorCode(await runtime().updateRule(BOOK.id, 0, RULES[1], RULES[0]).catch((caught: unknown) => caught))).toBe("rule_duplicate");
    expect(ruleErrorCode(await runtime().updateRule(BOOK.id, 0, "x".repeat(801), RULES[0]).catch((caught: unknown) => caught))).toBe("rule_too_long");
  });
});

describe("a permanent rule of a book that runs on the personal server", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [SERVER_BOOK], aiIntegrations: [{ id: "ai-1" } as never], personalServer: CONNECTION } });
  });

  it("is changed and removed by the server, with the text the author saw as the guard, and the page has its answer", async () => {
    const server = serverWith(RULES_INFO);
    const runtime = new BrowserAutopilotRuntime({ channel: () => null, connect: server.connect as never });
    await runtime.updateRule(BOOK.id, 1, "Never name the ledger before chapter 10.", RULES[1]);
    expect(server.calls).toContainEqual(["updateRule", BOOK.id, 1, "Never name the ledger before chapter 10.", RULES[1]]);
    expect(useAutopilotStore.getState().views[BOOK.id].snapshot?.state?.constraints).toEqual([RULES[0], "Never name the ledger before chapter 10."]);
    await runtime.removeRule(BOOK.id, 0, RULES[0]);
    expect(server.calls).toContainEqual(["removeRule", BOOK.id, 0, RULES[0]]);
    expect(useAutopilotStore.getState().views[BOOK.id].snapshot?.state?.constraints).toEqual(["Never name the ledger before chapter 10."]);
  });

  it("keeps the code of the server when it refuses", async () => {
    const server = serverWith(RULES_INFO);
    const runtime = new BrowserAutopilotRuntime({ channel: () => null, connect: server.connect as never });
    expect(ruleErrorCode(await runtime.updateRule(BOOK.id, 0, "Other.", "Not what it says.").catch((caught: unknown) => caught))).toBe("rule_changed");
  });

  it("is not sent to a server that predates the rules: it would answer 404, so the author is told to update it", async () => {
    const server = serverWith({ ...SERVER_INFO, serverVersion: "0.1.5" } as ServerInfo);
    const runtime = new BrowserAutopilotRuntime({ channel: () => null, connect: server.connect as never });
    const error = await runtime.updateRule(BOOK.id, 0, "Other.", RULES[0]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AutopilotRulesUnsupportedError);
    expect((error as Error).message).toContain(RULES_SERVER_VERSION);
    expect(await runtime.removeRule(BOOK.id, 0, RULES[0]).catch((caught: unknown) => caught)).toBeInstanceOf(AutopilotRulesUnsupportedError);
    expect(server.calls.filter(([name]) => name === "updateRule" || name === "removeRule")).toEqual([]);
  });
});

describe("what the page knows of the server", () => {
  it("is whether it announces the rules", () => {
    expect(serverEditsRules(RULES_INFO)).toBe(true);
    expect(serverEditsRules(SERVER_INFO)).toBe(false);
    expect(serverEditsRules(null)).toBe(false);
    expect(RULES_SERVER_VERSION).toBe("0.1.6");
  });

  it("tells a refusal of a rule from the other errors", () => {
    expect(ruleErrorCode(new ServerRequestError("Busy.", 409, "busy"))).toBeNull();
    expect(ruleErrorCode(new Error("rule_changed"))).toBeNull();
    expect(ruleErrorCode(null)).toBeNull();
  });
});

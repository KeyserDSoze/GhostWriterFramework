import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { autopilotRuntime, describeAutopilotError } from "@/autopilot/runtime";
import { ServerAddressError } from "@/autopilot/serverAddress";
import { ServerIdentityError, forgetServerVerification } from "@/autopilot/serverIdentity";
import { useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type BookEntry, type PersonalServerSettings } from "@/types/settings";
import { createFakeIdentity, createFakeNetwork, type FakeIdentity } from "./helpers/fakePersonalServer";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const ORIGIN = "http://127.0.0.1:24242";
const TOKEN = "nrs_shared_client_token";
const API_KEY = "sk-super-secret-api-key";

const AI: AIIntegration = { id: "ai-1", name: "Primary", provider: "openai", endpoint: "https://api.openai.com/v1", apiKey: API_KEY, chatModels: [{ id: "m1", name: "gpt-4o", capabilities: ["default"] }] } as AIIntegration;
const BOOK: BookEntry = { id: "book-server", owner: "local", repo: "book-server", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const SERVER_BOOK: BookEntry = { ...BOOK, id: "book-on-server", repo: "book-on-server", autopilotHost: "server" };

let identity: FakeIdentity;
let other: FakeIdentity;

function connection(patch: Partial<PersonalServerSettings> = {}): PersonalServerSettings {
  return { url: ORIGIN, token: TOKEN, serverId: identity.serverId, fingerprint: identity.fingerprint, ...patch };
}

function configure(personalServer: PersonalServerSettings | undefined, books: BookEntry[] = []) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books, personalServer, aiIntegrations: [AI] } });
}

const serverState = () => useAutopilotStore.getState().server;
const idleServer: ServerConnectionState = { status: "disabled", info: null, message: null, books: [], updates: null, connection: null };

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  forgetServerVerification();
  identity = await createFakeIdentity();
  other = await createFakeIdentity();
  useAutopilotStore.setState({ server: { ...idleServer }, views: {} });
});

afterEach(() => {
  configure(undefined);
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ server: { ...idleServer }, views: {} });
  vi.unstubAllGlobals();
});

describe("the live connection to the personal server", () => {
  it("reports an unusable address as an error instead of staying online", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    vi.stubGlobal("fetch", network.fetch);
    useAutopilotStore.setState({ server: { status: "online", info: null, message: null, books: [], updates: null, connection: connection() } });

    for (const url of ["http://", "https://", "http://:24242", "https://exa mple.com", "http://example.com", "ftp://example.com"]) {
      configure(connection({ url }));
      autopilotRuntime.ensureServerStream();
      await vi.waitFor(() => expect(serverState().status).toBe("error"));
      expect(serverState().message).toBeTruthy();
      expect(serverState().message).not.toMatch(/^personalServer\./);
      expect(serverState().connection?.url).toBe(url);
      useAutopilotStore.setState({ server: { status: "online", info: null, message: null, books: [], updates: null, connection: connection() } });
    }
    expect(network.requests).toHaveLength(0);
  });

  it("never sends the token before a server proved the pinned identity", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity: other, token: TOKEN } });
    vi.stubGlobal("fetch", network.fetch);

    configure(connection());
    autopilotRuntime.ensureServerStream();
    await vi.waitFor(() => expect(serverState().status).toBe("error"));
    expect(serverState().message).toBe(i18n.t("personalServer.identity.changed"));
    const probed = network.requests.length;
    expect(probed).toBeGreaterThan(0);

    configure(connection({ fingerprint: undefined }));
    autopilotRuntime.ensureServerStream();
    await vi.waitFor(() => expect(serverState().message).toBe(i18n.t("personalServer.identity.unpinned")));
    expect(serverState().status).toBe("error");
    expect(network.requests).toHaveLength(probed);
    expect(network.authenticated()).toHaveLength(0);
  });

  it("goes online only for the pinned server and remembers which connection that is", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    vi.stubGlobal("fetch", network.fetch);
    configure(connection());
    autopilotRuntime.ensureServerStream();
    await vi.waitFor(() => expect(serverState().status).toBe("online"));
    expect(serverState().connection).toEqual(connection());
    expect(network.requests[0]).toMatchObject({ path: "/api/v1/info", authorization: null });
    expect(network.authenticated().every((request) => request.origin === ORIGIN && request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(network.authenticated().map((request) => request.path)).toEqual(expect.arrayContaining(["/api/v1/books", "/api/v1/events"]));
  });

  it("follows a new address on its own, without carrying the old status over", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN, books: [{ bookId: "b", title: "B" }] } });
    vi.stubGlobal("fetch", network.fetch);
    configure(connection());
    autopilotRuntime.ensureServerStream();
    await vi.waitFor(() => expect(serverState().status).toBe("online"));
    expect(serverState().books).toHaveLength(1);

    configure(connection({ url: "https://nowhere.example.com" }));
    autopilotRuntime.ensureServerStream();
    expect(serverState()).toMatchObject({ status: "connecting", info: null, books: [], connection: { url: "https://nowhere.example.com" } });
    await vi.waitFor(() => expect(serverState().status).toBe("offline"));
    expect(network.authenticated().every((request) => request.origin === ORIGIN)).toBe(true);
  });
});

describe("every call to the personal server goes through the identity check", () => {
  it("does not send the AI keys or the GitHub token when the server at the address is not the pinned one", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity: other, token: TOKEN } });
    vi.stubGlobal("fetch", network.fetch);
    configure(connection(), [{ ...BOOK, storageMode: undefined, bookToken: "ghp_secret_book_token" }]);

    await expect(autopilotRuntime.moveToServer(BOOK.id, { sendAiConfiguration: true, sendGitHubToken: true })).rejects.toBeInstanceOf(ServerIdentityError);
    expect(network.authenticated()).toHaveLength(0);
    expect(JSON.stringify(network.requests)).not.toContain(API_KEY);
    expect(JSON.stringify(network.requests)).not.toContain("ghp_secret_book_token");
  });

  it("refuses a server that cannot prove who it is, and a pinned fingerprint that is missing", async () => {
    const unsigned = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN, unsigned: true } });
    vi.stubGlobal("fetch", unsigned.fetch);
    configure(connection(), [BOOK]);
    await expect(autopilotRuntime.moveToServer(BOOK.id, { sendAiConfiguration: true, sendGitHubToken: false })).rejects.toMatchObject({ reason: "invalid" });
    expect(unsigned.authenticated()).toHaveLength(0);

    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN } });
    vi.stubGlobal("fetch", network.fetch);
    forgetServerVerification();
    configure(connection({ fingerprint: undefined }), [BOOK]);
    await expect(autopilotRuntime.moveToServer(BOOK.id, { sendAiConfiguration: true, sendGitHubToken: false })).rejects.toMatchObject({ reason: "unpinned" });
    expect(network.requests).toHaveLength(0);
  });

  it("sends the AI configuration only after the server proved its identity", async () => {
    const server = { identity, token: TOKEN, registered: [] as Array<{ bookId: string; body: unknown }> };
    const network = createFakeNetwork({ [ORIGIN]: server });
    vi.stubGlobal("fetch", network.fetch);
    configure(connection(), [BOOK]);
    const repo = await putLocalRepository({ bookId: BOOK.id, owner: BOOK.owner, repo: BOOK.repo, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: "2026-11-21T00:00:00.000Z", cloneComplete: true }, captureRepositoryOperationScope());
    try {
      await autopilotRuntime.moveToServer(BOOK.id, { sendAiConfiguration: true, sendGitHubToken: false });
    } finally {
      await removeLocalRepository(repo.id, captureRepositoryOperationScope());
    }
    const order = network.requests.map((request) => `${request.method} ${request.path}${request.authorization ? " (token)" : ""}`);
    expect(order.indexOf("GET /api/v1/info")).toBe(0);
    expect(order.indexOf("PUT /api/v1/ai (token)")).toBeGreaterThan(0);
    expect(server.registered.map((entry) => entry.bookId)).toEqual([BOOK.id]);
    expect(JSON.stringify(network.requests.find((request) => request.path === "/api/v1/ai")?.body)).toContain(API_KEY);
  });

  it.each([
    ["start", (id: string) => autopilotRuntime.start(id)],
    ["pause", (id: string) => autopilotRuntime.pause(id, "now")],
    ["intervene", (id: string) => autopilotRuntime.intervene(id, { text: "Keep it short.", scope: "next_step" } as never)],
    ["answer", (id: string) => autopilotRuntime.answer(id, { questionId: "q", answer: "yes" } as never)],
    ["configure", (id: string) => autopilotRuntime.configure(id, {} as never)],
    ["reset", (id: string) => autopilotRuntime.reset(id)],
    ["ask the director", (id: string) => autopilotRuntime.askDirector(id, { target: { kind: "book" } })],
  ])("%s on a book hosted by the server refuses an unverified server before sending the token", async (_name, action) => {
    const network = createFakeNetwork({ [ORIGIN]: { identity: other, token: TOKEN } });
    vi.stubGlobal("fetch", network.fetch);
    configure(connection(), [SERVER_BOOK]);
    await expect(action(SERVER_BOOK.id)).rejects.toBeInstanceOf(ServerIdentityError);
    expect(network.authenticated()).toHaveLength(0);
  });

  it("shows the identity problem in the autopilot view instead of contacting the server", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity: other, token: TOKEN } });
    vi.stubGlobal("fetch", network.fetch);
    configure(connection(), [SERVER_BOOK]);
    await autopilotRuntime.refresh(SERVER_BOOK.id);
    expect(useAutopilotStore.getState().views[SERVER_BOOK.id]?.error).toBe(i18n.t("personalServer.identity.changed"));
    expect(network.authenticated()).toHaveLength(0);
  });

  it("syncs and brings a book back without sending the token to an unverified server", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity: other, token: TOKEN } });
    vi.stubGlobal("fetch", network.fetch);
    configure(connection(), [SERVER_BOOK]);
    await expect(autopilotRuntime.syncWithServer(SERVER_BOOK.id, { push: true })).rejects.toBeInstanceOf(ServerIdentityError);
    // The server's work cannot be downloaded from a server that is not the one paired, so the book stays on it...
    await expect(autopilotRuntime.moveToBrowser(SERVER_BOOK.id)).rejects.toBeInstanceOf(ServerIdentityError);
    // ...unless the author chooses to leave without it.
    await expect(autopilotRuntime.moveToBrowser(SERVER_BOOK.id, { discardServerWork: true })).resolves.toBeUndefined();
    expect(network.authenticated()).toHaveLength(0);
  });

  it("uses the connection the runtime follows, not the address being typed", async () => {
    const network = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN }, "https://typed.example.com": { identity, token: TOKEN } });
    vi.stubGlobal("fetch", network.fetch);
    configure(connection(), [SERVER_BOOK]);
    autopilotRuntime.ensureServerStream();
    await vi.waitFor(() => expect(serverState().status).toBe("online"));
    network.requests.length = 0;

    configure(connection({ url: "https://typed.example.com" }), [SERVER_BOOK]);
    await autopilotRuntime.refresh(SERVER_BOOK.id);
    expect(network.requests.every((request) => request.origin === ORIGIN)).toBe(true);
  });
});

describe("describing server errors", () => {
  it("translates identity and address problems", () => {
    expect(describeAutopilotError(new ServerIdentityError("unpinned"))).toBe(i18n.t("personalServer.identity.unpinned"));
    expect(describeAutopilotError(new ServerIdentityError("unsupported"))).toBe(i18n.t("personalServer.identity.unsupported"));
    expect(describeAutopilotError(new ServerAddressError("insecure"))).toBe(i18n.t("personalServer.address.insecure"));
    expect(describeAutopilotError(new ServerAddressError("insecure"))).not.toMatch(/^personalServer\./);
  });
});

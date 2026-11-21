import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: vi.fn(), reconnectServer: vi.fn(), onSave: vi.fn(async () => undefined) }));

vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => ({ reconnectServer: mocks.reconnectServer }) }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { PersonalServerSettingsBody } from "@/components/settings/PersonalServerSettingsBody";
import { forgetServerVerification } from "@/autopilot/serverIdentity";
import { useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration, type PersonalServerSettings } from "@/types/settings";
import { createFakeIdentity, createFakeNetwork, type FakeIdentity, type FakeServer } from "./helpers/fakePersonalServer";

const ORIGIN = "http://127.0.0.1:24242";
const TOKEN = "nrs_shared_client_token";
const AI = { id: "ai-1", name: "Primary", provider: "openai", endpoint: "https://api.openai.com/v1", apiKey: "sk-super-secret-api-key", chatModels: [{ id: "m1", name: "gpt-4o", capabilities: ["default"] }] } as AIIntegration;
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

let identity: FakeIdentity;
let other: FakeIdentity;

function connection(patch: Partial<PersonalServerSettings> = {}): PersonalServerSettings {
  return { url: ORIGIN, token: TOKEN, serverId: identity.serverId, fingerprint: identity.fingerprint, clientLabel: "Test device", ...patch };
}

function serverState(patch: Partial<ServerConnectionState> = {}): ServerConnectionState {
  return {
    status: "online",
    info: { name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.0", engineVersion: "0.1.1", serverId: identity.serverId, label: "Home", git: true, features: [] },
    message: null,
    books: [],
    updates: null,
    connection: connection(),
    ...patch,
  };
}

function open(personalServer: PersonalServerSettings | undefined, server: ServerConnectionState | null = serverState()) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, aiIntegrations: [AI], personalServer } });
  useAutopilotStore.setState({ server: server ?? { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
}

function Harness() {
  const settings = useSettingsStore((state) => state.settings);
  const patchSettings = useSettingsStore((state) => state.patchSettings);
  return <PersonalServerSettingsBody settings={settings} patchSettings={patchSettings} onSave={mocks.onSave} />;
}

const urlField = () => screen.getByLabelText(t("personalServer.url")) as HTMLInputElement;
const button = (key: string) => screen.getByRole("button", { name: t(key) }) as HTMLButtonElement;
const type = (value: string) => act(() => { fireEvent.change(urlField(), { target: { value } }); });

function network(server: Partial<FakeServer> = {}, extra: Record<string, FakeServer> = {}) {
  const fake = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN, ...server }, ...extra });
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  forgetServerVerification();
  identity = await createFakeIdentity();
  other = await createFakeIdentity();
  mocks.toast.mockReset();
  mocks.reconnectServer.mockReset();
  mocks.onSave.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("typing the server address", () => {
  it("never sends the token to the address being typed, and drops the online status at once", async () => {
    const fake = network();
    open(connection());
    render(<Harness />);
    await waitFor(() => expect(fake.authenticated().length).toBeGreaterThanOrEqual(3));
    expect(fake.authenticated().every((request) => request.origin === ORIGIN)).toBe(true);
    expect(screen.getByText(t("personalServer.status.online"))).toBeInTheDocument();
    const sent = fake.requests.length;

    for (const typed of ["https://", "https://h", "https://ht", "http://0.0.0.1", "https://my-server.exa", "http://127.0.0.1:2424", "http://127.0.0.1:242"]) {
      type(typed);
      expect(screen.queryByText(t("personalServer.status.online"))).not.toBeInTheDocument();
      expect(screen.getByText(t("personalServer.status.connecting"))).toBeInTheDocument();
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(fake.requests).toHaveLength(sent);
  });

  it("cancels the requests that are still in flight when the address changes", async () => {
    const fake = network({ hold: new Promise<void>(() => undefined) });
    open(connection());
    render(<Harness />);
    await waitFor(() => expect(fake.authenticated().length).toBeGreaterThanOrEqual(3));
    type("http://127.0.0.1:2424");
    await waitFor(() => expect(fake.authenticated().every((request) => request.signal?.aborted)).toBe(true));
  });

  it("shows a translated error under the field for an unusable address instead of crashing the page", async () => {
    const fake = network();
    open(connection());
    render(<Harness />);
    await waitFor(() => expect(fake.authenticated().length).toBeGreaterThanOrEqual(3));
    const sent = fake.requests.length;

    for (const [typed, reason] of [["http://", "invalid"], ["https://", "invalid"], ["http://:24242", "invalid"], ["https://exa mple.com", "invalid"], ["ftp://example.com", "scheme"], ["https://user:pw@example.com", "credentials"], ["http://example.com", "insecure"]] as const) {
      expect(() => type(typed)).not.toThrow();
      expect(urlField()).toHaveAttribute("aria-invalid", "true");
      expect(urlField().getAttribute("aria-describedby")).toBeTruthy();
      const message = screen.getByText(t(`personalServer.address.${reason}`));
      expect(message.id).toBe(urlField().getAttribute("aria-describedby"));
      expect(message).toHaveAttribute("aria-live", "polite");
      expect(button("personalServer.test")).toBeDisabled();
    }
    expect(fake.requests).toHaveLength(sent);

    type("http://127.0.0.1:24242");
    expect(urlField()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(t("personalServer.address.insecure"))).not.toBeInTheDocument();
  });

  it("does not offer to pair with an address that is not usable", () => {
    network();
    open(undefined, null);
    render(<Harness />);
    type("http://example.com");
    fireEvent.change(screen.getByLabelText(t("personalServer.pair.code")), { target: { value: "123456789" } });
    expect(button("personalServer.pair.start")).toBeDisabled();
    type("https://my-server.example.com");
    expect(button("personalServer.pair.start")).toBeEnabled();
  });

  it("still lets the author disconnect when the address typed is unusable", async () => {
    network();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    open(connection({ url: "http://" }), serverState({ status: "error", connection: connection({ url: "http://" }) }));
    render(<Harness />);
    fireEvent.click(button("personalServer.disconnect"));
    await waitFor(() => expect(useSettingsStore.getState().settings.personalServer).toBeUndefined());
    expect(mocks.onSave).toHaveBeenCalled();
  });
});

describe("secrets and the identity of the server", () => {
  it("disables sending the AI configuration, with a visible reason, until the identity is verified", () => {
    network();
    open(connection(), serverState({ status: "error", message: t("personalServer.identity.changed") }));
    render(<Harness />);
    const send = button("personalServer.sendAi");
    expect(send).toBeDisabled();
    const reason = screen.getByText(t("personalServer.sendAiBlocked"));
    expect(send.getAttribute("aria-describedby")).toBe(reason.id);
    cleanup();

    open(connection({ fingerprint: undefined }), serverState({ status: "online", connection: connection({ fingerprint: undefined }) }));
    render(<Harness />);
    expect(button("personalServer.sendAi")).toBeDisabled();
    expect(screen.getByText(t("personalServer.sendAiBlocked"))).toBeInTheDocument();
    cleanup();

    open(connection(), serverState({ status: "connecting" }));
    render(<Harness />);
    expect(button("personalServer.sendAi")).toBeDisabled();
  });

  it("sends the AI configuration only after the server proved its identity", async () => {
    const fake = network();
    open(connection());
    render(<Harness />);
    expect(button("personalServer.sendAi")).toBeEnabled();
    expect(screen.queryByText(t("personalServer.sendAiBlocked"))).not.toBeInTheDocument();
    await waitFor(() => expect(fake.authenticated().length).toBeGreaterThanOrEqual(3));
    fake.requests.length = 0;
    forgetServerVerification();

    fireEvent.click(button("personalServer.sendAi"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("personalServer.aiSent") }));
    expect(fake.requests[0]).toMatchObject({ path: "/api/v1/info", authorization: null });
    const put = fake.requests.find((request) => request.method === "PUT" && request.path === "/api/v1/ai");
    expect(put?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(put?.body)).toContain("sk-super-secret-api-key");
  });

  it("does not send the AI keys to a server that is not the one this device paired with", async () => {
    const fake = createFakeNetwork({ [ORIGIN]: { identity: other, token: TOKEN } });
    vi.stubGlobal("fetch", fake.fetch);
    open(connection());
    render(<Harness />);
    fireEvent.click(button("personalServer.sendAi"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("personalServer.failed"), description: t("personalServer.identity.changed") })));
    expect(fake.authenticated()).toHaveLength(0);
    expect(JSON.stringify(fake.requests)).not.toContain("sk-super-secret-api-key");
  });

  it("pins the server the first time only when its signature was verified", async () => {
    const fake = network();
    open(connection({ fingerprint: undefined, serverId: undefined }), serverState({ status: "error", connection: connection({ fingerprint: undefined, serverId: undefined }) }));
    render(<Harness />);
    fireEvent.click(button("personalServer.test"));
    await waitFor(() => expect(useSettingsStore.getState().settings.personalServer?.fingerprint).toBe(identity.fingerprint));
    expect(fake.requests[0]).toMatchObject({ path: "/api/v1/info", authorization: null });
    expect(fake.authenticated().length).toBeGreaterThan(0);
    expect(mocks.reconnectServer).toHaveBeenCalled();
  });

  it("refuses to pin a server whose signature this browser cannot check, and sends it no token", async () => {
    const fake = network();
    vi.spyOn(crypto.subtle, "importKey").mockRejectedValue(new Error("Unrecognized algorithm name"));
    open(connection({ fingerprint: undefined, serverId: undefined }), serverState({ status: "error", connection: connection({ fingerprint: undefined, serverId: undefined }) }));
    render(<Harness />);
    fireEvent.click(button("personalServer.test"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("personalServer.failed"), description: t("personalServer.identity.unsupported") })));
    expect(fake.authenticated()).toHaveLength(0);
    expect(useSettingsStore.getState().settings.personalServer?.fingerprint).toBeUndefined();
  });
});

describe("disconnecting", () => {
  it("revokes the token on the server it was paired with, without a warning", async () => {
    const fake = network();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    open(connection());
    render(<Harness />);
    fireEvent.click(button("personalServer.disconnect"));
    await waitFor(() => expect(useSettingsStore.getState().settings.personalServer).toBeUndefined());
    expect(fake.requests.some((request) => request.method === "DELETE" && request.path === "/api/v1/session" && request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: t("personalServer.disconnectUnrevoked.title") }));
  });

  it.each([
    ["the server fails", () => createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN, failWith: 500 } })],
    ["the server is not the one it was paired with", () => createFakeNetwork({ [ORIGIN]: { identity: other, token: TOKEN } })],
  ])("tells the author the token may still be valid when %s", async (_name, makeNetwork) => {
    vi.stubGlobal("fetch", makeNetwork().fetch);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    open(connection());
    render(<Harness />);
    fireEvent.click(button("personalServer.disconnect"));
    await waitFor(() => expect(useSettingsStore.getState().settings.personalServer).toBeUndefined());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("personalServer.disconnectUnrevoked.title"), description: t("personalServer.disconnectUnrevoked.body"), variant: "destructive" }));
  });

  it("tells the author when the server cannot be reached at all", async () => {
    const fake = createFakeNetwork({});
    vi.stubGlobal("fetch", fake.fetch);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    open(connection());
    render(<Harness />);
    fireEvent.click(button("personalServer.disconnect"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("personalServer.disconnectUnrevoked.title") })));
    expect(useSettingsStore.getState().settings.personalServer).toBeUndefined();
  });

  it("stays quiet when the server says the token is not valid anyway", async () => {
    network({ token: "nrs_another_token" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    open(connection());
    render(<Harness />);
    fireEvent.click(button("personalServer.disconnect"));
    await waitFor(() => expect(useSettingsStore.getState().settings.personalServer).toBeUndefined());
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: t("personalServer.disconnectUnrevoked.title") }));
  });
});

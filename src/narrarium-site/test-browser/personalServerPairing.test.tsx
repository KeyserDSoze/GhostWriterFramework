import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: vi.fn(), reconnectServer: vi.fn(), onSave: vi.fn(async () => undefined) }));

vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => ({ reconnectServer: mocks.reconnectServer }) }));

import { NarrariumServerClient, ServerRequestError, type ServerInfo } from "narrarium-engine";
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

function connection(patch: Partial<PersonalServerSettings> = {}): PersonalServerSettings {
  return { url: ORIGIN, token: TOKEN, serverId: identity.serverId, fingerprint: identity.fingerprint, clientLabel: "Test device", ...patch };
}

function serverState(info: Partial<ServerInfo> | null = {}, patch: Partial<ServerConnectionState> = {}): ServerConnectionState {
  return {
    status: "online",
    info: info === null ? null : { name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.0", engineVersion: "0.1.1", serverId: identity.serverId, label: "Home", git: true, features: [], ...info } as ServerInfo,
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

function network(server: Partial<FakeServer> = {}) {
  const fake = createFakeNetwork({ [ORIGIN]: { identity, token: TOKEN, label: "Home server", ...server } });
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

function approval() {
  let approve: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { approve = resolve; });
  return { promise, approve };
}

/** Types the address and the code of a device that is about to pair, and presses Pair. */
async function startPairing() {
  open(undefined, null);
  render(<Harness />);
  act(() => { fireEvent.change(urlField(), { target: { value: ORIGIN } }); });
  fireEvent.change(screen.getByLabelText(t("personalServer.pair.code")), { target: { value: "123456789" } });
  fireEvent.click(button("personalServer.pair.start"));
}

/** The status of the pairing while it goes on: the one thing on the screen that is announced politely. */
const waiting = () => screen.getByRole("status") as HTMLElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  forgetServerVerification();
  identity = await createFakeIdentity();
  mocks.toast.mockReset();
  mocks.reconnectServer.mockReset();
  mocks.onSave.mockClear();
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  await i18n.changeLanguage("en");
});

describe("pairing: the code that tells the owner this request is yours", () => {
  it("shows the four digits of the request while the owner has not approved yet", async () => {
    const owner = approval();
    network({ pairing: { requestVerification: "4821", tokenVerification: "0097", approval: owner.promise } });
    await startPairing();

    const status = await waitFor(() => {
      const element = waiting();
      expect(element).toHaveTextContent("4821");
      return element;
    });
    expect(status).toHaveTextContent(t("personalServer.pair.verification"));
    expect(status).toHaveTextContent(t("personalServer.pair.verificationWarning"));
    expect(within(status).getByText("4821")).toBeInTheDocument();
    expect(status, "the digits the token will have are not shown until the owner has approved").not.toHaveTextContent("0097");
    expect(status.getAttribute("role")).toBe("status");

    owner.approve();
    await waitFor(() => expect(useSettingsStore.getState().settings.personalServer?.token).toBe(TOKEN));
  });

  it("reads the digits one by one to a screen reader, who would otherwise hear a number", async () => {
    const owner = approval();
    network({ pairing: { requestVerification: "4821", approval: owner.promise } });
    await startPairing();
    const status = await waitFor(() => { const element = waiting(); expect(element).toHaveTextContent("4821"); return element; });
    expect(within(status).getByText("4 8 2 1")).toHaveClass("sr-only");
    expect(within(status).getByText("4821")).toHaveAttribute("aria-hidden", "true");
    owner.approve();
  });

  it("says it in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    const owner = approval();
    network({ pairing: { requestVerification: "4821", approval: owner.promise } });
    await startPairing();
    const status = await waitFor(() => { const element = waiting(); expect(element).toHaveTextContent("4821"); return element; });
    expect(status).toHaveTextContent("Controlla che il pannello di amministrazione del server mostri questo codice accanto alla richiesta");
    owner.approve();
  });

  it("shows no code, and does not fail, for a server that sends none", async () => {
    const owner = approval();
    network({ pairing: { approval: owner.promise } });
    await startPairing();
    const status = await waitFor(() => waiting());
    expect(status).not.toHaveTextContent(t("personalServer.pair.verification"));
    owner.approve();
    await waitFor(() => expect(useSettingsStore.getState().settings.personalServer?.token).toBe(TOKEN));
    expect(mocks.toast).toHaveBeenCalledWith({ title: t("personalServer.pair.done", { label: "Home server" }) });
  });

  it("tells the author which code this device has in the panel once the owner approved", async () => {
    network({ pairing: { requestVerification: "4821", tokenVerification: "0097" } });
    await startPairing();
    await waitFor(() => expect(useSettingsStore.getState().settings.personalServer?.token).toBe(TOKEN));
    expect(mocks.toast).toHaveBeenCalledWith({ title: t("personalServer.pair.done", { label: "Home server" }), description: t("personalServer.pair.doneCode", { code: "0097" }) });
    expect(t("personalServer.pair.doneCode", { code: "0097" })).toContain("0097");
  });

  it("goes away with the pairing, so a code is never left on the screen after cancelling", async () => {
    const owner = approval();
    network({ pairing: { requestVerification: "4821", approval: owner.promise } });
    await startPairing();
    await waitFor(() => expect(waiting()).toHaveTextContent("4821"));
    fireEvent.click(button("personalServer.pair.cancel"));
    await waitFor(() => expect(screen.queryByText("4821")).not.toBeInTheDocument());
    expect(useSettingsStore.getState().settings.personalServer?.token ?? "", "nothing was paired").toBe("");
  });
});

describe("a server that does not speak the API of this app", () => {
  const notice = () => screen.getByRole("alert") as HTMLElement;

  it("is announced for good when the server is older than the app, with the words of the engine, and blocks nothing", () => {
    network();
    open(connection(), serverState({ apiVersion: 0 }));
    render(<Harness />);
    const warning = notice();
    expect(warning).toHaveTextContent(t("personalServer.compat.older"));
    expect(warning).toHaveTextContent("The personal server speaks API version 0; this app supports 1: update the server.");
    for (const key of ["personalServer.test", "personalServer.sendAi", "personalServer.disconnect"]) expect(button(key)).toBeEnabled();
  });

  it("is announced for good when the server is newer than the app", () => {
    network();
    open(connection(), serverState({ apiVersion: 2 }));
    render(<Harness />);
    expect(notice()).toHaveTextContent(t("personalServer.compat.newer"));
    expect(notice()).toHaveTextContent("The personal server speaks API version 2; this app supports 1: update Narrarium.");
    expect(button("personalServer.sendAi")).toBeEnabled();
  });

  it("takes a server that does not say which API it speaks for an older one", () => {
    network();
    open(connection(), serverState({ apiVersion: undefined }));
    render(<Harness />);
    expect(notice()).toHaveTextContent(t("personalServer.compat.older"));
  });

  it("says the same in Italian, and marks the engine's English words as English", async () => {
    await i18n.changeLanguage("it");
    network();
    open(connection(), serverState({ apiVersion: 2 }));
    render(<Harness />);
    expect(notice()).toHaveTextContent("Il server è più nuovo di questa app");
    const english = within(notice()).getByText("The personal server speaks API version 2; this app supports 1: update Narrarium.");
    expect(english.getAttribute("lang")).toBe("en");
  });

  it("says nothing when the server speaks the API of the app, or while there is no connection", () => {
    network();
    open(connection(), serverState({ apiVersion: 1 }));
    const view = render(<Harness />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.unmount();

    open(connection(), serverState(null, { status: "connecting" }));
    render(<Harness />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("is shown while pairing too, before the token is even asked for", async () => {
    const owner = approval();
    network({ apiVersion: 2, pairing: { requestVerification: "4821", approval: owner.promise } });
    await startPairing();
    await waitFor(() => expect(waiting()).toHaveTextContent("4821"));
    expect(screen.getByRole("alert")).toHaveTextContent(t("personalServer.compat.newer"));
    owner.approve();
    await waitFor(() => expect(useSettingsStore.getState().settings.personalServer?.token).toBe(TOKEN));
  });
});

describe("disconnecting", () => {
  it("signs out on the server first, with the token this device still holds, and then forgets it", async () => {
    network();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let tokenWhenSignedOut: string | undefined;
    const signOut = vi.spyOn(NarrariumServerClient.prototype, "signOut").mockImplementation(async () => {
      tokenWhenSignedOut = useSettingsStore.getState().settings.personalServer?.token;
      return { revoked: true };
    });
    open(connection());
    render(<Harness />);
    fireEvent.click(button("personalServer.disconnect"));
    await waitFor(() => expect(useSettingsStore.getState().settings.personalServer).toBeUndefined());
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(tokenWhenSignedOut).toBe(TOKEN);
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: t("personalServer.disconnectUnrevoked.title") }));
  });

  it("forgets the token even when the server cannot be reached, and says it may still be valid there", async () => {
    network();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(NarrariumServerClient.prototype, "signOut").mockRejectedValue(new ServerRequestError("The personal server is not reachable.", 0, "unreachable"));
    open(connection());
    render(<Harness />);
    fireEvent.click(button("personalServer.disconnect"));
    await waitFor(() => expect(useSettingsStore.getState().settings.personalServer).toBeUndefined());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("personalServer.disconnectUnrevoked.title") })));
    expect(mocks.onSave).toHaveBeenCalled();
  });

  it("stays quiet when the token was already revoked", async () => {
    network();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(NarrariumServerClient.prototype, "signOut").mockResolvedValue({ revoked: false });
    open(connection());
    render(<Harness />);
    fireEvent.click(button("personalServer.disconnect"));
    await waitFor(() => expect(useSettingsStore.getState().settings.personalServer).toBeUndefined());
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: t("personalServer.disconnectUnrevoked.title") }));
  });
});

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerInfo } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ read: vi.fn(async (..._args: unknown[]): Promise<unknown> => null), reconnectServer: vi.fn(), clientId: "Iv1.0123456789abcdef" }));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => ({ readServerGitHub: mocks.read, reconnectServer: mocks.reconnectServer }) }));
vi.mock("@/config/publicClients", () => ({ get GITHUB_APP_CLIENT_ID() { return mocks.clientId; } }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }), toast: vi.fn() }));

import i18n from "@/i18n";
import { PersonalServerSettingsBody } from "@/components/settings/PersonalServerSettingsBody";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type PersonalServerSettings } from "@/types/settings";

const PIN = "a".repeat(64);
const CONNECTION: PersonalServerSettings = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const INFO = { name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.23", engineVersion: "0.1.28", serverId: "s", label: "Home", git: true, features: ["github", "server-github-connection"] } as ServerInfo;

function Harness() {
  const settings = useSettingsStore((state) => state.settings);
  const patchSettings = useSettingsStore((state) => state.patchSettings);
  return <PersonalServerSettingsBody settings={settings} patchSettings={patchSettings} />;
}

function open(server: Record<string, unknown> = {}) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, personalServer: CONNECTION } });
  useAutopilotStore.setState({ server: { status: "online", info: INFO, message: null, books: [], updates: null, connection: CONNECTION, ...server } as never });
  return render(<Harness />);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.read.mockReset().mockImplementation(async () => { useAutopilotStore.getState().setServer({ githubConnection: { state: "disconnected" } }); return null; });
  mocks.clientId = "Iv1.0123456789abcdef";
  vi.stubEnv("VITE_AUTH_BROKER_BASE", "https://auth.example.com");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("Settings → Personal server → the server's own GitHub connection", () => {
  it("shows its card, a chunk of its own, once a server is online, and asks the server for the status when the card is shown", async () => {
    open();
    // The card and its texts are one lazy chunk: the card is there first, and its words with it.
    await screen.findByTestId("server-github-card");
    expect(screen.getByRole("heading", { name: i18n.t("serverGitHub.title") as string })).toBeInTheDocument();
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: i18n.t("serverGitHub.connect") as string })).toBeInTheDocument();
  });

  it("does not show it, nor ask anything of the server's connection, while no server is online", async () => {
    open({ status: "offline" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("server-github-card")).not.toBeInTheDocument();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("says in one line that an older server has to be updated, and the rest of the page is as it was", async () => {
    open({ info: { ...INFO, features: ["github"] } });
    await screen.findByTestId("server-github-card");
    expect(screen.getByText(i18n.t("serverGitHub.oldServer") as string)).toBeInTheDocument();
    expect(screen.getByText(i18n.t("personalServer.statusLabel") as string)).toBeInTheDocument();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

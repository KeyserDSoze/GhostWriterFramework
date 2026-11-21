import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { serverConnectionFor, useServerConnection } from "@/autopilot/serverConnection";
import { useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";

const INFO = { name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.0", engineVersion: "0.1.1", serverId: "id", label: "Home", git: true, features: [] } as ServerConnectionState["info"];
const BOOK = { bookId: "b", title: "B", storage: { kind: "local" }, hasGithubToken: false, ready: true, revision: "r", autopilot: null, running: false, lastSync: null } as ServerConnectionState["books"][number];
const PIN = "f".repeat(64);

function online(url = "http://127.0.0.1:24242", token = "nrs_a"): ServerConnectionState {
  return { status: "online", info: INFO, message: null, books: [BOOK], updates: null, connection: { url, token, fingerprint: PIN } };
}

afterEach(() => {
  useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("serverConnectionFor", () => {
  it("keeps the live state while the settings still describe the connection that was followed", () => {
    const server = online();
    expect(serverConnectionFor(server, { url: "http://127.0.0.1:24242", token: "nrs_a", fingerprint: PIN })).toBe(server);
  });

  it("is not online as soon as the address or the token differs from the followed connection", () => {
    for (const typed of [{ url: "http://127.0.0.1:2424", token: "nrs_a" }, { url: "http://127.0.0.1:24242", token: "nrs_" }, { url: "https://h", token: "nrs_a" }]) {
      expect(serverConnectionFor(online(), { ...typed, fingerprint: PIN })).toMatchObject({ status: "connecting", info: null, message: null, books: [], updates: null, connection: null });
    }
  });

  it("is not online either when the pinned identity changed since the connection was followed", () => {
    expect(serverConnectionFor(online(), { url: "http://127.0.0.1:24242", token: "nrs_a", fingerprint: "a".repeat(64) }).status).toBe("connecting");
    expect(serverConnectionFor(online(), { url: "http://127.0.0.1:24242", token: "nrs_a" }).status).toBe("connecting");
  });

  it("is not configured once the address or the token is cleared", () => {
    expect(serverConnectionFor(online(), { url: "", token: "nrs_a", fingerprint: PIN }).status).toBe("disabled");
    expect(serverConnectionFor(online(), { url: "http://127.0.0.1:24242", token: "  ", fingerprint: PIN }).status).toBe("disabled");
    expect(serverConnectionFor(online(), undefined).status).toBe("disabled");
  });

  it("waits for the connection when nothing is followed yet", () => {
    const idle: ServerConnectionState = { status: "disabled", info: null, message: null, books: [], updates: null, connection: null };
    expect(serverConnectionFor(idle, { url: "http://127.0.0.1:24242", token: "nrs_a", fingerprint: PIN }).status).toBe("connecting");
  });
});

describe("useServerConnection", () => {
  it("drops the online status in the same render that changes the address, then follows the runtime again", () => {
    useAutopilotStore.setState({ server: online() });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, personalServer: { url: "http://127.0.0.1:24242", token: "nrs_a", fingerprint: PIN } } });
    const { result } = renderHook(() => useServerConnection());
    expect(result.current.status).toBe("online");

    act(() => useSettingsStore.getState().patchSettings({ personalServer: { url: "http://127.0.0.1:2424", token: "nrs_a", fingerprint: PIN } }));
    expect(result.current.status).toBe("connecting");
    expect(result.current.books).toEqual([]);

    act(() => useAutopilotStore.getState().setServer({ ...online("http://127.0.0.1:2424"), status: "connecting" }));
    expect(result.current.status).toBe("connecting");
    act(() => useAutopilotStore.getState().setServer({ status: "online" }));
    expect(result.current.status).toBe("online");
  });
});

import { useMemo } from "react";
import { useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * The personal-server status as the settings describe the connection right now. The runtime follows
 * a new address, token or pinned identity only after a short delay, and its status belongs to the
 * connection it followed: until then what is being typed is neither online nor where secrets go.
 */
export function serverConnectionFor(server: ServerConnectionState, typed: { url?: string; token?: string; fingerprint?: string } | undefined): ServerConnectionState {
  const url = typed?.url ?? "";
  const token = typed?.token ?? "";
  const idle = { info: null, message: null, books: [], updates: null, connection: null };
  if (!url.trim() || !token.trim()) return { ...server, ...idle, status: "disabled" };
  const followed = server.connection;
  if (followed?.url === url && followed.token === token && (followed.fingerprint ?? "") === (typed?.fingerprint ?? "")) return server;
  return { ...server, ...idle, status: "connecting" };
}

export function useServerConnection(): ServerConnectionState {
  const server = useAutopilotStore((state) => state.server);
  const url = useSettingsStore((state) => state.settings.personalServer?.url);
  const token = useSettingsStore((state) => state.settings.personalServer?.token);
  const fingerprint = useSettingsStore((state) => state.settings.personalServer?.fingerprint);
  return useMemo(() => serverConnectionFor(server, { url, token, fingerprint }), [server, url, token, fingerprint]);
}

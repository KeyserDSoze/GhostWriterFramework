import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerGitHubConnection } from "narrarium-engine";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { describeServerGitHubError } from "@/autopilot/serverGitHubText";
import { pollDelayMs, serverGitHubOffer, type ServerGitHubOffer } from "@/autopilot/serverGitHub";
import { useServerConnection } from "@/autopilot/serverConnection";
import { useAutopilotStore } from "@/autopilot/store";

export type ServerGitHubBusy = "connecting" | "disconnecting";

export interface ServerGitHub {
  /** Whether the connection can be offered here, and why not (`unavailable`: the server is not online, so there is nothing to ask). */
  offer: ServerGitHubOffer | "unavailable";
  /** What the server said last; `undefined` until it has been asked, `null` for a server that does not have the feature. */
  connection: ServerGitHubConnection | null | undefined;
  /** A request that this screen made is on its way. */
  busy: ServerGitHubBusy | null;
  /** The words of a request that failed (the server could not be reached, refused it…), until the next one works. */
  error: string | null;
  /** Each resolves with whether the server did it (a failure is in `error`). */
  connect: () => Promise<boolean>;
  disconnect: () => Promise<boolean>;
  /** Ask the server again now. */
  refresh: () => Promise<void>;
}

/**
 * The server's own connection to GitHub for a screen that shows it. The server is asked once when the screen opens with `active` (a card on screen, a choice the author made), never when
 * a page mounts, and again every few seconds only while the server waits for the owner to type the code (the interval it asks GitHub at, longer after failures) and the tab is in view:
 * the polling stops when the screen goes away, when the tab is hidden, and as soon as the state is anything but `pending`. GitHub itself is never asked from here.
 */
export function useServerGitHub({ active }: { active: boolean }): ServerGitHub {
  const server = useServerConnection();
  const connection = useAutopilotStore((state) => state.server.githubConnection);
  const online = server.status === "online";
  const offer = online ? serverGitHubOffer(server.info) : "unavailable";
  const [busy, setBusy] = useState<ServerGitHubBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const followed = server.connection ? `${server.connection.url}#${server.connection.token}` : "";
  const reading = active && offer !== "unavailable" && offer !== "old-server";
  const pending = reading && connection?.state === "pending";

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      await (await loadAutopilotRuntime()).readServerGitHub();
      if (alive.current) setError(null);
    } catch (failure) {
      if (alive.current) setError(describeServerGitHubError(failure));
      throw failure;
    }
  }, []);

  // Once, when the screen opens (or the server it follows changes).
  useEffect(() => {
    if (!reading) return;
    void refresh().catch(() => undefined);
  }, [reading, followed, refresh]);

  // While the server waits for the owner: asked again, in view only.
  useEffect(() => {
    if (!pending) return;
    let timer: number | undefined;
    let failures = 0;
    let stopped = false;
    const schedule = () => {
      if (stopped || document.visibilityState === "hidden") return;
      timer = window.setTimeout(() => {
        void refresh().then(() => { failures = 0; }, () => { failures += 1; }).finally(schedule);
      }, pollDelayMs(useAutopilotStore.getState().server.githubConnection, failures));
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void refresh().catch(() => undefined).finally(schedule);
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pending, refresh]);

  const run = useCallback(async (kind: ServerGitHubBusy, action: (runtime: Awaited<ReturnType<typeof loadAutopilotRuntime>>) => Promise<unknown>): Promise<boolean> => {
    setBusy(kind);
    setError(null);
    try {
      await action(await loadAutopilotRuntime());
      return true;
    } catch (failure) {
      if (alive.current) setError(describeServerGitHubError(failure));
      return false;
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);

  const connect = useCallback(() => run("connecting", (runtime) => runtime.connectServerGitHub()), [run]);
  const disconnect = useCallback(() => run("disconnecting", (runtime) => runtime.disconnectServerGitHub()), [run]);

  return { offer, connection, busy, error, connect, disconnect, refresh };
}

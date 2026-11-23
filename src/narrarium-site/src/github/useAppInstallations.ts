import { useCallback, useEffect, useState } from "react";
import { InstallationsError, loadAppInstallations, type AppInstallation, type InstallErrorReason } from "@/github/githubAppInstall";

export type InstallationsState =
  | { status: "idle" }
  | { status: "loading"; installations: AppInstallation[] | null }
  | { status: "ready"; installations: AppInstallation[] }
  | { status: "error"; reason: InstallErrorReason; httpStatus?: number; installations: AppInstallation[] | null };

/** Where the app is installed, read when `enabled` and again on `reload` (after the person came back from GitHub). */
export function useAppInstallations(token: string | undefined, enabled: boolean): InstallationsState & { reload: () => void } {
  const [state, setState] = useState<InstallationsState>({ status: "idle" });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !token) { setState({ status: "idle" }); return; }
    let current = true;
    const controller = new AbortController();
    setState((before) => ({ status: "loading", installations: before.status === "ready" || before.status === "error" ? before.installations : null }));
    void loadAppInstallations(token, { signal: controller.signal }).then(
      (installations) => { if (current) setState({ status: "ready", installations }); },
      (error: unknown) => {
        if (!current || (error as { name?: string })?.name === "AbortError") return;
        const failure = error instanceof InstallationsError ? error : new InstallationsError("unknown");
        setState((before) => ({ status: "error", reason: failure.reason, ...(failure.status ? { httpStatus: failure.status } : {}), installations: before.status === "ready" || before.status === "loading" ? before.installations : null }));
      },
    );
    return () => { current = false; controller.abort(); };
  }, [token, enabled, tick]);

  return { ...state, reload };
}

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStatusPill } from "@/components/layout/SessionStatusPill";
import { useConnectionStore } from "@/account/connectionStore";
import { useAccountSyncStore } from "@/account/accountSync";
import { useUiStore } from "@/store/uiStore";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe("session account sync status", () => {
  beforeEach(() => {
    useUiStore.setState({ authActivity: "idle" });
    useAccountSyncStore.setState({ syncing: false, reconciliation: null });
    useConnectionStore.setState({
      hydrated: true,
      configuration: {
        google: {
          backend: "google-drive",
          method: "google",
          identity: { provider: "google", providerAccountId: "google-1", displayName: "Google Writer" },
          accessToken: "google-token",
          rememberMe: true,
          replica: { enabled: true, status: "idle" },
        },
        microsoft: {
          backend: "onedrive",
          method: "microsoft",
          identity: { provider: "microsoft", providerAccountId: "microsoft-1", displayName: "Microsoft Writer" },
          accessToken: "microsoft-token",
          homeAccountId: "microsoft-1",
          localAccountId: "local-microsoft-1",
          rememberMe: true,
          replica: { enabled: true, status: "error", errorKind: "unknown" },
        },
      },
    });
  });

  afterEach(cleanup);

  it("identifies the failed provider instead of reporting a completed Google sync as pending", () => {
    render(<SessionStatusPill />);

    expect(screen.getByText("Saved locally · OneDrive sync failed")).toBeInTheDocument();
    expect(screen.queryByText("Saved locally · Sync pending")).not.toBeInTheDocument();
  });

  it("keeps the pending label for a replica with unsynchronized local changes", () => {
    useConnectionStore.setState((state) => ({
      configuration: {
        ...state.configuration,
        microsoft: state.configuration.microsoft && {
          ...state.configuration.microsoft,
          replica: { ...state.configuration.microsoft.replica, status: "dirty" },
        },
      },
    }));

    render(<SessionStatusPill />);

    expect(screen.getByText("Saved locally · Sync pending")).toBeInTheDocument();
  });
});

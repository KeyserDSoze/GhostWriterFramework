import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { useAuthStore, type AppUser } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";

const cloud = vi.hoisted(() => ({
  save: vi.fn(),
}));

vi.mock("@/drive/cloudSettingsClient", () => ({
  TokenExpiredError: class TokenExpiredError extends Error {},
  loadCloudSettings: vi.fn(),
  saveCloudSettings: cloud.save,
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function googleUser(id: string): AppUser {
  return { provider: "google", providerAccountId: id, name: id, email: `${id}@example.test`, picture: "" };
}

beforeEach(() => {
  cloud.save.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

it("does not apply an offline-conflict save after the account generation changes", async () => {
  let complete!: (value: { fileId: string; revision: string }) => void;
  cloud.save.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  useAuthStore.setState({ accessToken: "token-a", accessTokenExpiry: Date.now() + 60_000, user: googleUser("account-a") });
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, language: "it" } },
    accountIdentity: "google:account-a",
    accountGeneration: 4,
    driveFileId: "a-file",
    cloudRevision: "a-revision",
    syncStatus: "idle",
    offlineConflict: { cloudSettings: DEFAULT_SETTINGS, cloudRevision: "a-cloud-revision", fileId: "a-cloud-file", changedKeys: ["ui"] },
  });
  const { result } = renderHook(() => useSettingsForTest());
  let resolution!: Promise<void>;
  act(() => { resolution = result.current.resolveOfflineConflict("local"); });
  await vi.waitFor(() => expect(cloud.save).toHaveBeenCalledTimes(1));

  act(() => {
    useAuthStore.setState({ accessToken: "token-b", accessTokenExpiry: Date.now() + 60_000, user: googleUser("account-b") });
    useSettingsStore.setState({ accountIdentity: "google:account-b", accountGeneration: 5, driveFileId: "b-file", cloudRevision: "b-revision", syncStatus: "idle", offlineConflict: null });
  });
  complete({ fileId: "saved-a-file", revision: "saved-a-revision" });
  await act(async () => { await resolution; });

  expect(useSettingsStore.getState()).toMatchObject({ accountIdentity: "google:account-b", accountGeneration: 5, driveFileId: "b-file", cloudRevision: "b-revision", syncStatus: "idle", offlineConflict: null });
  expect(JSON.stringify(localStorage)).not.toContain("saved-a-revision");
});

async function importUseSettings() {
  return (await import("@/drive/useSettings")).useSettings;
}

const useSettingsForTest = await importUseSettings();

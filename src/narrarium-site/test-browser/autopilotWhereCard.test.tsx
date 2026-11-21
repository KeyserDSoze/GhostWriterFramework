import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ moveToServer: vi.fn(async () => undefined), save: vi.fn(async () => true), toast: vi.fn() }));

vi.mock("@/autopilot/loader", () => ({
  loadAutopilotRuntime: async () => ({ moveToServer: mocks.moveToServer, moveToBrowser: vi.fn(), syncWithServer: vi.fn(), describeError: (error: unknown) => String(error) }),
}));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { WhereCard } from "@/pages/AutopilotPage";
import { useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry, type PersonalServerSettings } from "@/types/settings";

const t = (key: string) => i18n.t(key) as string;
const PIN = "a".repeat(64);
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };

function connection(patch: Partial<PersonalServerSettings> = {}): PersonalServerSettings {
  return { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN, ...patch };
}

function open(server: Partial<ServerConnectionState>, typed: PersonalServerSettings | null = connection()) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], personalServer: typed ?? undefined } });
  useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null, ...server } });
  render(<MemoryRouter><WhereCard book={BOOK} running={false} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("radio", { name: t("autopilot.where.server") }));
}

const move = () => screen.getByRole("button", { name: t("autopilot.where.move") }) as HTMLButtonElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  mocks.moveToServer.mockClear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null }, views: {} });
});

describe("moving a book to the personal server", () => {
  it("is disabled, with the reason next to it, when no server is connected", () => {
    open({}, null);
    expect(move()).toBeDisabled();
    const reason = screen.getByText(t("autopilot.where.noServer"), { exact: false });
    expect(move().getAttribute("aria-describedby")).toBe(reason.id);
  });

  it.each(["connecting", "offline", "error"] as const)("is disabled while the server is %s: its identity is not verified", (status) => {
    open({ status, connection: connection(), message: status === "error" ? t("personalServer.identity.changed") : null });
    expect(move()).toBeDisabled();
    const reason = screen.getByText(t("autopilot.where.serverUnverified"), { exact: false });
    expect(reason).toHaveAttribute("role", "note");
    expect(move().getAttribute("aria-describedby")).toBe(reason.id);
    expect(screen.queryByText(t("autopilot.where.consentAi"))).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("personalServer.title") })).toHaveAttribute("href", "/app/settings/server");
  });

  it("is disabled as soon as the address is changed, even though the runtime still reports the old server online", () => {
    open({ status: "online", connection: connection() }, connection({ url: "http://127.0.0.1:2424" }));
    expect(move()).toBeDisabled();
    expect(screen.getByText(t("autopilot.where.serverUnverified"), { exact: false })).toBeInTheDocument();
  });

  it("is enabled for a verified server, and asks for the author's consent before secrets travel", async () => {
    open({ status: "online", connection: connection() });
    expect(move()).toBeEnabled();
    expect(move().hasAttribute("aria-describedby")).toBe(false);
    expect(screen.getByLabelText(t("autopilot.where.consentAi"))).toBeChecked();
    fireEvent.click(screen.getByLabelText(t("autopilot.where.consentAi")));
    fireEvent.click(move());
    await waitFor(() => expect(mocks.moveToServer).toHaveBeenCalledWith(BOOK.id, { sendAiConfiguration: false, sendGitHubToken: false }));
  });
});

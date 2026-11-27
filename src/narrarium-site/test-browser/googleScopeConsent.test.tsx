import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const drive = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock("@/drive/exportDriveClient", async (importOriginal) => ({ ...await importOriginal<typeof import("@/drive/exportDriveClient")>(), listGoogleDriveFolders: drive.list, createGoogleDriveFolder: drive.create }));

import i18n from "@/i18n";
import { GoogleScopeConsentError, requestGoogleScope } from "@/account/googleScopeConsent";
import { GoogleFullAccessNotice } from "@/components/auth/GoogleFullAccessNotice";
import { GoogleDriveFolderDialog } from "@/components/book/GoogleDriveFolderDialog";
import { GOOGLE_SCOPE_FULL_DRIVE, GOOGLE_SCOPE_FILE, includesRestrictedGoogleScope } from "@/config/googleAuth";

type Callbacks = { callback: (response: Record<string, unknown>) => void; error_callback: (error: { type?: string }) => void };
const gis = { configs: [] as Array<Record<string, unknown>>, requested: 0, answer: ((callbacks: Callbacks) => callbacks.callback({ access_token: "ya29.full", expires_in: 3599, scope: `openid ${GOOGLE_SCOPE_FULL_DRIVE}` })) as (callbacks: Callbacks) => void };

beforeEach(() => {
  gis.configs = [];
  gis.requested = 0;
  gis.answer = (callbacks) => callbacks.callback({ access_token: "ya29.full", expires_in: 3599, scope: `openid ${GOOGLE_SCOPE_FULL_DRIVE}` });
  (window as unknown as { google?: unknown }).google = { accounts: { oauth2: { initTokenClient: (config: Record<string, unknown> & Callbacks) => { gis.configs.push(config); return { requestAccessToken: () => { gis.requested += 1; gis.answer(config); } }; } } } };
  drive.list.mockReset().mockResolvedValue([{ id: "f1", name: "Narrarium exports" }]);
});
afterEach(async () => { cleanup(); delete (window as unknown as { google?: unknown }).google; await i18n.changeLanguage("en"); });

describe("asking Google for one more scope", () => {
  it("asks for that one scope, keeps what was granted before, and hints the account", async () => {
    const grant = await requestGoogleScope(GOOGLE_SCOPE_FULL_DRIVE, { hint: "ada@example.test" });
    expect(gis.configs).toHaveLength(1);
    expect(gis.configs[0]).toMatchObject({ scope: GOOGLE_SCOPE_FULL_DRIVE, include_granted_scopes: true, hint: "ada@example.test" });
    expect(String(gis.configs[0].client_id)).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(grant).toMatchObject({ accessToken: "ya29.full", scopes: ["openid", GOOGLE_SCOPE_FULL_DRIVE] });
    expect(grant.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it("does not take a permission that was unticked on the consent screen for given", async () => {
    gis.answer = (callbacks) => callbacks.callback({ access_token: "ya29.x", expires_in: 3599, scope: "openid" });
    await expect(requestGoogleScope(GOOGLE_SCOPE_FULL_DRIVE)).rejects.toMatchObject({ reason: "denied" });
  });

  it.each([
    [{ error: "access_denied" }, "denied"],
    [{ error: "server_error" }, "failed"],
  ])("says why it did not get it (%j)", async (response, reason) => {
    gis.answer = (callbacks) => callbacks.callback(response);
    await expect(requestGoogleScope(GOOGLE_SCOPE_FILE)).rejects.toBeInstanceOf(GoogleScopeConsentError);
    await expect(requestGoogleScope(GOOGLE_SCOPE_FILE)).rejects.toMatchObject({ reason });
  });

  it("tells a blocked window from a closed one, and Google not being loaded", async () => {
    gis.answer = (callbacks) => callbacks.error_callback({ type: "popup_failed_to_open" });
    await expect(requestGoogleScope(GOOGLE_SCOPE_FILE)).rejects.toMatchObject({ reason: "popup-blocked" });
    gis.answer = (callbacks) => callbacks.error_callback({ type: "popup_closed" });
    await expect(requestGoogleScope(GOOGLE_SCOPE_FILE)).rejects.toMatchObject({ reason: "denied" });
    delete (window as unknown as { google?: unknown }).google;
    await expect(requestGoogleScope(GOOGLE_SCOPE_FILE)).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("knows which scopes are restricted", () => {
    expect(includesRestrictedGoogleScope(GOOGLE_SCOPE_FULL_DRIVE)).toBe(true);
    expect(includesRestrictedGoogleScope(`openid ${GOOGLE_SCOPE_FILE}`)).toBe(false);
    expect(includesRestrictedGoogleScope(["profile", GOOGLE_SCOPE_FULL_DRIVE])).toBe(true);
  });
});

describe.each(["en", "it"] as const)("the notice for full access to Drive in %s", (language) => {
  const text = language === "en"
    ? { title: "Full access to your Google Drive is needed for this", reason: /Google shows Narrarium only the folders it created/, restricted: /restricted permission/, allow: "Allow full access to Drive", granted: /Full access to Drive is allowed until you close this page/, popup: /blocked Google's window/ }
    : { title: "Per questo serve l'accesso completo al tuo Google Drive", reason: /Google mostra a Narrarium solo le cartelle che ha creato lui/, restricted: /permesso limitato/, allow: "Consenti l'accesso completo a Drive", granted: /L'accesso completo a Drive è consentito finché non chiudi questa pagina/, popup: /ha bloccato la finestra di Google/ };

  it("explains what Google will say, asks only on the button, and hands the token to the caller", async () => {
    await i18n.changeLanguage(language);
    const granted = vi.fn();
    render(<GoogleFullAccessNotice reason="browse" hint="ada@example.test" onGranted={granted} />);
    const notice = screen.getByTestId("google-full-access-notice");
    expect(within(notice).getByText(text.title)).toBeInTheDocument();
    expect(notice).toHaveTextContent(text.reason);
    expect(notice).toHaveTextContent(text.restricted);
    expect(gis.requested).toBe(0);
    fireEvent.click(within(notice).getByRole("button", { name: text.allow }));
    await waitFor(() => expect(granted).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "ya29.full" })));
    expect(gis.requested).toBe(1);
    expect(gis.configs[0]).toMatchObject({ scope: GOOGLE_SCOPE_FULL_DRIVE, hint: "ada@example.test" });
    expect(await screen.findByRole("status")).toHaveTextContent(text.granted);
  });

  it("says what went wrong as an alert and offers the button again", async () => {
    await i18n.changeLanguage(language);
    gis.answer = (callbacks) => callbacks.error_callback({ type: "popup_failed_to_open" });
    render(<GoogleFullAccessNotice reason="export" onGranted={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: text.allow }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text.popup);
    expect(screen.getByRole("button", { name: text.allow })).toBeEnabled();
  });
});

describe("the folder dialog of an export to Google Drive", () => {
  it("says Narrarium sees only the folders it created, and lists every folder only after the person allowed full access", async () => {
    const onFullAccess = vi.fn();
    render(<GoogleDriveFolderDialog open onOpenChange={() => undefined} accessToken="session-token" onSelect={() => undefined} onFullAccess={onFullAccess} />);
    expect(await screen.findByText("Narrarium exports")).toBeInTheDocument();
    expect(drive.list).toHaveBeenLastCalledWith("session-token", "root");
    expect(screen.getByText(/Narrarium shows the folders it created/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all my folders…" }));
    expect(gis.requested).toBe(0);
    fireEvent.click(within(screen.getByTestId("google-full-access-notice")).getByRole("button", { name: "Allow full access to Drive" }));
    await waitFor(() => expect(onFullAccess).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "ya29.full" })));
    await waitFor(() => expect(drive.list).toHaveBeenLastCalledWith("ya29.full", "root"));
    expect(screen.getByText(/All your folders are shown/)).toBeInTheDocument();
  });
});

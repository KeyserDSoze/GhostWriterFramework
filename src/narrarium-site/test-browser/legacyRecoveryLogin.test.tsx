import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { beginStrandedLegacyRecovery, consumeLegacyAccountUpgradeEvidence, legacyEmailAccountIdentity } from "@/auth/accountIdentity";
import { consumeLegacyAdoptionConsent, createLegacyAdoptionConsent, type LegacyAdoptionTarget } from "@/auth/legacyAdoptionConsent";
import { createLegacyRecoveryLoginRequest, getLegacyRecoveryLoginRequest, LEGACY_RECOVERY_LOGIN_REQUEST_KEY, matchesLegacyRecoveryLoginRequest, normalizeAppReturnTo, readLegacyRecoveryLoginRequest } from "@/auth/legacyRecoveryLogin";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { useAuthStore, type AppUser } from "@/store/authStore";
import { LEGACY_REPOSITORY_ADOPTION_DECLINED, LEGACY_REPOSITORY_AUTH_REQUIRED, LEGACY_REPOSITORY_CHANGED, LEGACY_REPOSITORY_COPY_CONFLICT } from "@/store/booksStore";

const google: AppUser = { provider: "google", providerAccountId: "google-sub", name: "Writer", email: "Writer@Example.com", picture: "" };
const microsoft: AppUser = { provider: "microsoft", providerAccountId: "home-id", homeAccountId: "home-id", localAccountId: "local-id", name: "Writer", email: "writer@example.com", picture: "" };

beforeEach(() => {
  sessionStorage.clear();
  useAuthStore.setState({ user: google, accessToken: "old-token", accessTokenExpiry: Date.now() + 60_000, interactiveRecoveryIdentity: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  void i18n.changeLanguage("en");
});

describe.each([375, 1280])("legacy recovery at %ipx", (width) => {
  it("shows only localized Italian recovery UI and preserves the exact route and pending proof", async () => {
    window.innerWidth = width;
    await i18n.changeLanguage("it");
    beginStrandedLegacyRecovery(google, legacyEmailAccountIdentity(google));
    const reload = vi.fn();
    render(
      <MemoryRouter initialEntries={["/app/books/book-1?panel=canon#secrets"]}>
        <BookStructureErrorAlert error={{ code: LEGACY_REPOSITORY_AUTH_REQUIRED }} reload={reload} />
      </MemoryRouter>,
    );

    expect(screen.getByText("Questo libro locale richiede la verifica dell'account")).toBeInTheDocument();
    expect(screen.queryByText(/interactive sign-in|legacy local working copy/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ricarica libro" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Autenticati di nuovo con Google" }));

    expect(getLegacyRecoveryLoginRequest()).toMatchObject({
      version: 1,
      provider: "google",
      immutableIdentity: "google:google-sub",
      normalizedEmail: "writer@example.com",
      returnTo: "/app/books/book-1?panel=canon#secrets",
    });
    expect(sessionStorage.getItem("narrarium-return-to")).toBe("/app/books/book-1?panel=canon#secrets");
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().interactiveRecoveryIdentity).toBe("google:google-sub");

    useAuthStore.getState().setInteractiveAuth("new-token", google);
    expect(useAuthStore.getState().interactiveRecoveryIdentity).toBeNull();
    expect(consumeLegacyAccountUpgradeEvidence(google, "google:google-sub")).toMatchObject({ immutableIdentity: "google:google-sub" });
  });
});

describe("identity-bound recovery request", () => {
  it.each([google, microsoft])("accepts the exact $provider account", (user) => {
    const request = createLegacyRecoveryLoginRequest(user, "/app/books/book-1");
    expect(matchesLegacyRecoveryLoginRequest(request, user)).toBe(true);
  });

  it("rejects a wrong provider, immutable account, or email without consuming request or pending proof", () => {
    beginStrandedLegacyRecovery(google, legacyEmailAccountIdentity(google));
    const request = createLegacyRecoveryLoginRequest(google, "/app/books/book-1");
    const wrongProvider = microsoft;
    const wrongAccount = { ...google, providerAccountId: "other-sub" };
    const wrongEmail = { ...google, email: "other@example.com" };
    expect(matchesLegacyRecoveryLoginRequest(request, wrongProvider)).toBe(false);
    expect(matchesLegacyRecoveryLoginRequest(request, wrongAccount)).toBe(false);
    expect(matchesLegacyRecoveryLoginRequest(request, wrongEmail)).toBe(false);
    expect(() => useAuthStore.getState().setInteractiveAuth("wrong", wrongAccount)).toThrow();
    expect(getLegacyRecoveryLoginRequest()?.nonce).toBe(request.nonce);

    useAuthStore.getState().setInteractiveAuth("right", google);
    expect(consumeLegacyAccountUpgradeEvidence(google, "google:google-sub")).not.toBeNull();
  });

  it("retains a valid request across cancellation/failure and identifies expired data", () => {
    const request = createLegacyRecoveryLoginRequest(google, "/app/books/book-1#draft");
    expect(getLegacyRecoveryLoginRequest()?.nonce).toBe(request.nonce);
    expect(sessionStorage.getItem(LEGACY_RECOVERY_LOGIN_REQUEST_KEY)).not.toBeNull();

    vi.spyOn(Date, "now").mockReturnValue(request.createdAt + 5 * 60_000 + 1);
    expect(getLegacyRecoveryLoginRequest()).toBeNull();
    expect(readLegacyRecoveryLoginRequest()).toMatchObject({ status: "expired" });
    expect(sessionStorage.getItem(LEGACY_RECOVERY_LOGIN_REQUEST_KEY)).not.toBeNull();
  });

  it.each([
    "https://evil.test/app/books/x",
    "//evil.test/app/books/x",
    "/\\evil.test/app/books/x",
    "/app\\evil",
    "/app/%0aevil",
    "/application/books",
    "/docs",
  ])("rejects unsafe return target %s", (value) => {
    expect(normalizeAppReturnTo(value)).toBeNull();
    expect(() => createLegacyRecoveryLoginRequest(google, value)).toThrow();
  });

  it("accepts exact internal app routes with search and hash", () => {
    expect(normalizeAppReturnTo("/app/books/book-1?panel=x#draft")).toBe("/app/books/book-1?panel=x#draft");
  });
});

describe("legacy error actions", () => {
  it.each([
    [LEGACY_REPOSITORY_COPY_CONFLICT, "Repository Status"],
    [LEGACY_REPOSITORY_ADOPTION_DECLINED, "Review adoption"],
    [LEGACY_REPOSITORY_CHANGED, "Re-inspect"],
  ] as const)("renders safe action for %s without reauthentication", (code, action) => {
    render(<MemoryRouter><BookStructureErrorAlert error={{ code }} reload={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Re-authenticate/ })).not.toBeInTheDocument();
    if (code === LEGACY_REPOSITORY_ADOPTION_DECLINED) expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it.each([
    ["en", "Confirm adoption", "one-time authorization"],
    ["it", "Conferma adozione", "autorizzazione monouso"],
  ] as const)("creates consent only after explicit localized confirmation in %s", async (language, confirmLabel, description) => {
    await i18n.changeLanguage(language);
    const reload = vi.fn();
    const target: LegacyAdoptionTarget = { bookId: "book-1", owner: "owner", repo: "repo", branch: "main", legacyIdentity: "google:writer@example.com", evidenceNonce: "evidence", replaceDisposableTarget: false };
    render(<MemoryRouter><BookStructureErrorAlert error={{ code: LEGACY_REPOSITORY_ADOPTION_DECLINED, adoptionTarget: target }} reload={reload} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: language === "it" ? "Verifica adozione" : "Review adoption" }));
    expect(screen.getByText(new RegExp(description))).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: confirmLabel }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("localizes explicit disposable mirror deletion consent", async () => {
    await i18n.changeLanguage("it");
    const target: LegacyAdoptionTarget = { bookId: "book-1", owner: "owner", repo: "repo", branch: "main", legacyIdentity: "google:writer@example.com", evidenceNonce: "evidence", replaceDisposableTarget: true };
    render(<MemoryRouter><BookStructureErrorAlert error={{ code: LEGACY_REPOSITORY_ADOPTION_DECLINED, adoptionTarget: target }} reload={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Verifica adozione" }));
    expect(screen.getByText(/eliminazione della copia locale speculare/)).toBeInTheDocument();
  });
});

describe("one-time legacy adoption consent", () => {
  const target: LegacyAdoptionTarget = { bookId: "book-1", owner: "owner", repo: "repo", branch: "main", legacyIdentity: "google:writer@example.com", evidenceNonce: "evidence", replaceDisposableTarget: false };
  const evidence = { provider: "google" as const, normalizedEmail: "writer@example.com", legacyIdentity: target.legacyIdentity, immutableIdentity: "google:google-sub", nonce: "evidence", createdAt: 1_000 };

  it("is consumed exactly once", () => {
    createLegacyAdoptionConsent(google, target);
    expect(consumeLegacyAdoptionConsent(google, target, evidence)).toBe(true);
    expect(consumeLegacyAdoptionConsent(google, target, evidence)).toBe(false);
  });

  it("consumes and rejects mismatched repository context", () => {
    createLegacyAdoptionConsent(google, target);
    expect(consumeLegacyAdoptionConsent(google, { ...target, repo: "other" }, evidence)).toBe(false);
    expect(consumeLegacyAdoptionConsent(google, target, evidence)).toBe(false);
  });

  it("consumes and rejects expired consent", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000);
    createLegacyAdoptionConsent(google, target);
    vi.spyOn(Date, "now").mockReturnValue(1_000 + 5 * 60_000 + 1);
    expect(consumeLegacyAdoptionConsent(google, target, evidence)).toBe(false);
    expect(consumeLegacyAdoptionConsent(google, target, evidence)).toBe(false);
  });
});

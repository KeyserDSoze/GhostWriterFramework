import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ConnectionCard, type ConnectionCardProps } from "@/components/account/ConnectionCard";
import { syncErrorView } from "@/account/syncErrorView";

describe("how a failed sync is told", () => {
  it("is one sign-in to make again for a lost or ended login, with the reason that matches how it was made", () => {
    expect(syncErrorView({ errorKind: "credential-missing", status: "needs-auth", mode: "session", brokerAvailable: true })).toEqual({ kind: "sign-in-again", why: "session", offerLongLived: true });
    expect(syncErrorView({ errorKind: "credential-missing", status: "needs-auth", mode: "session", brokerAvailable: false })).toEqual({ kind: "sign-in-again", why: "session", offerLongLived: false });
    expect(syncErrorView({ errorKind: "credential-expired", status: "needs-auth", mode: "long-lived", brokerAvailable: true })).toEqual({ kind: "sign-in-again", why: "long-lived", offerLongLived: false });
    expect(syncErrorView({ errorKind: "credential-missing", status: "needs-auth", mode: null, brokerAvailable: null })).toEqual({ kind: "sign-in-again", why: "missing", offerLongLived: false });
    expect(syncErrorView({ status: "needs-auth", mode: "long-lived-memory", brokerAvailable: null })).toMatchObject({ kind: "sign-in-again", why: "long-lived" });
  });

  it("leaves every other failure with its own sentence", () => {
    for (const errorKind of ["network", "permission-denied", "remote-not-found", "rate-limited", "unknown"]) expect(syncErrorView({ errorKind, status: "error", mode: "session", brokerAvailable: true })).toEqual({ kind: "other" });
    expect(syncErrorView({ status: "idle", mode: "session", brokerAvailable: true })).toEqual({ kind: "other" });
  });
});

const RAW = "google-drive credential is missing.";
const base = (overrides: Partial<ConnectionCardProps> = {}): ConnectionCardProps => ({
  title: "Google Drive", icon: null, connected: true, enabled: true, status: "needs-auth", errorKind: "credential-missing", errorMessage: RAW, busy: false,
  credentialMode: "session", brokerAvailable: true,
  onConnect: vi.fn(), onReconnect: vi.fn(), onSync: vi.fn(), onDisconnect: vi.fn(), onDelete: vi.fn(), onUpgrade: vi.fn(), ...overrides,
});
afterEach(async () => { cleanup(); await i18n.changeLanguage("en"); });

const TEXTS = {
  en: { title: "Sign in to Google Drive again on this device", session: /signed in to Google Drive with session credentials: they last only for a short time \(about an hour for Google/, offer: /long-lived credentials renew themselves in the background/, upgrade: "Switch to long-lived credentials", details: "Technical details", oldKind: /There is no saved login for this service on this device/ },
  it: { title: "Accedi di nuovo a Google Drive su questo dispositivo", session: /ha fatto l'accesso a Google Drive con credenziali di sessione: durano poco \(circa un'ora per Google/, offer: /le credenziali di lunga durata si rinnovano da sole in background/, upgrade: "Passa a credenziali durature", details: "Dettagli tecnici", oldKind: /Su questo dispositivo non c'è un accesso salvato/ },
} as const;

describe.each(["en", "it"] as const)("the card of Google Drive when its login ended, in %s", (language) => {
  const text = TEXTS[language];

  it("says «sign in again on this device» once, with the one action, instead of the raw «credential is missing»", async () => {
    await i18n.changeLanguage(language);
    const props = base();
    render(<ConnectionCard {...props} />);
    const panel = screen.getByTestId("sign-in-again");
    expect(within(panel).getByRole("heading", { name: text.title })).toBeInTheDocument();
    expect(within(panel).getByText(text.session)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: text.title }));
    expect(props.onReconnect).toHaveBeenCalledTimes(1);
    // The old duplicate sentence and the raw message are not on the card unless the details are opened.
    expect(screen.queryByText(text.oldKind)).toBeNull();
    expect(screen.getAllByRole("button", { name: text.title })).toHaveLength(1);
    const details = within(panel).getByText(text.details).closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText(RAW)).toBeInTheDocument();
  });

  it("explains how to make the sign-in last (long-lived credentials through the sign-in service) and offers the switch, when the service is served", async () => {
    await i18n.changeLanguage(language);
    const props = base();
    render(<ConnectionCard {...props} />);
    const panel = screen.getByTestId("sign-in-again");
    expect(within(panel).getByText(text.offer)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: text.upgrade }));
    expect(props.onUpgrade).toHaveBeenCalledTimes(1);
  });

  it("offers no switch where the sign-in service does not serve Google or the credentials already are long-lived", async () => {
    await i18n.changeLanguage(language);
    render(<ConnectionCard {...base({ brokerAvailable: false })} />);
    expect(screen.queryByRole("button", { name: text.upgrade })).toBeNull();
    cleanup();
    render(<ConnectionCard {...base({ credentialMode: "long-lived" })} />);
    expect(screen.queryByRole("button", { name: text.upgrade })).toBeNull();
    expect(within(screen.getByTestId("sign-in-again")).queryByText(text.session)).toBeNull();
  });

  it("keeps the sentence of its kind for a failure that is not a sign-in", async () => {
    await i18n.changeLanguage(language);
    render(<ConnectionCard {...base({ status: "error", errorKind: "network", errorMessage: "Failed to fetch" })} />);
    expect(screen.queryByTestId("sign-in-again")).toBeNull();
    expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
  });
});

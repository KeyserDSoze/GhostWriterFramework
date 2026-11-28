import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  armHandover: vi.fn(async (..._args: unknown[]) => undefined),
  cancelHandover: vi.fn(async (..._args: unknown[]) => true),
  moveToServer: vi.fn(async (..._args: unknown[]) => undefined),
  moveToBrowser: vi.fn(async (..._args: unknown[]) => undefined),
  save: vi.fn(async () => true),
  toast: vi.fn(),
}));

vi.mock("@/autopilot/loader", () => ({
  loadAutopilotRuntime: async () => ({
    armHandover: mocks.armHandover,
    cancelHandover: mocks.cancelHandover,
    moveToServer: mocks.moveToServer,
    moveToBrowser: mocks.moveToBrowser,
    syncWithServer: vi.fn(),
    describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  }),
}));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { HandoverConsentError, type HandoverPlan } from "@/autopilot/handover";
import { WhereCard } from "@/pages/AutopilotPage";
import { emptyView, useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry, type PersonalServerSettings } from "@/types/settings";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const PIN = "a".repeat(64);
const LOCAL: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const GITHUB: BookEntry = { ...LOCAL, storageMode: "github", owner: "acme", repo: "glass-harbor" };
const CONNECTION: PersonalServerSettings = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const ARMED: HandoverPlan = { to: "server", when: "after-step", phase: "armed" };

const online: Partial<ServerConnectionState> = { status: "online", connection: CONNECTION };

function open(options: { book?: BookEntry; running?: boolean; server?: Partial<ServerConnectionState>; intent?: { side: "browser" | "server"; when?: "now"; returnAfterSteps?: number }; view?: Parameters<ReturnType<typeof useAutopilotStore.getState>["patchView"]>[1] } = {}) {
  const book = options.book ?? LOCAL;
  const status = options.server?.status ?? "online";
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], ...(status === "disabled" ? {} : { personalServer: CONNECTION }) } });
  useAutopilotStore.setState({ views: { [book.id]: { ...emptyView(book.id), ...(options.view ?? {}) } }, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null, ...(options.server ?? online) } });
  if (options.intent) useAutopilotStore.getState().setWhereIntent({ bookId: book.id, at: Date.now(), ...options.intent });
  return render(<MemoryRouter><WhereCard book={book} running={options.running ?? false} /></MemoryRouter>);
}

const radio = (name: "browser" | "server") => screen.getByRole("radio", { name: t(`autopilot.where.${name}`) });
const quick = (key: string) => t(`autopilot.quick.where.${key}`);

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.armHandover.mockReset().mockImplementation(async (id: unknown) => {
    useAutopilotStore.getState().patchView(String(id), { handover: ARMED });
  });
  mocks.cancelHandover.mockReset().mockImplementation(async (id: unknown) => {
    useAutopilotStore.getState().patchView(String(id), { handover: null });
    return true;
  });
  mocks.moveToServer.mockClear();
  mocks.moveToBrowser.mockClear();
  mocks.save.mockClear();
  mocks.toast.mockClear();
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null }, views: {}, whereIntent: null });
});

describe("the card that a quick command opens for a run that goes on: «after this step» is finished here", () => {
  it("shows the consents and a button that passes the book after the step, with the radios free and the focus on the button (what was a dead end)", () => {
    open({ running: true, intent: { side: "server" } });
    expect(radio("server")).toHaveAttribute("aria-checked", "true");
    expect(radio("server")).toBeEnabled();
    expect(radio("browser")).toBeEnabled();
    expect(screen.getByLabelText(t("autopilot.where.consentAi"))).toBeChecked();
    expect(screen.getByText(t("autopilot.where.runningHere"))).toBeInTheDocument();
    expect(screen.getByText(t("autopilot.where.finishLead"))).toBeInTheDocument();
    const pass = screen.getByRole("button", { name: quick("toServerAfterStep") });
    expect(pass).toBeEnabled();
    expect(pass).toHaveFocus();
    expect(screen.queryByRole("button", { name: t("autopilot.where.move") })).not.toBeInTheDocument();
  });

  it("hands the focus on to the button when the link that brought the author gives it to the card (the router does, a moment after)", () => {
    open({ running: true, intent: { side: "server" } });
    act(() => (document.getElementById("autopilot-where") as HTMLElement).focus());
    expect(screen.getByRole("button", { name: quick("toServerAfterStep") })).toHaveFocus();
  });

  it("does not take the focus from the card later: it is only for the moment the author arrives", () => {
    vi.useFakeTimers();
    try {
      open({ running: true, intent: { side: "server" } });
      act(() => { vi.advanceTimersByTime(2100); });
      const card = document.getElementById("autopilot-where") as HTMLElement;
      act(() => card.focus());
      expect(card).toHaveFocus();
    } finally { vi.useRealTimers(); }
  });

  it("records the consents in the plan and queues it: «The book will pass to the server when the current step ends», with a button to cancel", async () => {
    open({ running: true, intent: { side: "server" } });
    fireEvent.click(screen.getByLabelText(t("autopilot.where.consentAi")));
    fireEvent.click(screen.getByLabelText(t("autopilot.where.consentAi")));
    fireEvent.click(screen.getByRole("button", { name: quick("toServerAfterStep") }));
    await waitFor(() => expect(mocks.armHandover).toHaveBeenCalledTimes(1));
    expect(mocks.armHandover).toHaveBeenCalledWith(LOCAL.id, { to: "server", consent: { sendAiConfiguration: true, sendGitHubToken: false } }, { saveSettings: mocks.save });
    const status = await screen.findByText(t("autopilot.quick.handover.armed.server"));
    expect(status.closest("[role=status]")).toHaveAttribute("data-where-plan", "armed");
    expect(status.closest("[role=status]")).toHaveFocus();
    expect(t("autopilot.quick.handover.armed.server")).toBe("The book will pass to the server when the current step ends");
    expect(screen.queryByRole("button", { name: quick("toServerAfterStep") })).not.toBeInTheDocument();
    // Nothing was moved here: the runtime moves the book when the step ends.
    expect(mocks.moveToServer).not.toHaveBeenCalled();
  });

  it("takes the plan back with the button, and the author is where they were, with the button that makes it again", async () => {
    open({ running: true, intent: { side: "server" } });
    fireEvent.click(screen.getByRole("button", { name: quick("toServerAfterStep") }));
    const cancel = await screen.findByRole("button", { name: t("autopilot.quick.handover.cancel.server") });
    fireEvent.click(cancel);
    await waitFor(() => expect(mocks.cancelHandover).toHaveBeenCalledWith(LOCAL.id));
    const again = await screen.findByRole("button", { name: quick("toServerAfterStep") });
    await waitFor(() => expect(again).toHaveFocus());
  });

  it("passes the book now when the author chose «now»: the label says it, the request carries it", async () => {
    open({ running: true, intent: { side: "server", when: "now" } });
    fireEvent.click(screen.getByRole("button", { name: quick("toServerNow") }));
    await waitFor(() => expect(mocks.armHandover).toHaveBeenCalledWith(LOCAL.id, { to: "server", when: "now", consent: { sendAiConfiguration: true, sendGitHubToken: false } }, expect.anything()));
  });

  it("makes the plan for one step there and back when the author chose it", async () => {
    open({ running: true, intent: { side: "server", returnAfterSteps: 1 } });
    fireEvent.click(screen.getByRole("button", { name: quick("stepOnServer") }));
    await waitFor(() => expect(mocks.armHandover).toHaveBeenCalledWith(LOCAL.id, { to: "server", returnAfterSteps: 1, consent: { sendAiConfiguration: true, sendGitHubToken: false } }, expect.anything()));
  });

  it("sends only what is ticked: an author who does not send the AI configuration sends none", async () => {
    open({ running: true, intent: { side: "server" } });
    fireEvent.click(screen.getByLabelText(t("autopilot.where.consentAi")));
    fireEvent.click(screen.getByRole("button", { name: quick("toServerAfterStep") }));
    await waitFor(() => expect(mocks.armHandover).toHaveBeenCalledWith(LOCAL.id, { to: "server", consent: { sendAiConfiguration: false, sendGitHubToken: false } }, expect.anything()));
  });

  it("says, next to the box, what the server still lacks when it refuses the plan for a consent that was not given, with no toast and no second trip", async () => {
    mocks.armHandover.mockRejectedValueOnce(new HandoverConsentError("ai"));
    open({ running: true, intent: { side: "server" } });
    fireEvent.click(screen.getByLabelText(t("autopilot.where.consentAi")));
    fireEvent.click(screen.getByRole("button", { name: quick("toServerAfterStep") }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("autopilot.where.needConsent.ai"));
    const box = screen.getByLabelText(t("autopilot.where.consentAi"));
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box.getAttribute("aria-describedby")).toBe(alert.id);
    expect(mocks.toast).not.toHaveBeenCalled();
    // Ticking it clears the sentence, and the next try goes through.
    fireEvent.click(box);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("a run that goes on, passed from the radios with no quick command", () => {
  it("offers the same plan: choosing the server shows what to send and the button that passes the book after the step, and a second one for now", () => {
    open({ running: true });
    expect(radio("browser")).toBeEnabled();
    fireEvent.click(radio("server"));
    expect(screen.getByRole("button", { name: quick("toServerAfterStep") })).toBeEnabled();
    const now = screen.getByRole("button", { name: quick("toServerNow") });
    expect(now).toBeEnabled();
    expect(screen.getByText(quick("toServerNowHint"))).toBeInTheDocument();
    expect(now.getAttribute("aria-describedby")).toBe(screen.getByText(quick("toServerNowHint")).id);
  });

  it("passes a run that goes on the server back after its step, with no consent to give", async () => {
    open({ book: { ...LOCAL, autopilotHost: "server" }, running: true });
    fireEvent.click(radio("browser"));
    expect(screen.getByText(t("autopilot.where.runningThere"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: quick("toBrowserAfterStep") }));
    await waitFor(() => expect(mocks.armHandover).toHaveBeenCalledWith(LOCAL.id, { to: "browser" }, expect.anything()));
  });
});

describe("a book that is stopped keeps the move it had", () => {
  it("moves at once with the consents, and the button is the one it was", async () => {
    open({ intent: { side: "server" } });
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.where.move") }));
    await waitFor(() => expect(mocks.moveToServer).toHaveBeenCalledWith(LOCAL.id, { sendAiConfiguration: true, sendGitHubToken: false }));
    expect(mocks.armHandover).not.toHaveBeenCalled();
  });
});

describe("every disabled state says why, next to it, with the one action when there is one", () => {
  it("a GitHub token that is not sent and that the server does not have: the sentence, and the action that ticks the box", () => {
    open({ book: GITHUB, running: true, intent: { side: "server" } });
    fireEvent.click(screen.getByLabelText(t("autopilot.where.consentGithub")));
    const pass = screen.getByRole("button", { name: quick("toServerAfterStep") });
    expect(pass).toBeDisabled();
    const why = screen.getByText(t("autopilot.where.githubConsentMissing"), { exact: false });
    expect(pass.getAttribute("aria-describedby")).toBe(why.id);
    fireEvent.click(within(why.closest("p") as HTMLElement).getByRole("button", { name: t("autopilot.where.githubConsentAllow") }));
    expect(screen.getByLabelText(t("autopilot.where.consentGithub"))).toBeChecked();
    expect(pass).toBeEnabled();
    expect(screen.queryByText(t("autopilot.where.githubConsentMissing"), { exact: false })).not.toBeInTheDocument();
  });

  it("no server: the button waits for one, and the sentence has the link to its settings, also for a run that goes on", () => {
    open({ running: true, intent: { side: "server" }, server: { status: "disabled" } });
    const pass = screen.getByRole("button", { name: quick("toServerAfterStep") });
    expect(pass).toBeDisabled();
    const why = screen.getByText(t("autopilot.where.noServer"), { exact: false });
    expect(pass.getAttribute("aria-describedby")).toBe(why.id);
    expect(screen.getByRole("link", { name: t("personalServer.title") })).toHaveAttribute("href", "/app/settings/server");
  });

  it("a server that is not verified: the sentence says so", () => {
    open({ running: true, intent: { side: "server" }, server: { status: "offline", connection: CONNECTION } });
    expect(screen.getByRole("button", { name: quick("toServerAfterStep") })).toBeDisabled();
    expect(screen.getByText(t("autopilot.where.serverUnverified"), { exact: false })).toBeInTheDocument();
  });

  it("an operation of the book in progress: the radios and the button wait, and the sentence says it", () => {
    open({ running: true, intent: { side: "server" }, view: { operation: { kind: "sync", startedAt: Date.now() } as never } });
    expect(radio("server")).toBeDisabled();
    expect(radio("browser")).toBeDisabled();
    const why = screen.getAllByText(quick("busy"));
    expect(why.length).toBeGreaterThan(0);
    expect(screen.getByRole("radiogroup").getAttribute("aria-describedby")).toBe(why.find((entry) => entry.id.startsWith("where-radios"))?.id);
    expect(screen.getByRole("button", { name: quick("toServerAfterStep") })).toBeDisabled();
  });

  it("«Sync now» of a book that runs on the server says why it waits, when the server is not verified", () => {
    open({ book: { ...LOCAL, autopilotHost: "server" }, server: { status: "offline", connection: CONNECTION } });
    const sync = screen.getByRole("button", { name: t("autopilot.where.sync") });
    expect(sync).toBeDisabled();
    const why = screen.getByText(t("autopilot.where.serverUnverified"), { exact: false });
    expect(sync.getAttribute("aria-describedby")).toBe(why.id);
  });

  it("bringing the book back without the server's work, while the autopilot runs there: the sentence says to wait for the step", () => {
    open({ book: { ...LOCAL, autopilotHost: "server" }, running: true, server: { status: "offline", connection: CONNECTION } });
    fireEvent.click(radio("browser"));
    const discard = screen.getByRole("button", { name: t("autopilot.where.discardServerWork") });
    expect(discard).toBeDisabled();
    expect(discard.getAttribute("aria-describedby")).toBe(screen.getByText(t("autopilot.where.discardRunning")).id);
  });
});

describe("a plan that is already on", () => {
  it("is shown where the buttons were, with the cancel, and the radios stay free", () => {
    open({ running: true, view: { handover: ARMED }, intent: { side: "server" } });
    expect(radio("server")).toBeEnabled();
    expect(screen.getByText(t("autopilot.quick.handover.armed.server"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("autopilot.quick.handover.cancel.server") })).toBeEnabled();
    expect(screen.queryByRole("button", { name: quick("toServerAfterStep") })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t("autopilot.where.consentAi"))).not.toBeInTheDocument();
  });

  it("while the book moves, the plan says where it is and cannot be taken back", () => {
    act(() => undefined);
    open({ running: true, view: { handover: { ...ARMED, phase: "moving" } }, intent: { side: "server" } });
    expect(screen.getByText(t("autopilot.quick.handover.moving.server"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("autopilot.quick.handover.cancel.server") })).not.toBeInTheDocument();
  });

  it("a plan that is over does not hold the card: the band tells how it ended", () => {
    open({ running: true, view: { handover: { ...ARMED, phase: "failed", error: "no" } }, intent: { side: "server" } });
    expect(screen.getByRole("button", { name: quick("toServerAfterStep") })).toBeEnabled();
  });
});

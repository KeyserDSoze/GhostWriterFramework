import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: vi.fn(), save: vi.fn(async () => true) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/store/saveStore", () => ({ triggerCurrentSave: mocks.save }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { provideUpdateRunsView, UpdatePrompt } from "@/components/layout/UpdatePrompt";
import { UpdatePromptRuns } from "@/components/layout/UpdatePromptRuns";
import { RouteErrorFallback } from "@/components/layout/RouteErrorFallback";
import { setLocalRuns } from "@/autopilot/localRuns";
import { setAutoResume } from "@/autopilot/resume";
import { useAppUpdateStore } from "@/store/appUpdateStore";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const reload = vi.fn();
const originalLocation = window.location;

beforeAll(async () => {
  await loadAutopilotTranslations();
  // What the shell gives the prompt when it loads (see Shell.tsx).
  provideUpdateRunsView(UpdatePromptRuns);
  Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, reload, assign: vi.fn(), replace: vi.fn() } });
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  reload.mockReset();
  mocks.toast.mockReset();
  useAppUpdateStore.setState({ worker: null, version: null, promptOpen: false, stale: false });
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  act(() => setLocalRuns([]));
  await i18n.changeLanguage("en");
});

function waitingWorker() {
  const worker = { postMessage: vi.fn(), scriptURL: "https://narrarium.net/sw.js?v=0.110.0" } as unknown as ServiceWorker;
  useAppUpdateStore.setState({ worker, version: "0.110.0", promptOpen: true });
  return worker;
}

describe("the prompt of a new version", () => {
  it("offers the update as before when nothing runs in this tab", () => {
    waitingWorker();
    render(<UpdatePrompt />);
    expect(screen.getByRole("dialog", { name: t("pwa.updateTitle") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("pwa.updateOnly") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("pwa.updateAndViewChanges") })).toBeInTheDocument();
    expect(document.querySelector("[data-update-runs]")).toBeNull();
  });

  it("says that updating stops the autopilots that run here, that they resume by themselves, and offers to update when they finish", () => {
    const worker = waitingWorker();
    act(() => setLocalRuns(["glass", "tide"]));
    render(<UpdatePrompt />);
    expect(document.querySelector("[data-update-runs]")).toHaveTextContent(t("autopilot.update.runsStopResume", { count: 2 }));
    expect(screen.queryByRole("button", { name: t("pwa.updateAndViewChanges") })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.update.later", { count: 2 }) }));
    expect(useAppUpdateStore.getState().promptOpen).toBe(false);
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.update.scheduled", { count: 2 }) });
  });

  it("says that a run whose resume is off on this device stops for good, in Italian too", async () => {
    await i18n.changeLanguage("it");
    waitingWorker();
    setAutoResume("glass", false);
    act(() => setLocalRuns(["glass"]));
    render(<UpdatePrompt />);
    expect(document.querySelector("[data-update-runs]")).toHaveTextContent("L'autopilot sta lavorando in questo browser su 1 libro: aggiornare ora lo ferma.");
    expect(screen.getByRole("button", { name: "Aggiorna quando finisce" })).toBeInTheDocument();
  });

  it("applies the update waiting for the runs as soon as the last one ends", async () => {
    const worker = waitingWorker();
    act(() => setLocalRuns(["glass"]));
    render(<UpdatePrompt />);
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.update.later", { count: 1 }) }));
    act(() => setLocalRuns([]));
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" }));
  });

  it("offers a reload when the page only learnt that it is out of date (a part of it could not be loaded)", async () => {
    useAppUpdateStore.setState({ stale: true, promptOpen: true });
    render(<UpdatePrompt />);
    expect(screen.getByRole("dialog")).toHaveTextContent(t("pwa.staleDescription"));
    fireEvent.click(screen.getByRole("button", { name: t("pwa.reloadNow") }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});

describe("a page of an older version whose files are gone", () => {
  const stale = () => { throw new TypeError("Failed to fetch dynamically imported module: https://narrarium.net/assets/AutopilotHubPage-KerUr87E.js"); };

  function renderFailing(inShell: boolean) {
    const router = createMemoryRouter([
      { path: "/", element: <p>Shell</p> },
      { path: "/app/autopilot", errorElement: <RouteErrorFallback inShell={inShell} />, lazy: async () => stale() },
    ], { initialEntries: ["/app/autopilot"] });
    return render(<RouterProvider router={router} />);
  }

  it("says that a new version is available, in the shell, and reloads when the author chooses it while nothing runs", async () => {
    renderFailing(true);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-route-error");
    expect(alert).toHaveTextContent(t("pwa.staleDescription"));
    expect(alert.closest("main")).toBeNull();
    // The page learns it is out of date in an effect of the fallback, which runs after the alert is drawn: wait for what it says, not for the draw.
    await vi.waitFor(() => expect(useAppUpdateStore.getState()).toMatchObject({ stale: true, promptOpen: true }));
    fireEvent.click(screen.getByRole("button", { name: t("pwa.reloadNow") }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("never reloads by itself over an autopilot that runs here: the button opens the prompt, which says what a reload stops", async () => {
    act(() => setLocalRuns(["glass"]));
    renderFailing(false);
    await screen.findByRole("alert");
    act(() => useAppUpdateStore.setState({ promptOpen: false }));
    fireEvent.click(screen.getByRole("button", { name: t("pwa.reloadNow") }));
    expect(useAppUpdateStore.getState().promptOpen).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });
});

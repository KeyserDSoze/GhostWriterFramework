import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { Toaster } from "@/components/ui/toaster";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";

function Start({ options }: { options?: object }) {
  const { run } = useAutopilotActions("book-1");
  return <button type="button" onClick={() => void run("start", (runtime, id) => runtime.start(id, options ?? {}))}>Start</button>;
}

const refusal = () => Object.assign(new Error("The budget is used up."), { code: "budget-used-up" });

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = { start: vi.fn(), allowBudgetOverrun: vi.fn(), describeError: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))) };
});

afterEach(() => cleanup());

describe("a start refused for a budget that is used up", () => {
  it("says so in a toast that starts it anyway, with the options of the start that was refused, once", async () => {
    mocks.runtime.start.mockRejectedValueOnce(refusal()).mockResolvedValue(undefined);
    render(<><Start options={{ limits: { steps: 1 } }} /><Toaster /></>);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Could not start the autopilot")).toBeInTheDocument();
    expect(screen.getByText("The budget is used up.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start anyway" }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledTimes(2));
    expect(mocks.runtime.allowBudgetOverrun).toHaveBeenCalledWith("book-1");
    expect(mocks.runtime.start).toHaveBeenLastCalledWith("book-1", { limits: { steps: 1 } });
    expect(mocks.runtime.allowBudgetOverrun.mock.invocationCallOrder[0], "the budget is set aside before the start").toBeLessThan(mocks.runtime.start.mock.invocationCallOrder[1]);
  });

  it("offers nothing of the kind for any other failure", async () => {
    mocks.runtime.start.mockRejectedValueOnce(new Error("The server does not answer."));
    render(<><Start /><Toaster /></>);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("The server does not answer.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start anyway" })).toBeNull();
  });
});

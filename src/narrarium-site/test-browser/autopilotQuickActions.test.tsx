import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn() }));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { makeRuntime, t } from "./helpers/quickCommands";

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.runtime = makeRuntime();
  mocks.toast.mockReset();
});

afterEach(cleanup);

describe("the commands of the bar, as actions", () => {
  it("send every command to the runtime for a run this client can reach", async () => {
    const { result } = renderHook(() => useAutopilotActions("book-1"));
    const { commands } = result.current;
    expect(await commands.pause("after-step")).toBe(true);
    expect(await commands.pause("after-chapter")).toBe(true);
    expect(await commands.cancelPause()).toBe(true);
    expect(await commands.stop()).toBe(true);
    expect(await commands.resume()).toBe(true);
    expect(await commands.runOne("step")).toBe(true);
    expect(await commands.setPublish("step")).toBe(true);
    expect(await commands.updateOptions({ pauseAfterEachChapter: true })).toBe(true);
    expect(await commands.handover({ to: "server" }, { saveSettings: async () => true })).toBe(true);
    expect(mocks.runtime.pause.mock.calls).toEqual([["book-1", "after-step"], ["book-1", "after-chapter"], ["book-1", "cancel"], ["book-1", "now"]]);
    expect(mocks.runtime.start).toHaveBeenCalledWith("book-1");
    expect(mocks.runtime.runOne).toHaveBeenCalledWith("book-1", "step");
    expect(mocks.runtime.updateOptions.mock.calls).toEqual([["book-1", { publishEvery: "step" }], ["book-1", { pauseAfterEachChapter: true }]]);
    expect(mocks.runtime.armHandover).toHaveBeenCalledWith("book-1", { to: "server" }, { saveSettings: expect.any(Function) });
  });

  it("send nothing that goes to a run this client cannot reach: not a pause, not a stop, not an option, not a switch", async () => {
    const { result } = renderHook(() => useAutopilotActions("book-1", { unreachable: true }));
    const { commands } = result.current;
    for (const sent of [commands.pause("after-step"), commands.pause("now"), commands.cancelPause(), commands.stop(), commands.setPublish("off"), commands.updateOptions({ publishEvery: null }), commands.handover({ to: "server" })]) {
      expect(await sent).toBe(false);
    }
    expect(mocks.runtime.pause).not.toHaveBeenCalled();
    expect(mocks.runtime.updateOptions).not.toHaveBeenCalled();
    expect(mocks.runtime.armHandover).not.toHaveBeenCalled();
  });

  it("still start a run there: that is how the author takes it over, after a confirmation of their own", async () => {
    const { result } = renderHook(() => useAutopilotActions("book-1", { unreachable: true }));
    expect(await result.current.commands.resume()).toBe(true);
    expect(await result.current.commands.runOne("chapter")).toBe(true);
    expect(mocks.runtime.start).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.runOne).toHaveBeenCalledTimes(1);
  });

  it("say what went wrong in a toast, with the words the runtime gives the error", async () => {
    mocks.runtime.pause.mockRejectedValueOnce(new Error("Your personal server does not know this command yet."));
    const { result } = renderHook(() => useAutopilotActions("book-1"));
    expect(await result.current.commands.pause("after-chapter")).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.errors.action"), description: "Your personal server does not know this command yet.", variant: "destructive" });
  });

  it("let the caller handle a failure that is not an error to say: no toast for it", async () => {
    const refusal = new Error("consent");
    mocks.runtime.armHandover.mockRejectedValueOnce(refusal);
    const handled: unknown[] = [];
    const { result } = renderHook(() => useAutopilotActions("book-1"));
    expect(await result.current.commands.handover({ to: "server" }, { onError: (error) => { handled.push(error); return true; } })).toBe(false);
    expect(handled).toEqual([refusal]);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("say that the book was published, or why it was not", async () => {
    const { result } = renderHook(() => useAutopilotActions("book-1"));
    await result.current.commands.publishNow();
    expect(mocks.toast).toHaveBeenCalledWith({ title: t("autopilot.where.published") });

    mocks.toast.mockReset();
    mocks.runtime.publishNow.mockResolvedValueOnce({ ok: false, kind: "error", message: "GitHub refused the push." });
    expect(await result.current.commands.publishNow()).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "GitHub refused the push.", variant: "destructive" }));
  });
});

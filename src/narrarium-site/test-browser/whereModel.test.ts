import { describe, expect, it } from "vitest";
import type { HandoverPlan } from "@/autopilot/handover";
import { activePlan, radiosBlocker, syncBlocker, whereMove, type WhereMoveInput } from "@/autopilot/whereModel";

const base: WhereMoveInput = {
  choice: "server",
  host: "browser",
  running: false,
  busy: false,
  plan: null,
  server: "ready",
  github: false,
  consentGithub: true,
  serverHasGithubToken: false,
  intent: null,
};
const armed: HandoverPlan = { to: "server", when: "after-step", phase: "armed" };
const over = (phase: HandoverPlan["phase"]): HandoverPlan => ({ to: "server", when: "after-step", phase });
const move = (patch: Partial<WhereMoveInput>) => whereMove({ ...base, ...patch });

describe("the way to the other side, for the side chosen in «Where it runs»", () => {
  it("moves a book that is stopped at once, and plans the pass of one that runs", () => {
    expect(move({})).toEqual({ mode: "move", plan: null, blocker: null });
    expect(move({ running: true })).toEqual({ mode: "after-step", plan: null, blocker: null });
  });

  it("finishes what the quick command asked for: now, or one step there", () => {
    expect(move({ running: true, intent: { to: "server", when: "now" } }).mode).toBe("now");
    expect(move({ running: true, intent: { to: "server", returnAfterSteps: 1 } }).mode).toBe("step");
    expect(move({ running: true, intent: { to: "server", when: "after-step" } }).mode).toBe("after-step");
  });

  it("does not take an intent for the other side: it is the author's choice that counts", () => {
    expect(move({ running: true, choice: "server", intent: { to: "browser", when: "now" } }).mode).toBe("after-step");
  });

  it("has nothing to pass when the side chosen is where the book runs: only the plan, when there is one", () => {
    expect(move({ choice: "browser", host: "browser" })).toEqual({ mode: null, plan: null, blocker: null });
    expect(move({ choice: "browser", host: "browser", plan: armed })).toMatchObject({ mode: null, plan: armed });
  });

  it("does not disable the button because the autopilot runs: that is the path of the plan", () => {
    expect(move({ running: true }).blocker).toBeNull();
    expect(move({ running: true, choice: "browser", host: "server" }).blocker).toBeNull();
  });

  it.each([
    ["an operation of the book is in progress", { busy: true }, "busy"],
    ["no server is connected", { server: "disabled" as const }, "no-server"],
    ["the server is not verified", { server: "unverified" as const }, "unverified"],
    ["the GitHub token is not sent and the server does not have it", { github: true, consentGithub: false }, "github-consent"],
  ])("says why it is disabled when %s", (_name, patch, blocker) => {
    expect(move(patch).blocker).toBe(blocker);
    expect(move({ ...patch, running: true }).blocker).toBe(blocker);
  });

  it("does not ask for the token when the server holds it already, or when the book is not on GitHub", () => {
    expect(move({ github: true, consentGithub: false, serverHasGithubToken: true }).blocker).toBeNull();
    expect(move({ github: false, consentGithub: false }).blocker).toBeNull();
  });

  it("does not ask for the token either when the author chose the server's own GitHub connection: no copy of the token is sent, so there is nothing to consent to", () => {
    expect(move({ github: true, consentGithub: false, githubConnection: true }).blocker).toBeNull();
    expect(move({ github: true, consentGithub: false, githubConnection: true, running: true }).blocker).toBeNull();
    expect(move({ github: true, consentGithub: false, githubConnection: false }).blocker).toBe("github-consent");
  });

  it("still says what is most basic first with the connection chosen: the server and the book's state are as before", () => {
    expect(move({ github: true, githubConnection: true, busy: true }).blocker).toBe("busy");
    expect(move({ github: true, githubConnection: true, server: "disabled" }).blocker).toBe("no-server");
    expect(move({ github: true, githubConnection: true, server: "unverified" }).blocker).toBe("unverified");
  });

  it("says what is most basic first: a busy book before a missing server before a missing consent", () => {
    expect(move({ busy: true, server: "disabled", github: true, consentGithub: false }).blocker).toBe("busy");
    expect(move({ server: "unverified", github: true, consentGithub: false }).blocker).toBe("unverified");
  });

  it("shows the plan that waits or goes on instead of a button, and no blocker: the plan is the answer", () => {
    expect(move({ running: true, plan: armed, busy: true, server: "unverified" })).toEqual({ mode: "after-step", plan: armed, blocker: null });
  });

  it("does not keep a plan that is over: the band tells how it ended, and the card is free again", () => {
    expect(activePlan(over("done"))).toBeNull();
    expect(activePlan(over("failed"))).toBeNull();
    expect(move({ plan: over("failed") }).plan).toBeNull();
    for (const phase of ["armed", "pausing", "moving", "starting", "running-there", "returning"] as const) expect(activePlan(over(phase))).toMatchObject({ phase });
  });

  describe("coming back to this browser", () => {
    const back = { choice: "browser" as const, host: "server" as const };
    it("moves a book that is stopped even when the server cannot be reached: the move tells what failed, and the card offers to leave without the work", () => {
      expect(move({ ...back, server: "unverified" })).toEqual({ mode: "move", plan: null, blocker: null });
      expect(move({ ...back, server: "disabled" }).blocker).toBeNull();
    });
    it("needs the server for a run that goes on: a plan checks it before it pauses anything", () => {
      expect(move({ ...back, running: true })).toEqual({ mode: "after-step", plan: null, blocker: null });
      expect(move({ ...back, running: true, server: "unverified" }).blocker).toBe("unverified");
      expect(move({ ...back, running: true, server: "disabled" }).blocker).toBe("no-server");
    });
    it("is not asked for a GitHub token: nothing is sent to a browser", () => {
      expect(move({ ...back, github: true, consentGithub: false }).blocker).toBeNull();
    });
    it("is blocked while an operation of the book is in progress", () => {
      expect(move({ ...back, busy: true }).blocker).toBe("busy");
    });
  });
});

describe("the other disabled states of the card", () => {
  it("disables the radios only while an operation of the book is in progress, never because the autopilot runs", () => {
    expect(radiosBlocker({ busy: true })).toBe("busy");
    expect(radiosBlocker({ busy: false })).toBeNull();
  });

  it("disables «Sync now» for the same reasons as the move, in the same order", () => {
    expect(syncBlocker({ busy: true, server: "disabled" })).toBe("busy");
    expect(syncBlocker({ busy: false, server: "disabled" })).toBe("no-server");
    expect(syncBlocker({ busy: false, server: "unverified" })).toBe("unverified");
    expect(syncBlocker({ busy: false, server: "ready" })).toBeNull();
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import {
  HandoverCoordinator,
  HandoverRefusedError,
  isHandoverCancellable,
  isHandoverOver,
  type HandoverPlan,
  type HandoverPorts,
  type HandoverSide,
  type RunOutcome,
} from "@/autopilot/handover";

/** What a run that ends because the author asked for a pause says: paused, with no message and no code. */
const OURS: RunOutcome = { status: "paused", message: null };
const STEP_LIMIT: RunOutcome = { status: "paused", message: "Step done as requested: paused.", code: "stepLimit" };

interface Script {
  host: HandoverSide;
  running: boolean;
  controllable: boolean;
  pausePending: "after-step" | "after-chapter" | null;
  /** Called by `assertFree`: an operation holds the book. */
  busy: Error | null;
  /** What `prepareMove`, `pause`, `move` and `start` throw, by name. */
  fails: Partial<Record<"prepare" | "pause" | "move" | "start" | "inspect", Error>>;
}

/** Ports that keep a log of what the plan did, and a run that only ends when the test says so. */
function fakePorts(initial: Partial<Script> = {}) {
  const script: Script = { host: "browser", running: true, controllable: true, pausePending: null, busy: null, fails: {}, ...initial };
  const log: string[] = [];
  const published: Array<HandoverPlan | null> = [];
  const waiters: Array<{ resolve: (outcome: RunOutcome) => void; reject: (error: unknown) => void }> = [];
  const ports: HandoverPorts = {
    hostOf: () => script.host,
    assertFree: () => {
      if (script.busy) throw script.busy;
    },
    inspect: async () => {
      log.push("inspect");
      if (script.fails.inspect) throw script.fails.inspect;
      return { running: script.running, controllable: script.controllable, pausePending: script.pausePending };
    },
    prepareMove: async (_id, to, options) => {
      log.push(`prepare:${to}${options.limits ? ":limits" : ""}`);
      if (script.fails.prepare) throw script.fails.prepare;
    },
    pause: async (_id, mode) => {
      log.push(`pause:${mode}`);
      if (script.fails.pause) throw script.fails.pause;
    },
    waitUntilStopped: (_id, signal) => new Promise<RunOutcome>((resolve, reject) => {
      log.push("wait");
      waiters.push({ resolve, reject });
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
    move: async (_id, to) => {
      log.push(`move:${to}`);
      if (script.fails.move) throw script.fails.move;
      script.host = to;
    },
    start: async (_id, options) => {
      log.push(options?.limits?.steps ? `start:steps=${options.limits.steps}` : "start");
      if (script.fails.start) throw script.fails.start;
      script.running = true;
    },
    publish: (_id, plan) => { published.push(plan ? { ...plan } : null); },
    describeError: (error) => (error instanceof Error ? error.message : String(error)),
  };
  return {
    ports,
    script,
    log,
    published,
    phases: () => published.map((plan) => plan?.phase ?? null),
    /** The run on the current side ends as `outcome` says. */
    endRun(outcome: RunOutcome = OURS) {
      script.running = false;
      const waiter = waiters.shift();
      if (!waiter) throw new Error("nothing waits for the end of the run");
      waiter.resolve(outcome);
    },
    waiting: () => waiters.length,
  };
}

const BOOK = "book-1";
const last = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];
const settle = async () => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); };

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the plan to move a running autopilot to the other side", () => {
  it("browser → server after the step: asks for the pause, waits for the end of the run, moves the book, and starts it there", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    expect(coordinator.plan(BOOK)).toMatchObject({ to: "server", when: "after-step", phase: "armed" });
    expect(isHandoverCancellable(coordinator.plan(BOOK))).toBe(true);
    expect(fake.log).toEqual(["inspect", "prepare:server", "pause:after-step", "wait"]);

    fake.endRun();
    await coordinator.finished(BOOK);
    expect(fake.log).toEqual(["inspect", "prepare:server", "pause:after-step", "wait", "move:server", "start"]);
    expect(fake.phases()).toEqual(["armed", "moving", "starting", "done"]);
    expect(fake.script).toMatchObject({ host: "server", running: true });
  });

  it("server → browser after the step: the same, the other way round", async () => {
    const fake = fakePorts({ host: "server", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "browser" });
    expect(fake.log).toEqual(["inspect", "prepare:browser", "pause:after-step", "wait"]);
    fake.endRun();
    await coordinator.finished(BOOK);
    expect(fake.log.slice(-2)).toEqual(["move:browser", "start"]);
    expect(fake.script.host).toBe("browser");
    expect(coordinator.plan(BOOK)).toMatchObject({ to: "browser", phase: "done" });
  });

  it("now: stops the request in flight, and the plan cannot be taken back any more", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server", when: "now" });
    expect(fake.log).toEqual(["inspect", "prepare:server", "pause:now", "wait"]);
    expect(coordinator.plan(BOOK)).toMatchObject({ when: "now", phase: "pausing" });
    expect(isHandoverCancellable(coordinator.plan(BOOK))).toBe(false);
    expect(await coordinator.cancel(BOOK)).toBe(false);

    fake.endRun();
    await coordinator.finished(BOOK);
    expect(fake.phases()).toEqual(["pausing", "moving", "starting", "done"]);
    expect(fake.script.host).toBe("server");
  });

  it("never moves the book, nor starts it, before the run on this side has ended: never two runs at once", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    await settle();
    expect(fake.log.some((entry) => entry.startsWith("move") || entry.startsWith("start"))).toBe(false);
    fake.endRun();
    await coordinator.finished(BOOK);
    expect(fake.log.indexOf("wait")).toBeLessThan(fake.log.indexOf("move:server"));
    expect(fake.log.indexOf("move:server")).toBeLessThan(fake.log.indexOf("start"));
  });
});

describe("one step on the other side, and back", () => {
  it("browser → server for one step: starts there with that limit, waits for the pause the limit gives, brings the book back and goes on here", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server", returnAfterSteps: 1 });
    expect(fake.log).toEqual(["inspect", "prepare:server:limits", "prepare:browser", "pause:after-step", "wait"]);
    expect(coordinator.plan(BOOK)).toMatchObject({ to: "server", returnAfterSteps: 1, phase: "armed" });

    fake.endRun();
    await vi.waitFor(() => expect(fake.log).toContain("start:steps=1"));
    expect(coordinator.plan(BOOK)).toMatchObject({ phase: "running-there" });
    expect(isHandoverCancellable(coordinator.plan(BOOK))).toBe(false);

    fake.endRun(STEP_LIMIT);
    await coordinator.finished(BOOK);
    expect(fake.log.slice(4)).toEqual(["wait", "move:server", "start:steps=1", "wait", "move:browser", "start"]);
    expect(fake.phases()).toEqual(["armed", "moving", "starting", "running-there", "returning", "done"]);
    expect(fake.script).toMatchObject({ host: "browser", running: true });
  });

  it("server → browser for one step, and back to the server", async () => {
    const fake = fakePorts({ host: "server", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "browser", returnAfterSteps: 1 });
    expect(fake.log.slice(0, 3)).toEqual(["inspect", "prepare:browser:limits", "prepare:server"]);
    fake.endRun();
    await vi.waitFor(() => expect(fake.log).toContain("start:steps=1"));
    fake.endRun(STEP_LIMIT);
    await coordinator.finished(BOOK);
    expect(fake.log.slice(-4)).toEqual(["start:steps=1", "wait", "move:server", "start"]);
    expect(fake.script).toMatchObject({ host: "server", running: true });
    expect(coordinator.plan(BOOK)).toMatchObject({ phase: "done" });
  });

  it("asks for the limit only on a server that can keep it: a server that would run on past the step is checked before anything is paused", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    fake.script.fails.prepare = new Error("Update the server");
    const coordinator = new HandoverCoordinator(fake.ports);
    await expect(coordinator.arm(BOOK, { to: "server", returnAfterSteps: 1 })).rejects.toThrow("Update the server");
    expect(fake.log).toEqual(["inspect", "prepare:server:limits"]);
    expect(coordinator.plan(BOOK)).toBeNull();
  });

  it("goes back without going on when the run there did not stop at the limit: a question of the director, an error, a book that is complete", async () => {
    for (const outcome of [{ status: "waiting-author", message: "The director has a question." }, { status: "error", message: "HTTP 500" }, { status: "completed", message: "The book is complete." }] as RunOutcome[]) {
      const fake = fakePorts({ host: "browser", running: true });
      const coordinator = new HandoverCoordinator(fake.ports);
      await coordinator.arm(BOOK, { to: "server", returnAfterSteps: 1 });
      fake.endRun();
      await vi.waitFor(() => expect(fake.log).toContain("start:steps=1"));
      fake.endRun(outcome);
      await coordinator.finished(BOOK);
      expect(last(fake.log), outcome.status).toBe("move:browser");
      expect(fake.script.running, outcome.status).toBe(false);
      expect(coordinator.plan(BOOK)).toMatchObject({ phase: "done" });
    }
  });

  it("runs the step there even when the autopilot was stopped, because that is what was asked; and then does not go on here", async () => {
    const fake = fakePorts({ host: "browser", running: false });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server", returnAfterSteps: 1 });
    await vi.waitFor(() => expect(fake.log).toContain("start:steps=1"));
    expect(fake.log.slice(0, 5)).toEqual(["inspect", "prepare:server:limits", "prepare:browser", "move:server", "start:steps=1"]);
    expect(fake.log).not.toContain("pause:after-step");
    fake.endRun(STEP_LIMIT);
    await coordinator.finished(BOOK);
    expect(fake.log.slice(-2)).toEqual(["wait", "move:browser"]);
    expect(fake.script).toMatchObject({ host: "browser", running: false });
  });
});

describe("an autopilot that is stopped", () => {
  it("moves the book and stays stopped: it is started only if it was running", async () => {
    const fake = fakePorts({ host: "browser", running: false });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    await coordinator.finished(BOOK);
    expect(fake.log).toEqual(["inspect", "prepare:server", "move:server"]);
    expect(fake.phases()).toEqual(["moving", "done"]);
    expect(fake.script).toMatchObject({ host: "server", running: false });
  });

  it("does not start the autopilot there when the run ended for a reason of its own, which only the author settles", async () => {
    // The author's own pause (every chapter, a limit) ended it before the pause the plan asked for: it did not stop because of the plan.
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    fake.endRun({ status: "paused", message: "Chapter 3 approved: read it and resume." });
    await coordinator.finished(BOOK);
    expect(last(fake.log)).toBe("move:server");
    expect(fake.script.running).toBe(false);
  });

  it.each<[string, RunOutcome]>([
    ["a book that is complete", { status: "completed", message: "The book is complete." }],
    ["a question of the director", { status: "waiting-author", message: "A question." }],
    ["an error", { status: "error", message: "HTTP 500" }],
  ])("moves the book and stays stopped when the run ended with %s", async (_name, outcome) => {
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    fake.endRun(outcome);
    await coordinator.finished(BOOK);
    expect(last(fake.log)).toBe("move:server");
    expect(coordinator.plan(BOOK)?.phase).toBe("done");
  });
});

describe("a pause that the engine does not carry out", () => {
  it("does not hold the plan: a run that had already ended before the pause came is simply not running, and the book moves", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    // The run was over when the pause arrived: nothing will ever be paused, and the wait ends at once.
    fake.endRun({ status: "completed", message: "The book is complete." });
    await coordinator.finished(BOOK);
    expect(coordinator.plan(BOOK)?.phase).toBe("done");
    expect(fake.log).toContain("move:server");
  });

  it("does not wait for a run that is not running: no pause is asked for, and nothing waits", async () => {
    const fake = fakePorts({ host: "browser", running: false });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    await coordinator.finished(BOOK);
    expect(fake.log).not.toContain("wait");
    expect(fake.log.filter((entry) => entry.startsWith("pause"))).toEqual([]);
  });
});

describe("what goes wrong", () => {
  it("leaves the book where it was, stopped, with the reason, when the files cannot be moved (files changed on both sides)", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    fake.script.fails.move = new Error("The server already has a different version of 1 file of this book.");
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    fake.endRun();
    await coordinator.finished(BOOK);
    expect(coordinator.plan(BOOK)).toMatchObject({ phase: "failed", error: "The server already has a different version of 1 file of this book." });
    expect(fake.script).toMatchObject({ host: "browser", running: false });
    expect(fake.log).not.toContain("start");
    expect(fake.phases()).toEqual(["armed", "moving", "failed"]);
    expect(isHandoverOver(coordinator.plan(BOOK))).toBe(true);
  });

  it("says that the book is on the other side, stopped, when it moved but could not be started", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    fake.script.fails.start = new Error("The server has no AI configuration.");
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    fake.endRun();
    await coordinator.finished(BOOK);
    expect(coordinator.plan(BOOK)).toMatchObject({ phase: "failed", error: "The server has no AI configuration." });
    expect(fake.script).toMatchObject({ host: "server", running: false });
  });

  it("does not make a plan when the server cannot be reached: the run goes on, and nothing was asked of it", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    fake.script.fails.prepare = new Error("The personal server is not reachable.");
    const coordinator = new HandoverCoordinator(fake.ports);
    await expect(coordinator.arm(BOOK, { to: "server" })).rejects.toThrow("not reachable");
    expect(fake.log).toEqual(["inspect", "prepare:server"]);
    expect(coordinator.plan(BOOK)).toBeNull();
    expect(fake.published).toEqual([]);
    expect(fake.script.running).toBe(true);
  });

  it("fails the plan, with the reason, when the server cannot be reached for the way back", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server", returnAfterSteps: 1 });
    fake.endRun();
    await vi.waitFor(() => expect(fake.log).toContain("start:steps=1"));
    fake.script.fails.move = new Error("The personal server is not reachable.");
    fake.endRun(STEP_LIMIT);
    await coordinator.finished(BOOK);
    expect(coordinator.plan(BOOK)).toMatchObject({ phase: "failed", error: "The personal server is not reachable." });
    expect(fake.script).toMatchObject({ host: "server", running: false });
  });

  it("does not make a plan when the pause cannot be asked for, and leaves nothing behind", async () => {
    const fake = fakePorts({ host: "server", running: true });
    fake.script.fails.pause = new Error("The personal server is not reachable.");
    const coordinator = new HandoverCoordinator(fake.ports);
    await expect(coordinator.arm(BOOK, { to: "browser" })).rejects.toThrow("not reachable");
    expect(coordinator.plan(BOOK)).toBeNull();
    expect(fake.waiting()).toBe(0);
  });

  it("fails the plan when the book is taken by another operation by the time it has to move", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    fake.script.fails.move = new Error("The book is being synced with the server: wait until it is done.");
    fake.endRun();
    await coordinator.finished(BOOK);
    expect(coordinator.plan(BOOK)).toMatchObject({ phase: "failed", error: "The book is being synced with the server: wait until it is done." });
    expect(fake.script).toMatchObject({ host: "browser", running: false });
  });

  it("fails the plan when the run cannot be watched any more", async () => {
    const fake = fakePorts({ host: "server", running: true });
    const coordinator = new HandoverCoordinator({ ...fake.ports, waitUntilStopped: async () => { throw new Error("The personal server is not reachable right now."); } });
    await coordinator.arm(BOOK, { to: "browser" });
    await coordinator.finished(BOOK);
    expect(coordinator.plan(BOOK)).toMatchObject({ phase: "failed", error: "The personal server is not reachable right now." });
    expect(fake.log).not.toContain("move:browser");
  });
});

describe("refusing a plan", () => {
  it("is refused with a message while another operation holds the book, and nothing is paused", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    fake.script.busy = new Error("The book is being synced with the server: wait until it is done.");
    const coordinator = new HandoverCoordinator(fake.ports);
    await expect(coordinator.arm(BOOK, { to: "server" })).rejects.toThrow("being synced");
    expect(fake.log).toEqual([]);
    expect(coordinator.plan(BOOK)).toBeNull();
  });

  it("is refused when the autopilot runs where this client cannot reach it", async () => {
    const fake = fakePorts({ host: "browser", running: true, controllable: false });
    const coordinator = new HandoverCoordinator(fake.ports);
    const refused = await coordinator.arm(BOOK, { to: "server" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HandoverRefusedError);
    expect((refused as HandoverRefusedError).reason).toBe("not-controllable");
    expect((refused as Error).message).toBe(i18n.t("autopilot.quick.handover.refused.not-controllable"));
    expect(fake.log).toEqual(["inspect"]);
  });

  it("is refused when the book already runs there", async () => {
    const fake = fakePorts({ host: "server", running: false });
    const coordinator = new HandoverCoordinator(fake.ports);
    await expect(coordinator.arm(BOOK, { to: "server" })).rejects.toMatchObject({ name: "HandoverRefusedError", reason: "already-there" });
    expect(fake.log).toEqual([]);
  });

  it("is refused while another plan of the same book goes on, and another book has its own", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    await expect(coordinator.arm(BOOK, { to: "server", when: "now" })).rejects.toMatchObject({ reason: "in-progress" });
    await expect(coordinator.arm("book-2", { to: "server" })).resolves.toBeUndefined();
    expect(coordinator.plan("book-2")).toMatchObject({ phase: "armed" });
  });

  it("is made again after the one that failed, or that is done, has been closed or has gone", async () => {
    const fake = fakePorts({ host: "browser", running: false });
    fake.script.fails.move = new Error("The personal server is not reachable.");
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    await coordinator.finished(BOOK);
    expect(coordinator.plan(BOOK)?.phase).toBe("failed");
    fake.script.fails.move = undefined;
    await coordinator.arm(BOOK, { to: "server" });
    await coordinator.finished(BOOK);
    expect(coordinator.plan(BOOK)?.phase).toBe("done");
  });
});

describe("taking the plan back", () => {
  it("before it starts: cancels the pause it asked for, forgets the plan, and moves nothing", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    expect(await coordinator.cancel(BOOK)).toBe(true);
    expect(coordinator.plan(BOOK)).toBeNull();
    expect(last(fake.published)).toBeNull();
    expect(fake.log.slice(-1)).toEqual(["pause:cancel"]);
    await settle();
    expect(fake.log.some((entry) => entry.startsWith("move") || entry.startsWith("start"))).toBe(false);
    expect(fake.script).toMatchObject({ host: "browser", running: true });
  });

  it("keeps the pause the author had already asked for: the plan only takes back what it asked", async () => {
    const fake = fakePorts({ host: "browser", running: true, pausePending: "after-step" });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    expect(fake.log).not.toContain("pause:after-step");
    await coordinator.cancel(BOOK);
    expect(fake.log).not.toContain("pause:cancel");
  });

  it("asks again for the pause at the end of the chapter that the plan made less strict", async () => {
    const fake = fakePorts({ host: "browser", running: true, pausePending: "after-chapter" });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    await coordinator.cancel(BOOK);
    expect(fake.log.slice(-2)).toEqual(["pause:cancel", "pause:after-chapter"]);
  });

  it("is not possible once the files are being moved", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new HandoverCoordinator({ ...fake.ports, move: async (id, to) => { fake.log.push(`move:${to}`); await held; } });
    await coordinator.arm(BOOK, { to: "server" });
    fake.endRun();
    await vi.waitFor(() => expect(coordinator.plan(BOOK)?.phase).toBe("moving"));
    expect(await coordinator.cancel(BOOK)).toBe(false);
    expect(coordinator.plan(BOOK)?.phase).toBe("moving");
    release();
    await coordinator.finished(BOOK);
    expect(coordinator.plan(BOOK)?.phase).toBe("done");
  });

  it("does nothing for a book without a plan", async () => {
    const coordinator = new HandoverCoordinator(fakePorts().ports);
    expect(await coordinator.cancel(BOOK)).toBe(false);
  });
});

describe("the pause the author asked for at the end of the chapter", () => {
  it("is asked for again on the other side once the autopilot has started there", async () => {
    const fake = fakePorts({ host: "browser", running: true, pausePending: "after-chapter" });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    expect(fake.log).toContain("pause:after-step");
    fake.endRun();
    await coordinator.finished(BOOK);
    expect(fake.log.slice(-2)).toEqual(["start", "pause:after-chapter"]);
  });
});

describe("what the plan shows, and when it goes away", () => {
  it("keeps a finished plan on show for a little while, and then clears it", async () => {
    const fake = fakePorts({ host: "browser", running: false });
    const coordinator = new HandoverCoordinator(fake.ports, { doneVisibleMs: 5000 });
    await coordinator.arm(BOOK, { to: "server" });
    await coordinator.finished(BOOK);
    expect(coordinator.plan(BOOK)?.phase).toBe("done");
    await vi.advanceTimersByTimeAsync(4900);
    expect(coordinator.plan(BOOK)?.phase).toBe("done");
    await vi.advanceTimersByTimeAsync(200);
    expect(coordinator.plan(BOOK)).toBeNull();
    expect(last(fake.published)).toBeNull();
  });

  it("keeps a failed plan until it is closed: the reason is not for a moment", async () => {
    const fake = fakePorts({ host: "browser", running: false });
    fake.script.fails.move = new Error("boom");
    const coordinator = new HandoverCoordinator(fake.ports, { doneVisibleMs: 100 });
    await coordinator.arm(BOOK, { to: "server" });
    await coordinator.finished(BOOK);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(coordinator.plan(BOOK)?.phase).toBe("failed");
    coordinator.dismiss(BOOK);
    expect(coordinator.plan(BOOK)).toBeNull();
  });

  it("does not close a plan that is still going on", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server" });
    coordinator.dismiss(BOOK);
    expect(coordinator.plan(BOOK)).toMatchObject({ phase: "armed" });
  });

  it("publishes a plan that holds nothing but what the screen shows", async () => {
    const fake = fakePorts({ host: "browser", running: true });
    const coordinator = new HandoverCoordinator(fake.ports);
    await coordinator.arm(BOOK, { to: "server", returnAfterSteps: 2 });
    expect(Object.keys(fake.published[0] ?? {}).sort()).toEqual(["phase", "returnAfterSteps", "to", "when"]);
    expect(fake.published[0]).toEqual({ to: "server", when: "after-step", returnAfterSteps: 2, phase: "armed" });
  });
});

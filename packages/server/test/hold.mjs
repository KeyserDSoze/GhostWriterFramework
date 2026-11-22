import { createFakeAutopilotAi } from "narrarium-engine/testing";

// What the tests of the autopilot's quick controls share: a small fake book, and an AI that can be held in the middle of a step.

/** The options that keep the run to the director's plan and the prose: no readers, no specialists, no stop after the plan. */
export const FAST = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

export const brief = (chapters) => ({ idea: "A harbor of glass", targetChapters: chapters, scenesPerChapter: 1, wordsPerScene: 300 });

/** What to send to start a book of `chapters` chapters of one scene each. */
export const startOf = (chapters = 2, extra = {}) => ({ brief: brief(chapters), options: FAST, ...extra });

export const fakeAi = (chapters = 2) => createFakeAutopilotAi({ chapters, scenes: 1, reviewVerdict: () => "approve" });

/** The steps of such a book: concept, plan and its review, scenes, write, director-review and consolidate of every chapter, the final judgement. */
export const STEPS = (chapters) => 4 + 4 * chapters;

/** The request the AI is held in: the first scene of the first chapter is being written, and the four steps before it are saved. */
export const HELD = "autopilot:write:1.1";

/**
 * The fake AI, holding the first request labelled `label` until `release()`. A request that the run abandons (a pause now, the server closing)
 * ends, as the call to a provider does: a test that fails in the middle never leaves the server unable to stop.
 */
export function holdingAi(label = HELD, chapters = 2) {
  const base = fakeAi(chapters);
  let held = false;
  let taken = false;
  let open = () => undefined;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  return {
    calls: base.calls,
    isHeld: () => held,
    release: () => open(),
    async complete(request) {
      if (taken || request.label !== label) return base.complete(request);
      taken = true;
      held = true;
      await new Promise((resolve, reject) => {
        gate.then(resolve);
        request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
      return base.complete(request);
    },
  };
}

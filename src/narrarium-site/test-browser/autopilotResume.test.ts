import { describe, expect, it } from "vitest";
import type { AutopilotEvent } from "narrarium-engine";
import { RESUME_LIMIT, autoResumeOn, decideResume, forgetRun, interruptedRuns, noteResume, recentResumes, rememberRun, rememberStep, resumesWithin, setAutoResume, type ResumeFacts } from "@/autopilot/resume";
import { pageEnding } from "@/autopilot/localRuns";

/** A storage of this device for one test: what `localStorage` would hold. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

const SCOPE = "workspace:w1";
const OTHER = "workspace:w2";

/** A run of this browser that the page ended in the middle of: everything is there to resume it. */
const interrupted: ResumeFacts = {
  host: "browser",
  autoResume: true,
  online: true,
  settingsReady: true,
  state: { status: "running", ownRunner: true },
  heldElsewhere: false,
  workingCopy: true,
  aiReady: true,
  resumes: 0,
};

describe("the intent that this browser runs the autopilot of a book", () => {
  it("is remembered when the run starts, keeps the step it began, and goes when the run ends: only for its account", () => {
    const store = memoryStorage();
    rememberRun({ bookId: "glass", scope: SCOPE, since: "2026-11-25T10:00:00.000Z" }, store);
    rememberRun({ bookId: "tide", scope: OTHER, since: "2026-11-25T10:01:00.000Z" }, store);
    rememberStep(SCOPE, "glass", "Writing scene 2 of chapter 1", store);
    rememberStep(SCOPE, "missing", "A step of a run that was never remembered", store);
    expect(interruptedRuns(SCOPE, store)).toEqual([{ bookId: "glass", scope: SCOPE, since: "2026-11-25T10:00:00.000Z", step: "Writing scene 2 of chapter 1" }]);
    expect(interruptedRuns(OTHER, store).map((intent) => intent.bookId)).toEqual(["tide"]);
    forgetRun(SCOPE, "glass", store);
    expect(interruptedRuns(SCOPE, store)).toEqual([]);
    expect(interruptedRuns(OTHER, store)).toHaveLength(1);
  });

  it("reads a storage that is empty, broken or refused as no run to resume", () => {
    const broken = memoryStorage();
    broken.setItem("narrarium.autopilot.resume.v1", "{not json");
    expect(interruptedRuns(SCOPE, broken)).toEqual([]);
    expect(interruptedRuns(SCOPE, null)).toEqual([]);
    expect(() => rememberRun({ bookId: "glass", scope: SCOPE, since: "x" }, null)).not.toThrow();
  });
});

describe("«Resume by itself after a restart» of this browser", () => {
  it("is on unless the author turned it off for the book on this device", () => {
    const store = memoryStorage();
    expect(autoResumeOn("glass", store)).toBe(true);
    setAutoResume("glass", false, store);
    expect([autoResumeOn("glass", store), autoResumeOn("tide", store)]).toEqual([false, true]);
    setAutoResume("glass", true, store);
    expect(autoResumeOn("glass", store)).toBe(true);
  });
});

describe("the guard against a run that keeps dying", () => {
  it("counts the automatic resumes of the last ten minutes, per book and account", () => {
    const store = memoryStorage();
    const t0 = Date.parse("2026-11-25T10:00:00.000Z");
    noteResume(SCOPE, "glass", t0, store);
    noteResume(SCOPE, "glass", t0 + 60_000, store);
    noteResume(OTHER, "glass", t0 + 60_000, store);
    expect(recentResumes(SCOPE, "glass", t0 + 120_000, store)).toHaveLength(2);
    expect(recentResumes(SCOPE, "glass", t0 + RESUME_LIMIT.windowMs + 30_000, store)).toHaveLength(1);
    expect(recentResumes(SCOPE, "tide", t0, store)).toEqual([]);
    expect(resumesWithin([t0 - RESUME_LIMIT.windowMs, t0 - 1, t0, t0 + 5, Number.NaN], t0)).toEqual([t0 - 1, t0]);
  });
});

describe("whether an interrupted run is resumed now", () => {
  it("resumes a run of this browser that the page ended, with its working copy, its AI and the device online", () => {
    expect(decideResume(interrupted)).toEqual({ kind: "resume" });
  });

  it("never resumes a run the author paused or stopped, nor one that ended by itself: the intent goes", () => {
    for (const status of ["paused", "completed", "error", "waiting-author"]) {
      expect(decideResume({ ...interrupted, state: { status, ownRunner: true } }), status).toEqual({ kind: "skip", reason: "not-interrupted", forget: true });
    }
    expect(decideResume({ ...interrupted, state: null })).toEqual({ kind: "skip", reason: "not-interrupted", forget: true });
  });

  it("leaves a book that moved to the server, left the library, or runs on another host, and one whose author turned the resume off", () => {
    expect(decideResume({ ...interrupted, host: "server" })).toEqual({ kind: "skip", reason: "server", forget: true });
    expect(decideResume({ ...interrupted, host: null })).toEqual({ kind: "skip", reason: "missing", forget: true });
    expect(decideResume({ ...interrupted, state: { status: "running", ownRunner: false } })).toEqual({ kind: "skip", reason: "other-runner", forget: true });
    expect(decideResume({ ...interrupted, autoResume: false })).toEqual({ kind: "skip", reason: "off", forget: true });
  });

  it("does not start while another tab of this browser holds the book, and keeps the intent: the run goes on there", () => {
    expect(decideResume({ ...interrupted, heldElsewhere: true })).toEqual({ kind: "skip", reason: "other-tab", forget: false });
  });

  it("waits while the device is offline or the settings are not loaded yet", () => {
    expect(decideResume({ ...interrupted, online: false })).toEqual({ kind: "wait", reason: "offline" });
    expect(decideResume({ ...interrupted, settingsReady: false })).toEqual({ kind: "wait", reason: "settings" });
  });

  it("says why and does nothing when the working copy or the AI is missing, and keeps the intent for when they are back", () => {
    expect(decideResume({ ...interrupted, workingCopy: false })).toEqual({ kind: "skip", reason: "no-working-copy", forget: false });
    expect(decideResume({ ...interrupted, aiReady: false })).toEqual({ kind: "skip", reason: "no-ai", forget: false });
  });

  it("stops after three automatic resumes in ten minutes, and says so", () => {
    expect(decideResume({ ...interrupted, resumes: RESUME_LIMIT.times - 1 })).toEqual({ kind: "resume" });
    expect(decideResume({ ...interrupted, resumes: RESUME_LIMIT.times })).toEqual({ kind: "skip", reason: "crash-loop", forget: true });
  });
});

describe("the notice of a run resumed by itself", () => {
  it("says the page was opened again for a book of this browser, and the server restarted for a book of the server", async () => {
    const { default: i18n } = await import("@/i18n");
    const { loadAutopilotTranslations } = await import("@/i18n/autopilot");
    const { presentFeedEvent } = await import("@/autopilot/format");
    const { useSettingsStore } = await import("@/store/settingsStore");
    const { DEFAULT_SETTINGS } = await import("@/types/settings");
    await loadAutopilotTranslations();
    await i18n.changeLanguage("en");
    const book = (id: string, host?: "server") => ({ id, owner: "local", repo: id, name: id, tokenIndex: null, storageMode: "local-only" as const, addedAt: "2026-11-20T00:00:00.000Z", ...(host ? { autopilotHost: host } : {}) });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book("here"), book("there", "server")] } });
    const insight = (bookId: string) => ({ type: "insight", bookId, at: "2026-11-25T10:00:00.000Z", seq: 1, tone: "info", code: "resumedAfterRestart", title: "Resumed by itself after the server restarted." }) as AutopilotEvent;
    const t = i18n.t.bind(i18n);
    expect(presentFeedEvent(t, insight("here"))?.text).toBe("Resumed by itself after the page was opened again.");
    expect(presentFeedEvent(t, insight("there"))?.text).toBe("Resumed by itself after the server restarted.");
    await i18n.changeLanguage("it");
    expect(presentFeedEvent(i18n.t.bind(i18n), insight("here"))?.text).toBe("Ripreso da solo dopo la riapertura della pagina.");
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
    await i18n.changeLanguage("en");
  });
});

describe("the end of the tab, when what the runs do is no longer theirs", () => {
  it("is a page hidden for good, not one the browser keeps to show again, nor one it shows again", () => {
    expect(pageEnding()).toBe(false);
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(pageEnding()).toBe(false);
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    expect(pageEnding()).toBe(true);
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(pageEnding()).toBe(false);
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import type { AutopilotActivity, AutopilotEvent } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { activityTitle, presentFeedEvent, taskLabel } from "@/autopilot/format";

const AT = "2026-11-21T10:00:00.000Z";

function activity(patch: Partial<AutopilotActivity> = {}): AutopilotActivity {
  return { id: "activity-1", runId: "run-1", task: "summarize-imported", phase: "plan", title: "", reason: "", next: "", status: "succeeded", startedAt: AT, ...patch } as AutopilotActivity;
}

function finished(patch: Partial<AutopilotActivity> = {}): AutopilotEvent {
  return { bookId: "book-1", at: AT, seq: 1, type: "task-finished", activity: activity(patch) } as AutopilotEvent;
}

const t = (language: "en" | "it") => i18n.getFixedT(language);

beforeAll(async () => {
  await loadAutopilotTranslations();
});

describe("the name of a kind of step", () => {
  it("says which chapter the summary of a chapter the author wrote is about, in both languages", () => {
    expect(taskLabel(t("en"), "summarize-imported", 3)).toBe("Summarizing imported chapter 3");
    expect(taskLabel(t("it"), "summarize-imported", 3)).toBe("Riassunto del capitolo importato 3");
  });

  it.each(["concept", "summarize-imported", "plan", "plan-reader", "plan-review", "scenes", "write", "reader", "readers-summary", "specialists", "director-review", "repair", "consolidate", "impact", "revise", "final", "book-corrections"] as const)("has a readable name for %s, and never shows a key", (kind) => {
    for (const language of ["en", "it"] as const) {
      const label = taskLabel(t(language), kind, 4);
      expect(label, `${kind} ${language}`).not.toMatch(/autopilot\.task|\{\{|undefined/);
      expect(label.trim()).not.toBe("");
    }
  });

  it("reads generically, never as a key, for a kind a newer engine adds", () => {
    expect(taskLabel(t("en"), "teleport-chapter" as never, 2)).toBe("Autopilot step");
    expect(taskLabel(t("it"), "teleport-chapter" as never, 2)).toBe("Passo dell'autopilot");
    expect(taskLabel(t("en"), undefined as never)).toBe("Autopilot step");
  });

  it("leaves no gap where a chapter number would be when the step has none", () => {
    expect(taskLabel(t("en"), "consolidate")).toBe("Closing chapter");
    expect(taskLabel(t("it"), "consolidate")).toBe("Chiusura del capitolo");
  });
});

describe("the title of a step", () => {
  it("is the engine's own title, in the language of the book, whenever it gave one", () => {
    const given = activity({ task: "summarize-imported", title: "Riassunto del capitolo 2 «La diga», scritto dall'autore", chapterNumber: 2 });
    expect(activityTitle(t("en"), given)).toBe("Riassunto del capitolo 2 «La diga», scritto dall'autore");
  });

  it("falls back to the name of its kind, with the chapter, when the title is empty", () => {
    expect(activityTitle(t("en"), activity({ title: "   ", chapterNumber: 5 }))).toBe("Summarizing imported chapter 5");
    expect(activityTitle(t("it"), activity({ title: "", chapterNumber: 5 }))).toBe("Riassunto del capitolo importato 5");
  });

  it("falls back to the generic name for a kind it does not know", () => {
    expect(activityTitle(t("en"), activity({ title: "", task: "teleport-chapter" as never }))).toBe("Autopilot step");
  });

  it("is what the feed shows for a step that ended, so an empty title never reads as nothing", () => {
    expect(presentFeedEvent(t("en"), finished({ chapterNumber: 3 }))?.text).toBe("Summarizing imported chapter 3");
    expect(presentFeedEvent(t("it"), finished({ chapterNumber: 3 }))?.text).toBe("Riassunto del capitolo importato 3");
    expect(presentFeedEvent(t("en"), finished({ chapterNumber: 3, status: "failed", error: "HTTP 503" }))?.text).toBe("Summarizing imported chapter 3 — failed");
    expect(presentFeedEvent(t("en"), finished({ chapterNumber: 3, title: "Summarizing chapter 3 «The Wall», written by the author" }))?.text).toBe("Summarizing chapter 3 «The Wall», written by the author");
  });
});

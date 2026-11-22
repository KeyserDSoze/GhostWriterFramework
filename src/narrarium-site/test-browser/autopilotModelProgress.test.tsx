import { cleanup, render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AutopilotActivity } from "narrarium-engine";

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { StepNow } from "@/components/autopilot/band/parts";
import { formatBytes } from "@/autopilot/format";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { eventOf, ingest, runningStep, seedRun } from "./helpers/autopilotBand";
import { t } from "./helpers/quickCommands";

const STEP: AutopilotActivity = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });
const PROSE = "The keeper climbed the stairs counting the steps under his breath.";
const live = () => useAutopilotStore.getState().live["book-1"];
const prose = (seq: number, preview = PROSE) => eventOf({ type: "task-progress", activityId: STEP.id, characters: preview.length, preview }, seq);
/** What the engine says of a step that answers with a value: numbers only, and an empty preview. */
const structured = (seq: number, bytes: number, characters = 300) => eventOf({ type: "task-progress", activityId: STEP.id, characters, bytes, preview: "" }, seq);

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  seedRun({ status: "running", running: true, live: { activity: STEP, characters: 0, preview: "" } });
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("what the store keeps of a step that is answering", () => {
  it("keeps the bytes of a structured reply and leaves the text that came before it where it was: the empty preview of the engine does not wipe the scene", async () => {
    await ingest(prose(1));
    expect(live()).toMatchObject({ preview: PROSE, characters: PROSE.length });
    await ingest(structured(2, 12_288, 40));
    expect(live()).toMatchObject({ preview: PROSE, characters: PROSE.length, bytes: 12_288 });
  });

  it("holds the bytes of a step that has no text, with the preview empty", async () => {
    await ingest(structured(1, 2_048));
    expect(live()).toMatchObject({ preview: "", bytes: 2_048 });
    await ingest(structured(2, 9_000));
    expect(live()).toMatchObject({ preview: "", bytes: 9_000 });
  });

  it("goes back to the text when prose follows: the bytes of the function are over", async () => {
    await ingest(structured(1, 2_048));
    await ingest(prose(2));
    expect(live()?.bytes).toBeUndefined();
    expect(live()).toMatchObject({ preview: PROSE });
  });

  it("starts every step without bytes", async () => {
    await ingest(structured(1, 2_048));
    await ingest(eventOf({ type: "task-finished", activity: { ...STEP, status: "succeeded" } }, 2));
    await ingest(eventOf({ type: "task-started", activity: runningStep("reader", "Ada reads chapter 5", { id: "live-reader" }) }, 3));
    expect(live()).toMatchObject({ preview: "", characters: 0 });
    expect(live()?.bytes).toBeUndefined();
  });

  it("does not take the bytes of another step for this one's", async () => {
    await ingest(eventOf({ type: "task-progress", activityId: "another-step", characters: 3, bytes: 999, preview: "" }, 1));
    expect(live()?.bytes).toBeUndefined();
  });

  it.each([["not a number", "12"], ["not finite", Number.NaN], ["negative", -5]])("ignores bytes that are %s, and reads the event as the text it is", async (_name, bytes) => {
    await ingest(prose(1));
    await ingest(eventOf({ type: "task-progress", activityId: STEP.id, characters: 70, bytes, preview: "More text." }, 2));
    expect(live()?.bytes).toBeUndefined();
    expect(live()).toMatchObject({ preview: "More text.", characters: 70 });
  });

  it("reads an event with no preview at all, as a newer or an older engine may say it, without losing the text", async () => {
    await ingest(prose(1));
    await ingest(eventOf({ type: "task-progress", activityId: STEP.id, characters: 80 }, 2));
    expect(live()).toMatchObject({ preview: PROSE, characters: 80 });
  });

  it("never copies a text that comes with the bytes: a structured event says numbers, and whatever else it carries stays out", async () => {
    await ingest(structured(1, 4_000));
    await ingest(eventOf({ type: "task-progress", activityId: STEP.id, characters: 5, bytes: 5_000, preview: "SOMETHING THAT IS NOT A NUMBER" }, 2));
    expect(live()?.preview).toBe("");
    expect(JSON.stringify(live())).not.toContain("SOMETHING THAT IS NOT A NUMBER");
  });

  it("does not put the progress in the feed, which keeps what happened and not what is going on", async () => {
    const before = useAutopilotStore.getState().feed.length;
    await ingest(structured(1, 4_000));
    await ingest(prose(2));
    expect(useAutopilotStore.getState().feed).toHaveLength(before);
  });
});

function band(compact = false) {
  return render(<MemoryRouter><StepNow bookId="book-1" compact={compact} /></MemoryRouter>);
}
const progressLine = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-band-progress]");

describe("the line «the model is answering» in the row of what happens now", () => {
  it("is not there while the model writes prose, or before it says anything", async () => {
    const { container } = band();
    expect(progressLine(container)).toBeNull();
    await ingest(prose(1));
    expect(progressLine(container)).toBeNull();
    expect(container.querySelector("[data-band-preview]")).toHaveTextContent(PROSE);
  });

  it("says that the model is answering, and how much has arrived, for a step that answers with a value", async () => {
    const { container } = band();
    await ingest(structured(1, 12_288));
    expect(progressLine(container)).toHaveTextContent(t("autopilot.band.answering", { size: formatBytes(12_288) }));
    expect(progressLine(container)).toHaveTextContent("The model is answering… (12 KB)");
  });

  it("is the line in place of the text of an earlier prose, while the function answers: the tail of the scene is not what is going on now", async () => {
    const { container } = band();
    await ingest(prose(1));
    await ingest(structured(2, 3_000));
    expect(progressLine(container)).not.toBeNull();
    expect(container.querySelector("[data-band-preview]")).toBeNull();
  });

  it("changes as the bytes arrive, and goes when the text comes back", async () => {
    const { container } = band();
    await ingest(structured(1, 1_024));
    expect(progressLine(container)).toHaveTextContent("(1 KB)");
    await ingest(structured(2, 51_200));
    expect(progressLine(container)).toHaveTextContent("(50 KB)");
    await ingest(structured(3, 1_572_864));
    expect(progressLine(container)).toHaveTextContent("(1.5 MB)");
    await ingest(prose(4));
    expect(progressLine(container)).toBeNull();
  });

  it("is said in Italian, with the figures of the language", async () => {
    await i18n.changeLanguage("it");
    const { container } = band();
    await ingest(structured(1, 12_288));
    expect(progressLine(container)).toHaveTextContent("Il modello sta rispondendo… (12 KB)");
    await ingest(structured(2, 1_536));
    expect(progressLine(container)).toHaveTextContent("(1,5 KB)");
  });

  it("is never read out as it goes: it is in no live region, and the one status of the row keeps saying the step, and only the step", async () => {
    const { container } = band();
    const status = container.querySelector('[role="status"]') as HTMLElement;
    const announced = status.textContent;
    await ingest(structured(1, 1_024));
    const line = progressLine(container) as HTMLElement;
    expect(line.closest("[aria-live]")).toBeNull();
    expect(line.closest('[role="status"], [role="alert"], [role="log"], [role="timer"]')).toBeNull();
    for (let step = 2; step <= 8; step += 1) await ingest(structured(step, step * 1_024));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(announced);
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
  });

  it("is a line of its own, small and plain: text of 12 px at least, and it never wraps the row", async () => {
    const { container } = band();
    await ingest(structured(1, 12_288));
    const line = progressLine(container) as HTMLElement;
    expect(line.className).toMatch(/\btext-xs\b/);
    expect(line.className).toMatch(/\btruncate\b/);
    expect(line.tagName).toBe("P");
  });
});

describe("the short state in the mini-player of the dock", () => {
  it("is a few words, and the figure: it has no room for the sentence", async () => {
    const { container } = band(true);
    expect(progressLine(container)).toBeNull();
    await ingest(structured(1, 12_288));
    expect(progressLine(container)).toHaveTextContent(t("autopilot.band.answeringShort", { size: formatBytes(12_288) }));
    expect(progressLine(container)).toHaveTextContent("Answering… 12 KB");
    expect(t("autopilot.band.answeringShort", { size: "12 KB" }).length).toBeLessThan(t("autopilot.band.answering", { size: "12 KB" }).length);
  });

  it("is said in Italian too, and in no live region", async () => {
    await i18n.changeLanguage("it");
    const { container } = band(true);
    await ingest(structured(1, 12_288));
    expect(progressLine(container)).toHaveTextContent("Risposta in corso… 12 KB");
    expect((progressLine(container) as HTMLElement).closest("[aria-live], [role=status]")).toBeNull();
  });

  it("goes away with the text: the compact row shows the title of the step again, alone", async () => {
    const { container } = band(true);
    await ingest(structured(1, 12_288));
    await ingest(prose(2));
    expect(progressLine(container)).toBeNull();
    expect(within(container).getByText(STEP.title)).toBeInTheDocument();
  });
});

describe("the figures of the engine's examples", () => {
  it("are the ones the page prints: a number of bytes in the units a person reads", () => {
    expect([512, 1_024, 12_288, 1_572_864].map((bytes) => formatBytes(bytes))).toEqual(["512 B", "1 KB", "12 KB", "1.5 MB"]);
  });
});

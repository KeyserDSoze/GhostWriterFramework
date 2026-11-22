import { afterEach, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/aiRouter";
import { applyMessage, deleteMessage, swapMessage, type Translate } from "@/router/routerMessages";
import type { BulkOutcome, SwapOutcome } from "@/router/routerTableModel";

const t: Translate = (key, options) => i18n.t(key, options) as string;

const bulk = (patch: Partial<BulkOutcome> = {}): BulkOutcome => ({ routing: {}, changed: [], created: [], adjusted: [], unchanged: [], skipped: [], ...patch });
const swap = (patch: Partial<SwapOutcome> = {}): SwapOutcome => ({ routing: {}, swapped: [], unchanged: [], skipped: [], ...patch });
const many = (count: number) => Array.from({ length: count }, (_, index) => `director${index}` as never);

beforeAll(() => i18n.changeLanguage("en"));
afterEach(() => i18n.changeLanguage("en"));

describe("the message after a swap", () => {
  it.each([
    ["en", 14, "Swapped 14 rows between Primary and Fallback 1."],
    ["en", 1, "Swapped 1 row between Primary and Fallback 1."],
    ["it", 14, "Scambiate 14 righe tra Primario e Fallback 1."],
    ["it", 1, "Scambiata 1 riga tra Primario e Fallback 1."],
  ])("says how many rows were swapped (%s, %i)", async (language, count, expected) => {
    await i18n.changeLanguage(language);
    expect(swapMessage(t, swap({ swapped: many(count) }), t("routing.primary"), t("routing.fallbackN", { n: 1 }))).toBe(expected);
  });

  it("adds how many rows were left alone, and why", () => {
    const text = swapMessage(t, swap({ swapped: many(4), skipped: [{ task: "audit", reason: "gap" }, { task: "copilot", reason: "gap" }] }), "Primary", "Fallback 1");
    expect(text).toBe("Swapped 4 rows between Primary and Fallback 1. 2 rows left as they were: the swap would have left a fallback with nothing before it.");
  });

  it("says that nothing could be swapped, and why, or that there was nothing to swap", () => {
    expect(swapMessage(t, swap({ skipped: [{ task: "audit", reason: "gap" }] }), "Primary", "Fallback 2")).toBe("Nothing to swap between Primary and Fallback 2: no row can exchange them without leaving a fallback with nothing before it.");
    expect(swapMessage(t, swap({ unchanged: many(3) }), "Primary", "Fallback 2")).toBe("Nothing changed.");
  });
});

describe("the message after an edit of several rows", () => {
  it("counts the rows that changed", async () => {
    expect(applyMessage(t, bulk({ changed: many(3) }))).toBe("Changes applied to 3 tasks.");
    expect(applyMessage(t, bulk({ changed: many(1) }))).toBe("Changes applied to 1 task.");
    await i18n.changeLanguage("it");
    expect(applyMessage(t, bulk({ changed: many(3) }))).toBe("Modifiche applicate a 3 attività.");
  });

  it("adds the rows that got a target, took the first valid model, or were already so", () => {
    const text = applyMessage(t, bulk({ changed: many(5), created: many(2), adjusted: many(1), unchanged: many(3) }));
    expect(text).toBe("Changes applied to 5 tasks. 2 rows received a target on this tab. 1 row uses the first valid model of the endpoint. 3 rows were already like that.");
  });

  it("groups the skipped rows by reason, in a fixed order, with the count of each", async () => {
    const skipped = [
      { task: "a", reason: "no-primary" }, { task: "b", reason: "no-primary" }, { task: "c", reason: "invalid-model" }, { task: "d", reason: "no-target" }, { task: "e", reason: "gap" },
    ] as unknown as BulkOutcome["skipped"];
    expect(applyMessage(t, bulk({ changed: many(1), skipped }))).toBe(
      "Changes applied to 1 task. Skipped: 1 row has nothing on this tab (pick an endpoint to give it a target); 2 rows have no primary (set it first); 1 row has no fallback before this one; 1 row: the model does not suit the task.",
    );
    await i18n.changeLanguage("it");
    expect(applyMessage(t, bulk({ changed: many(1), skipped: [skipped[0], skipped[1]] }))).toBe("Modifiche applicate a 1 attività. Saltate: 2 righe senza primario (impostalo prima).");
  });

  it("says that nothing changed when nothing did", () => {
    expect(applyMessage(t, bulk({ unchanged: many(2) }))).toBe("Nothing changed. 2 rows were already like that.");
    expect(applyMessage(t, bulk({ skipped: [{ task: "audit", reason: "limit" }] }))).toBe("Nothing changed. Skipped: 1 row: the limit of candidates is reached.");
    expect(applyMessage(t, bulk({ skipped: [{ task: "audit", reason: "no-model" }, { task: "review", reason: "no-model" }] }))).toBe("Nothing changed. Skipped: 2 rows: the endpoint has no model for them.");
  });
});

describe("the message after deleting a tab", () => {
  it.each([
    ["en", 4, "Deleted Fallback 1: 4 rows lost it."],
    ["en", 1, "Deleted Fallback 1: 1 row lost it."],
    ["it", 4, "Eliminata la scheda Fallback 1: 4 righe l'hanno persa."],
    ["it", 1, "Eliminata la scheda Fallback 1: 1 riga l'ha persa."],
  ])("names the tab and counts the rows (%s, %i)", async (language, count, expected) => {
    await i18n.changeLanguage(language);
    expect(deleteMessage(t, "Fallback 1", count)).toBe(expected);
  });
});

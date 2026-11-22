import { beforeAll, describe, expect, it } from "vitest";
import type { AutopilotEvent } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { presentFeedEvent } from "@/autopilot/format";

const AT = "2026-11-21T10:00:00.000Z";

function insight(body: Record<string, unknown>): AutopilotEvent {
  return { bookId: "book-1", at: AT, seq: 1, type: "insight", tone: "warning", ...body } as AutopilotEvent;
}

function present(language: "en" | "it", body: Record<string, unknown>) {
  return presentFeedEvent(i18n.getFixedT(language), insight(body));
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

describe("the notice of a retry, in the language of the interface", () => {
  it("says which retry this is, out of how many, and how long the runner waits", () => {
    const event = { code: "failureRetry", title: "The step failed: retry 2 of 3 in 12 s.", detail: "HTTP 503 — overloaded", attempt: 2, retries: 3, waitMs: 12_000 };
    expect(present("en", event)?.text).toBe("The step failed: retry 2 of 3 in 12 s.");
    expect(present("it", event)?.text).toBe("Il passo non è riuscito: nuovo tentativo 2 di 3 tra 12 s.");
    expect(present("it", event)?.detail, "the failure itself stays as the engine reported it").toBe("HTTP 503 — overloaded");
    expect(present("en", event)?.tone).toBe("warning");
  });

  it("reads the wait in whole seconds", () => {
    const text = (waitMs: number) => present("en", { code: "failureRetry", title: "t", attempt: 1, retries: 3, waitMs })?.text;
    expect(text(4_000)).toBe("The step failed: retry 1 of 3 in 4 s.");
    expect(text(36_400)).toBe("The step failed: retry 1 of 3 in 36 s.");
    expect(text(300_000)).toBe("The step failed: retry 1 of 3 in 300 s.");
    expect(text(40)).toBe("The step failed: retry 1 of 3 in 0 s.");
  });

  it("keeps saying that it retries once when that is all the runner allows", () => {
    const event = { code: "failureRetry", title: "The step failed: retrying once.", attempt: 1, retries: 1, waitMs: 4_000 };
    expect(present("en", event)?.text).toBe("The step failed: retrying once.");
    expect(present("it", event)?.text).toBe("Il passo non è riuscito: riprovo una volta.");
  });

  it("tells a retry with a larger output limit apart, because it does not wait", () => {
    const event = { code: "failureRetry", title: "The model used all its output tokens while reasoning: retrying once with a 3× larger limit.", attempt: 1, retries: 1, waitMs: 0 };
    expect(present("en", event)?.text).toBe("The model used its whole output limit while reasoning: retrying once with a larger limit.");
    expect(present("it", event)?.text).toBe("Il modello ha usato tutto il limite di output ragionando: riprovo una volta con un limite più ampio.");
  });

  it("reads the notices an earlier version saved in the feed, which carry no counters, without showing a placeholder", () => {
    const old = { code: "failureRetry", title: "The step failed: retrying once." };
    expect(present("en", old)?.text).toBe("The step failed: retrying once.");
    expect(present("it", old)?.text).toBe("Il passo non è riuscito: riprovo una volta.");
    for (const language of ["en", "it"] as const) {
      for (const body of [old, { ...old, attempt: 2 }, { ...old, retries: 3 }, { ...old, attempt: 2, retries: 3 }, { ...old, attempt: "2", retries: "3", waitMs: "soon" }]) {
        expect(present(language, body)?.text, JSON.stringify(body)).not.toMatch(/\{\{|undefined|NaN/);
      }
    }
  });

  it("leaves the notices without a code as the engine wrote them", () => {
    expect(present("it", { title: "Capitolo 1 approvato (8/10)", attempt: 1, retries: 3, waitMs: 4_000 })?.text).toBe("Capitolo 1 approvato (8/10)");
    expect(present("it", { code: "someFutureCode", title: "A notice from a newer engine." })?.text, "a code the site does not know yet shows the engine's own words").toBe("A notice from a newer engine.");
  });
});

describe("the notice that a money budget cannot apply", () => {
  const event = { code: "budgetNotApplicable", title: "The money budget does not apply: the model gpt-x has no price.", detail: "Set a token budget instead: it works for every model." };

  it("is translated, and keeps what the engine adds", () => {
    expect(present("en", event)?.text).toBe("The money budget does not apply: a model used here has no price.");
    expect(present("it", event)?.text).toBe("Il budget in denaro non si applica: un modello usato qui non ha un prezzo.");
    expect(present("en", event)?.detail).toBe("Set a token budget instead: it works for every model.");
    expect(present("it", event)?.tone).toBe("warning");
  });
});

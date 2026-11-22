import { describe, expect, it } from "vitest";
import type { AutopilotActivity, AutopilotErrorDetail, AutopilotRetryInfo, AutopilotStateSummary } from "narrarium-engine";
import { ERROR_KINDS, diagnosticsText, errorFacts, errorKindOf, failureSource, formatCountdown, secondsLeft } from "@/autopilot/errorModel";

const T0 = "2026-11-21T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

let counter = 0;
const failed = (patch: Partial<AutopilotActivity> = {}): AutopilotActivity => {
  counter += 1;
  return { id: `a${counter}`, runId: "run-1", task: "write", phase: "write", title: "Writing scene 2 of chapter 5", reason: "", next: "", chapterNumber: 5, sceneNumber: 2, status: "failed", startedAt: at(counter * 20), endedAt: at(counter * 20 + 10), error: "Connection error.", ...patch };
};
const worked = (patch: Partial<AutopilotActivity> = {}): AutopilotActivity => failed({ status: "succeeded", error: undefined, ...patch });

type Source = Pick<AutopilotStateSummary, "status" | "lastError" | "retry">;
const summary = (patch: Partial<Source> = {}): Source => ({ status: "error", lastError: null, ...patch });
const lastError = (patch: Record<string, unknown> = {}) => ({ message: "Connection error.", at: at(200), task: "write" as const, ...patch });
const DETAIL: AutopilotErrorDetail = { endpoint: "https://api.openai.com", model: "gpt-4.1", provider: "openai", integration: "ai-1", status: 429, attempt: 3, retries: 3 };

describe("the kinds of error", () => {
  it("are the twelve the engine tells, in the order it lists them", () => {
    expect([...ERROR_KINDS]).toEqual(["network", "auth", "rate_limit", "timeout", "truncated", "refused", "conflict", "budget", "limit", "profile", "provider", "unknown"]);
  });

  it("is the kind the engine said, whatever the words of the message are", () => {
    expect(errorKindOf("auth", "Connection error.")).toBe("auth");
    for (const kind of ERROR_KINDS) expect(errorKindOf(kind)).toBe(kind);
  });

  it("is unknown for a kind this version does not know, and for no kind at all", () => {
    expect(errorKindOf("a-new-kind", "Something")).toBe("unknown");
    expect(errorKindOf(undefined, "Something")).toBe("unknown");
    expect(errorKindOf(undefined, undefined)).toBe("unknown");
  });

  it("reads a profile problem from the words, for a state that an older engine wrote and said no kind of: the refusal to rewrite a file whose front matter cannot be read", () => {
    expect(errorKindOf(undefined, "The frontmatter of chapters/001-the-arrival/chapter.md (line 4: a mapping is not allowed here) cannot be read: the autopilot will not rewrite it.")).toBe("profile");
    expect(errorKindOf(undefined, "Il frontmatter di chapters/002-la-diga/001-alba.md (riga 4: una mappa non è permessa qui) non è leggibile.")).toBe("profile");
  });
});

describe("what went wrong, as the page tells it", () => {
  it("is the last error of a run that ended, with its kind and its detail as the summary says them", () => {
    const source = failureSource(summary({ lastError: lastError({ kind: "network", detail: DETAIL }) }), []);
    expect(source).toMatchObject({ kind: "network", classified: true, detail: DETAIL, message: "Connection error.", at: at(200), task: "write", ended: true, retry: null, repeats: 1, step: null });
  });

  it("reads the kind and the detail under the names the saved state gives them, too", () => {
    const source = failureSource(summary({ lastError: lastError({ errorKind: "auth", errorDetail: { status: 401 } }) }), []);
    expect(source).toMatchObject({ kind: "auth", classified: true, detail: { status: 401 } });
  });

  it("is unknown, and says the engine did not classify it, for a last error that has no kind: an older engine wrote it", () => {
    const source = failureSource(summary({ lastError: lastError() }), []);
    expect(source).toMatchObject({ kind: "unknown", classified: false, detail: {} });
  });

  it("is a profile problem, read from the words, for such an old state", () => {
    const message = "The frontmatter of chapters/001-the-arrival/chapter.md (line 4: a mapping is not allowed here) cannot be read.";
    expect(failureSource(summary({ lastError: lastError({ message }) }), [])).toMatchObject({ kind: "profile", classified: false });
  });

  it("is the failure the runner is going to try again, while it waits: the newest attempt that failed, and the retry that is on its way", () => {
    const retry: AutopilotRetryInfo = { at: at(236), attempt: 2, retries: 3 };
    const attempt = failed({ error: "429 Rate limit reached", errorKind: "rate_limit", errorDetail: { status: 429, model: "gpt-4.1" } });
    const source = failureSource(summary({ status: "running", retry }), [worked(), attempt]);
    expect(source).toMatchObject({ kind: "rate_limit", classified: true, detail: { status: 429, model: "gpt-4.1" }, message: "429 Rate limit reached", ended: false, retry, repeats: 1, step: attempt });
  });

  it("is a failure of no known kind, with nothing to say about it, when the retry waits and the log has not been read yet", () => {
    const retry: AutopilotRetryInfo = { at: at(236), attempt: 1, retries: 3 };
    expect(failureSource(summary({ status: "running", retry }), [])).toMatchObject({ kind: "unknown", classified: false, message: "", ended: false, retry, step: null });
  });

  it("is nothing when the run goes well, when it is stopped for another reason, or when it is complete", () => {
    expect(failureSource(summary({ status: "running" }), [failed()])).toBeNull();
    expect(failureSource(summary({ status: "paused", lastError: lastError({ kind: "network" }) }), [failed()])).toBeNull();
    expect(failureSource(summary({ status: "completed", lastError: lastError({ kind: "network" }) }), [])).toBeNull();
    expect(failureSource(summary({ status: "waiting-author" }), [])).toBeNull();
    expect(failureSource(summary({ status: "error", lastError: null }), [failed()])).toBeNull();
    expect(failureSource(null, [failed()])).toBeNull();
    expect(failureSource(undefined, [])).toBeNull();
  });

  it("does not count a retry that a run no longer waits for: it is only a retry while the run is running", () => {
    expect(failureSource(summary({ status: "paused", retry: { at: at(236), attempt: 2, retries: 3 } }), [failed()])).toBeNull();
    expect(failureSource(summary({ status: "error", lastError: lastError({ kind: "network" }), retry: { at: at(236), attempt: 2, retries: 3 } }), [])?.retry).toBeNull();
  });
});

describe("the same failure, said once", () => {
  it("counts the attempts of the step that failed in a row with the same words, and finds the step in the log", () => {
    const attempts = [failed(), failed(), failed(), failed()];
    const source = failureSource(summary({ lastError: lastError({ kind: "network", at: attempts[3].endedAt }) }), [worked(), ...attempts]);
    expect(source?.repeats).toBe(4);
    expect(source?.step).toBe(attempts[3]);
  });

  it("stops counting at an attempt that failed in another way, at another step, or that worked", () => {
    const other = failed({ error: "429 Rate limit reached" });
    const again = [failed(), failed()];
    const atEnd = again[1].endedAt;
    expect(failureSource(summary({ lastError: lastError({ at: atEnd }) }), [failed(), other, ...again])?.repeats).toBe(2);
    expect(failureSource(summary({ lastError: lastError({ at: atEnd }) }), [failed({ sceneNumber: 1 }), ...again])?.repeats).toBe(2);
    expect(failureSource(summary({ lastError: lastError({ at: atEnd }) }), [failed(), worked(), ...again])?.repeats).toBe(2);
  });

  it("does not take a step that failed long before for the one that stopped the run", () => {
    const old = failed({ startedAt: at(-7200), endedAt: at(-7190) });
    const source = failureSource(summary({ lastError: lastError({ kind: "network", at: at(300) }) }), [old]);
    expect(source).toMatchObject({ step: null, repeats: 1 });
  });

  it("looks for the kind of step the error came from, when the error says it", () => {
    const write = failed({ task: "write" });
    const review = failed({ task: "director-review", sceneNumber: undefined, error: "Connection error." });
    const source = failureSource(summary({ lastError: lastError({ task: "write", at: review.endedAt }) }), [write, review]);
    expect(source?.step).toBe(write);
  });
});

describe("where it happened", () => {
  const names = new Map([["ai-1", "OpenAI (work)"]]);

  it("lists what the engine knows, in the order a person looks for it, with the name the settings give the integration", () => {
    expect(errorFacts(DETAIL, (id) => names.get(id))).toEqual([
      { key: "endpoint", value: "https://api.openai.com" },
      { key: "model", value: "gpt-4.1" },
      { key: "provider", value: "openai" },
      { key: "integration", value: "OpenAI (work)" },
      { key: "status", value: "429" },
      { key: "attempt", attempt: 3, retries: 3 },
    ]);
  });

  it("names the integration by its id when the settings do not know it (a run on the server may use one this browser does not have)", () => {
    expect(errorFacts({ integration: "ai-9" }, (id) => names.get(id))).toEqual([{ key: "integration", value: "ai-9" }]);
    expect(errorFacts({ integration: "ai-9" })).toEqual([{ key: "integration", value: "ai-9" }]);
  });

  it("leaves out what is not there, and says nothing for a detail that is empty", () => {
    expect(errorFacts({})).toEqual([]);
    expect(errorFacts({ model: "gpt-4.1", provider: "" })).toEqual([{ key: "model", value: "gpt-4.1" }]);
  });

  it("says which retry it was only when it knows both numbers: a failure that is never retried has neither", () => {
    expect(errorFacts({ status: 401 })).toEqual([{ key: "status", value: "401" }]);
    expect(errorFacts({ attempt: 2 })).toEqual([]);
    expect(errorFacts({ retries: 3 })).toEqual([]);
  });
});

describe("the diagnostics a person can copy", () => {
  const source = (patch: Record<string, unknown> = {}) => {
    const attempts = [failed(), failed()];
    return failureSource(summary({ lastError: lastError({ kind: "rate_limit", detail: DETAIL, at: attempts[1].endedAt, ...patch }) }), attempts)!;
  };
  const input = (patch: Record<string, unknown> = {}) => ({ source: source(patch), appVersion: "0.88.0", engineVersion: "0.1.6", host: "browser" as const, at: new Date("2026-11-21T10:05:00.000Z"), integrationName: "OpenAI (work)" });

  it("says the category, where it happened, what it said, the versions and the time", () => {
    const text = diagnosticsText(input());
    for (const line of ["Narrarium autopilot diagnostics", "Time: 2026-11-21T10:05:00.000Z", "App: 0.88.0", "Engine: 0.1.6", "Runs on: browser", "Problem: rate_limit", "Step: write, chapter 5, scene 2", "HTTP status: 429", "Endpoint: https://api.openai.com", "Model: gpt-4.1", "Provider: openai", "Integration: OpenAI (work) (ai-1)", "Retry: 3 of 3", "Message: Connection error."]) {
      expect(text, line).toContain(line);
    }
    expect(text).not.toMatch(/undefined|null|NaN/);
  });

  it("says that the run stopped, or that it is still trying, and how many attempts failed in a row", () => {
    expect(diagnosticsText(input())).toContain("State: the run stopped");
    expect(diagnosticsText(input())).toContain("Failed in a row: 2");
    const retrying = failureSource(summary({ status: "running", retry: { at: at(236), attempt: 1, retries: 3 } }), [failed()])!;
    expect(diagnosticsText({ ...input(), source: retrying })).toContain("State: the autopilot is waiting to try again");
  });

  it("takes the keys out of the message, however they are written, and leaves the rest", () => {
    const text = diagnosticsText(input({ message: "401 Incorrect API key sk-abcdefghijklmnopqrstuvwx. Authorization: Bearer abcdef123456789 https://x.test/v1?key=SECRETVALUE12345 api-key: hunter2hunter2" }));
    expect(text).not.toMatch(/sk-abcdefghijkl|abcdef123456789|SECRETVALUE|hunter2hunter2/);
    expect(text).toContain("Incorrect API key");
  });

  it("does not tell where the files of a server are: a path of its disk is taken out, a path inside the book is not", () => {
    const text = diagnosticsText(input({ message: "ENOENT: no such file '/var/lib/narrarium/.local/share/narrarium-server/books/b1/repo/chapters/001/chapter.md' and C:\\Users\\Ada\\books\\b1\\x.md; see chapters/001-one/chapter.md" }));
    expect(text).not.toMatch(/\/var\/lib|narrarium-server|C:\\Users/);
    expect(text).toContain("chapters/001-one/chapter.md");
  });

  it("keeps it short: a long message is cut", () => {
    const text = diagnosticsText(input({ message: "x".repeat(5000) }));
    expect(text.length).toBeLessThan(1600);
    expect(text).toMatch(/…/);
  });

  it("has no book title and no prompt in it: it is not given them", () => {
    expect(diagnosticsText(input())).not.toMatch(/The Glass Harbor|prompt/i);
  });
});

describe("the countdown", () => {
  it("says how many seconds are left to a moment, rounding up so that it never reads 0 before the moment comes", () => {
    const now = Date.parse(T0);
    expect(secondsLeft(at(36), now)).toBe(36);
    expect(secondsLeft(new Date(now + 35_001).toISOString(), now)).toBe(36);
    expect(secondsLeft(at(0), now)).toBe(0);
    expect(secondsLeft(at(-5), now), "a moment that has passed").toBe(0);
  });

  it("has no seconds for a moment that is not a date", () => {
    expect(secondsLeft("soon", Date.now())).toBeNull();
    expect(secondsLeft("", Date.now())).toBeNull();
  });

  it("writes seconds as seconds, and a minute and more with the minutes", () => {
    expect(formatCountdown(0)).toBe("0 s");
    expect(formatCountdown(12)).toBe("12 s");
    expect(formatCountdown(59)).toBe("59 s");
    expect(formatCountdown(60)).toBe("1 min 00 s");
    expect(formatCountdown(65)).toBe("1 min 05 s");
    expect(formatCountdown(300)).toBe("5 min 00 s");
  });
});

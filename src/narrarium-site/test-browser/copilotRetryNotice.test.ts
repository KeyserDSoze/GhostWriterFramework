import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { announceRetry, listenToRetries, retryNoticeText, type RetryNotice } from "@/assistant/retryNotice";
import { completeTextRouted, completeToolRouted } from "@/assistant/router";
import { assertProvidersClean, failReply } from "./helpers/fakeProvider";
import { compatible } from "./helpers/aiFixtures";
import { MESSAGES, provide, resetStores, routeOf, speak, speakCall } from "./helpers/copilotHarness";
import { SCHEMA } from "./helpers/aiFixtures";
import { guideText, loadGuides } from "./helpers/guides";

const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: undefined as any }), (error: unknown) => ({ value: undefined as T | undefined, error: error as any }));

describe("what the chat says while the Copilot waits to try again", () => {
  beforeAll(async () => {
    await loadAutopilotTranslations();
  });

  it("says it as the owner wrote it, in English", async () => {
    await i18n.changeLanguage("en");
    expect(retryNoticeText({ attempt: 2, of: 3, waitMs: 3_000 }, i18n.t.bind(i18n))).toBe("The provider answered with a passing error: trying again in 3 s (2 of 3)…");
    expect(retryNoticeText({ attempt: 3, of: 3, waitMs: 2_400 }, i18n.t.bind(i18n))).toBe("The provider answered with a passing error: trying again in 2 s (3 of 3)…");
  });

  it("says it as the owner wrote it, in Italian", async () => {
    await i18n.changeLanguage("it");
    expect(retryNoticeText({ attempt: 2, of: 3, waitMs: 3_000 }, i18n.t.bind(i18n))).toBe("Il provider ha risposto con un errore passeggero: riprovo tra 3 s (2 di 3)…");
    await i18n.changeLanguage("en");
  });

  it("never says less than a second, and rounds to the second: it is not a countdown", async () => {
    await i18n.changeLanguage("en");
    const t = i18n.t.bind(i18n);
    expect(retryNoticeText({ attempt: 2, of: 3, waitMs: 750 }, t)).toContain("in 1 s");
    expect(retryNoticeText({ attempt: 2, of: 3, waitMs: 1_250 }, t)).toContain("in 1 s");
    expect(retryNoticeText({ attempt: 3, of: 3, waitMs: 10_000 }, t)).toContain("in 10 s");
  });
});

describe("the notices of a call reach whoever listens to that call, and nobody else", () => {
  it("tells the listener of a signal, and only the listener of that signal", () => {
    const mine = new AbortController();
    const other = new AbortController();
    const mineSeen: RetryNotice[] = [];
    const otherSeen: RetryNotice[] = [];
    const stopMine = listenToRetries(mine.signal, (notice) => mineSeen.push(notice));
    const stopOther = listenToRetries(other.signal, (notice) => otherSeen.push(notice));

    announceRetry(mine.signal, { attempt: 2, of: 3, waitMs: 1_000 });
    announceRetry(undefined, { attempt: 2, of: 3, waitMs: 1_000 });

    expect(mineSeen).toEqual([{ attempt: 2, of: 3, waitMs: 1_000 }]);
    expect(otherSeen).toEqual([]);
    stopMine();
    stopOther();
    announceRetry(mine.signal, { attempt: 3, of: 3, waitMs: 3_000 });
    expect(mineSeen, "a listener that stopped listening hears nothing").toHaveLength(1);
  });

  it("never lets a listener that throws break the call that announces", () => {
    const controller = new AbortController();
    const stop = listenToRetries(controller.signal, () => { throw new Error("a listener that fails"); });
    expect(() => announceRetry(controller.signal, { attempt: 2, of: 3, waitMs: 1_000 })).not.toThrow();
    stop();
  });
});

describe("a call of the Copilot says once for each retry that it is waiting", () => {
  beforeEach(() => {
    resetStores();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    assertProvidersClean();
  });

  it("tells the listener of its signal the number of the attempt that comes, how many there are, and the wait: two notices for three attempts", async () => {
    const a = compatible("a");
    let count = 0;
    provide([a], (call) => (++count <= 2 ? failReply(503, "The engine is overloaded") : speak("A whole line.")(call)));
    const controller = new AbortController();
    const notices: RetryNotice[] = [];
    listenToRetries(controller.signal, (notice) => notices.push(notice));

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(1_250 + 3_750);
    await run;

    expect(notices.map((notice) => [notice.attempt, notice.of])).toEqual([[2, 3], [3, 3]]);
    expect(notices[0].waitMs).toBeGreaterThanOrEqual(750);
    expect(notices[0].waitMs).toBeLessThanOrEqual(1_250);
    expect(notices[1].waitMs).toBeGreaterThanOrEqual(2_250);
    expect(notices[1].waitMs).toBeLessThanOrEqual(3_750);
  });

  it("tells it for a forced call too, and says nothing when the first attempt succeeds, or when the error is not a passing one", async () => {
    const a = compatible("a");
    const controller = new AbortController();
    const notices: RetryNotice[] = [];
    listenToRetries(controller.signal, (notice) => notices.push(notice));

    provide([a], speakCall({ ok: true }));
    await completeToolRouted(routeOf("copilot", [a]), MESSAGES, "copilot", SCHEMA, { accountScope: null, signal: controller.signal });
    expect(notices).toEqual([]);

    provide([a], () => failReply(400, "Refused"));
    await outcome(completeToolRouted(routeOf("copilot", [a]), MESSAGES, "copilot", SCHEMA, { accountScope: null, signal: controller.signal }));
    expect(notices).toEqual([]);

    let count = 0;
    provide([a], (call) => (++count === 1 ? failReply(503, "Busy") : speakCall({ ok: true })(call)));
    const run = outcome(completeToolRouted(routeOf("copilot", [a]), MESSAGES, "copilot", SCHEMA, { accountScope: null, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(1_250);
    await run;
    expect(notices.map((notice) => [notice.attempt, notice.of])).toEqual([[2, 3]]);
  });

  it("says nothing to a listener of another call: the notices of a request do not appear in the chat of another", async () => {
    const a = compatible("a");
    let count = 0;
    provide([a], (call) => (++count === 1 ? failReply(503, "Busy") : speak("A whole line.")(call)));
    const mine = new AbortController();
    const other = new AbortController();
    const heard: RetryNotice[] = [];
    listenToRetries(other.signal, (notice) => heard.push(notice));

    const run = outcome(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null, signal: mine.signal }));
    await vi.advanceTimersByTimeAsync(1_250);
    await run;

    expect(heard).toEqual([]);
  });
});

describe.each(["en", "it"] as const)("the help to the AI Router tells about the quiet retry, in the words of the chat (%s)", (language) => {
  beforeAll(async () => {
    await Promise.all([loadGuides(), loadAutopilotTranslations()]);
  });
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("quotes the sentence that the chat says, with the same words", async () => {
    await i18n.changeLanguage(language);
    const sentence = retryNoticeText({ attempt: 2, of: 3, waitMs: 3_000 }, i18n.t.bind(i18n));
    expect(guideText("ai-router", language)).toContain(`«${sentence}»`);
  });

  it("says what is tried again, how many times and after how long, that Stop ends the wait, and what is never repeated", () => {
    const help = guideText("ai-router", language);
    if (language === "en") {
      for (const part of [/Passing errors/, /429, a 500, 502, 503 or 504/, /at most two more times/, /about 1 s and then about 3 s/, /more than 10 s/, /\*\*Total routing time \(ms\)\*\*/, /\*\*Stop\*\* ends the wait at once/, /never repeated/, /ran out of time/, /400, 401, 403, 404/]) expect(help).toMatch(part);
    } else {
      for (const part of [/Errori passeggeri/, /429, un 500, 502, 503 o 504/, /al massimo altre due volte/, /circa 1 s e poi circa 3 s/, /più di 10 s/, /\*\*Tempo totale di routing \(ms\)\*\*/, /\*\*Stop\*\* chiude subito l'attesa/, /non vengono mai ripetuti/, /scaduta/, /400, 401, 403, 404/]) expect(help).toMatch(part);
    }
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { AutopilotSession, summarizeAutopilotState, writeOutlineBrief, type AutopilotEvent, type AutopilotStateSummary } from "narrarium-engine";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { presentFeedEvent } from "@/autopilot/format";
import { isProblemLine, isProfileProblemStop, problemLines, profilePageRoute, profilePagesFor } from "@/autopilot/stopReason";
import { isPitchChoiceStop, studioHref } from "@/autopilot/pitchChoice";

const AT = "2026-11-21T10:00:00.000Z";
const START = { brief: { idea: "x", wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, pauseAfterPlan: false } };

/** What the engine itself says when a profile cannot be read: a run started over a book whose files are damaged. */
async function stoppedBy(files: Record<string, string>, language = "en", options: Record<string, unknown> = {}): Promise<{ summary: AutopilotStateSummary; events: AutopilotEvent[] }> {
  const store = new MemoryBookStore({ ...seedBookFiles({ language, chapters: 1 }), ...files });
  const session = new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "test", retryDelayMs: 0 });
  const events: AutopilotEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.start({ ...START, options: { ...START.options, ...options } });
  await session.waitForIdle();
  const state = (await session.snapshot()).state;
  return { summary: summarizeAutopilotState(state!), events };
}

const BROKEN_DIRECTOR = "---\nname: Ada: the strict\nstrictness: 9\n---\nVision";
const t = (language: "en" | "it") => i18n.getFixedT(language);

beforeAll(async () => {
  await loadAutopilotTranslations();
});

describe("the insight the engine emits when a profile cannot be read", () => {
  it("is translated in both languages, with the list of problems shown as the engine wrote it", async () => {
    const { events } = await stoppedBy({ "director.md": BROKEN_DIRECTOR });
    const insight = events.find((event) => event.type === "insight" && event.code === "profileProblems");
    expect(insight, "the engine says it with a code").toBeDefined();
    const detail = (insight as { detail?: string }).detail ?? "";
    expect(detail).toMatch(/^director\.md: the frontmatter is not valid YAML/);

    const english = presentFeedEvent(t("en"), insight!);
    expect(english?.text).toBe("Correct the profile files before resuming: the autopilot does not use a profile it cannot read as it is written.");
    expect(english?.tone).toBe("warning");
    expect(english?.detail, "the problems stay as the engine reported them").toBe(detail);

    const italian = presentFeedEvent(t("it"), insight!);
    expect(italian?.text).toBe("Correggi i file dei profili prima di riprendere: l'autopilot non usa un profilo che non riesce a leggere così com'è scritto.");
    expect(italian?.detail).toBe(detail);
  });

  it("keeps one line for each problem when there are several", () => {
    const lines = ["director.md: autonomy «sometimes» is not one of full, ask-on-critical, ask-always: ask-on-critical is used", "ghostwriters/default.md: temperature «hot» is not a number: 0.8 is used"];
    const event = { bookId: "book-1", at: AT, seq: 1, type: "insight", tone: "warning", code: "profileProblems", title: "x", detail: lines.join("\n") } as AutopilotEvent;
    expect(presentFeedEvent(t("it"), event)?.detail).toBe(lines.join("\n"));
  });
});

describe("a run that waits for the author without a question", () => {
  it("is told apart from a question of the director, whatever the language of the book", async () => {
    const english = await stoppedBy({ "director.md": BROKEN_DIRECTOR });
    expect(english.summary.status).toBe("waiting-author");
    expect(english.summary.question).toBeNull();
    expect(isProfileProblemStop(english.summary)).toBe(true);

    const italian = await stoppedBy({ "director.md": BROKEN_DIRECTOR }, "it");
    expect(isProfileProblemStop(italian.summary)).toBe(true);
  });

  it("is not a stop for profiles when the director has a question, or the run is in any other state", () => {
    const asking = { status: "waiting-author", question: { id: "q", kind: "director", question: "Which?", context: "", options: [], askedAt: AT } };
    expect(isProfileProblemStop(asking as never)).toBe(false);
    for (const status of ["idle", "running", "paused", "error", "completed"]) expect(isProfileProblemStop({ status, question: null } as never), status).toBe(false);
    expect(isProfileProblemStop(null)).toBe(false);
    expect(isProfileProblemStop(undefined)).toBe(false);
  });

  it("is a stop for profiles even when the message is missing: the status says it", () => {
    expect(isProfileProblemStop({ status: "waiting-author", question: null, message: null } as never)).toBe(true);
  });
});

describe("the message of that stop, as readable lines", () => {
  it("gives one line for the one problem, without the engine's own heading", async () => {
    const { summary } = await stoppedBy({ "director.md": BROKEN_DIRECTOR });
    const lines = problemLines(summary.message);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^director\.md: the frontmatter is not valid YAML \(line 2: .+\): the profile could not be read as the file says; correct the file\.$/);
  });

  it("gives one line for each problem, and the count of the ones that are not listed on a line of its own", async () => {
    const weights = Array.from({ length: 12 }, (_, index) => `  standard-r${index}: heavy`).join("\n");
    const { summary } = await stoppedBy({ "director.md": `---\nname: Ada\nreader_weights:\n${weights}\n---\nVision` });
    const lines = problemLines(summary.message);
    expect(lines).toHaveLength(9);
    expect(lines.slice(0, 8).every((line) => line.startsWith("director.md: the weight of standard-r"))).toBe(true);
    expect(lines[8]).toBe("(and 4 more)");
  });

  it("reads the message of a book written in Italian the same way", async () => {
    const weights = Array.from({ length: 12 }, (_, index) => `  standard-r${index}: heavy`).join("\n");
    const { summary } = await stoppedBy({ "director.md": `---\nname: Ada\nreader_weights:\n${weights}\n---\nVisione` }, "it");
    expect(summary.message).toMatch(/^Correggi i profili/);
    const lines = problemLines(summary.message);
    expect(lines).toHaveLength(9);
    expect(lines[0].startsWith("director.md:")).toBe(true);
    expect(lines[8]).toBe("(e altri 4)");
  });

  it("keeps a message it does not recognise whole, as a single line", () => {
    expect(problemLines("Something a newer engine says.")).toEqual(["Something a newer engine says."]);
    expect(problemLines("")).toEqual([]);
    expect(problemLines(null)).toEqual([]);
    expect(problemLines(undefined)).toEqual([]);
  });

  it("never drops a part of the message, even one that is not a problem of its own", () => {
    const message = "Correct these profiles before resuming: the autopilot does not use a profile it cannot read as it is written. director.md: a · b · personas/x.md: c";
    expect(problemLines(message)).toEqual(["director.md: a", "b", "personas/x.md: c"]);
  });

  it("keeps a heading it does not recognise as the first line, rather than losing it", () => {
    expect(problemLines("Fix these first. director.md: a · personas/x.md: c")).toEqual(["Fix these first.", "director.md: a", "personas/x.md: c"]);
  });
});

describe("a design that waits for the author's choice of a pitch", () => {
  it("is a wait without a question that is not a profile to correct, and leads to the Studio", async () => {
    const store = new MemoryBookStore(seedBookFiles({ chapters: 0 }));
    await writeOutlineBrief(store, { idea: "A harbor town built on glass hides a lie that the tide will tell.", wordsPerScene: 200 });
    const session = new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "test", retryDelayMs: 0 });
    await session.start({ design: { chapters: 2, workflow: { alternatives: 3, pitchChoice: "author" } }, options: { readersOnPlan: false, pauseAfterPlan: false } });
    await session.waitForIdle();
    const waiting = summarizeAutopilotState((await session.snapshot()).state!);
    expect(waiting).toMatchObject({ status: "waiting-author", question: null, design: { active: true, choosePitch: true } });
    expect(isPitchChoiceStop(waiting)).toBe(true);
    expect(isProfileProblemStop(waiting)).toBe(false);
    expect(studioHref("book 1")).toBe("/app/books/book%201/outline?tab=studio");
    // Once she has chosen, nothing is waited for.
    const state = (await session.snapshot()).state!;
    await session.chooseDesignPitch({ id: state.design!.alternatives!.pitches[0].id });
    const chosen = summarizeAutopilotState((await session.snapshot()).state!);
    expect(isPitchChoiceStop(chosen)).toBe(false);
  });

  it("is told apart by the summary alone: any other stop without a question is still a profile problem", () => {
    const base = { status: "waiting-author" as const, question: null };
    expect(isProfileProblemStop(base)).toBe(true);
    expect(isProfileProblemStop({ ...base, design: { active: true, chapters: 2, rounds: 0, maxRounds: 3 } })).toBe(true);
    expect(isProfileProblemStop({ ...base, design: { active: true, chapters: 2, rounds: 0, maxRounds: 3, choosePitch: true } })).toBe(false);
    expect(isPitchChoiceStop({ status: "paused", design: { active: true, chapters: 2, rounds: 0, maxRounds: 3, choosePitch: true } })).toBe(false);
    expect(isPitchChoiceStop(null)).toBe(false);
  });
});

describe("which pages correct the files a message names", () => {
  it("points at the page of each kind of file", () => {
    expect(profilePagesFor(["director.md: autonomy «x» is not one of full"])).toEqual(["director"]);
    expect(profilePagesFor(["ghostwriters/default.md: the frontmatter is not valid YAML"])).toEqual(["ghostwriters"]);
    expect(profilePagesFor(["personas/standard-general.md: enabled «maybe» is neither yes nor no"])).toEqual(["readers"]);
  });

  it("lists each page once, in the order of the pages, whatever the order of the problems", () => {
    expect(profilePagesFor(["personas/a.md: x", "director.md: y", "personas/b.md: z", "ghostwriters/g.md: w"])).toEqual(["director", "ghostwriters", "readers"]);
  });

  it("offers every page when the message names none it recognises: the author is never left without a way to the files", () => {
    expect(profilePagesFor(["Something a newer engine says."])).toEqual(["director", "ghostwriters", "readers", "evaluationStyle"]);
    expect(profilePagesFor([])).toEqual(["director", "ghostwriters", "readers", "evaluationStyle"]);
  });

  it("points at the Brainstormer's page when its file is the one named, after the others, and offers it to no author who has no problem with it", () => {
    expect(profilePagesFor(["brainstormer.md: boldness «x» is not a number from 1 to 10: 6 is used"])).toEqual(["brainstormer"]);
    expect(profilePagesFor(["brainstormer.md: a", "personas/a.md: b", "director.md: c"])).toEqual(["director", "readers", "brainstormer"]);
    expect(profilePageRoute("book-1", "brainstormer")).toBe("/app/books/book-1/brainstormer");
    expect(isProblemLine("brainstormer.md: boldness «x» is not a number from 1 to 10")).toBe(true);
    expect(problemLines("Correct this profile before resuming: brainstormer.md: boldness «x» is not a number · director.md: strictness is not a number")).toEqual(["brainstormer.md: boldness «x» is not a number", "director.md: strictness is not a number"]);
  });

  it("finds the Brainstormer's file in what a design run really says when it cannot read it", async () => {
    const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 0 }), "brainstormer.md": "---\nboldness: very bold\n---\n\nNotes" });
    await writeOutlineBrief(store, { idea: "A harbor town built on glass hides a lie that the tide will tell.", wordsPerScene: 200 });
    const session = new AutopilotSession({ bookId: "book-1", store, ai: createFakeAutopilotAi(), host: "browser", hostLabel: "test", retryDelayMs: 0 });
    await session.start({ design: { chapters: 2 }, options: { readersOnPlan: false, pauseAfterPlan: false } });
    await session.waitForIdle();
    const summary = summarizeAutopilotState((await session.snapshot()).state!);
    expect(isProfileProblemStop(summary)).toBe(true);
    expect(problemLines(summary.message).some((line) => isProblemLine(line) && line.startsWith("brainstormer.md: boldness"))).toBe(true);
    expect(profilePagesFor(problemLines(summary.message))).toEqual(["brainstormer"]);
  });

  it("finds the files in what the engine really says", async () => {
    const ghostwriter = await stoppedBy({ "ghostwriters/default.md": "---\nname: Default: Ghost\ntone: Natural\n---\n\nWrite well.\n" });
    expect(profilePagesFor(problemLines(ghostwriter.summary.message))).toEqual(["ghostwriters"]);
    const reader = await stoppedBy({ "personas/standard-general.md": "---\nid: reader:standard.general\nenabled: false\nname: General: reader\n---\nbody" }, "en", { readers: true, maxReaders: 2 });
    expect(profilePagesFor(problemLines(reader.summary.message))).toEqual(["readers"]);
  });
});

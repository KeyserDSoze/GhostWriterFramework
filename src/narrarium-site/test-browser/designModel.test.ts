import { describe, expect, it } from "vitest";
import { OUTLINE_BOOK_FILE, createAutopilotState, parseMarkdown, serializeBibleThemes, serializeOutlineBook, type AutopilotState } from "narrarium-engine";
import { approveDesignChange, defaultDesignChapters, designApprovalOf, designBlockOf, designDraftOf, designOfDraft, designPatchOf, designStatusOf, filledDesignFields, readDesignForm, sameDesign, type DesignForm } from "@/outline/designModel";
import { composeBible, worldEntries } from "@/outline/bibleModel";

const at = new Date("2026-11-26T10:00:00.000Z");

function stateWith(patch: Partial<AutopilotState>): AutopilotState {
  return { ...createAutopilotState(at), ...patch };
}

describe("the design of an entry, as its card edits it", () => {
  it("keeps the lists as lines, sends every field (null for the empty ones), and tells a draft that says the same from one that does not", () => {
    const design = { goal: "Learn the truth", pov: ["Mira", "Orrin"], cliffhanger: true };
    const draft = designDraftOf(design);
    expect(draft).toEqual({ goal: "Learn the truth", pov: "Mira\nOrrin", cliffhanger: true });
    expect(sameDesign(draft, design)).toBe(true);
    expect(sameDesign({ ...draft, pov: "Mira\nOrrin\n\n" }, design)).toBe(true);
    expect(sameDesign({ ...draft, ending: "A door closes." }, design)).toBe(false);
    expect(sameDesign(undefined, design)).toBe(true);
    const patch = designPatchOf({ ...draft, events: "- One\n- Two", cliffhanger: false });
    expect(patch.events).toEqual(["One", "Two"]);
    expect(patch.cliffhanger).toBeNull();
    expect(patch.notes).toBeNull();
    expect(designOfDraft({ goal: "  x  ", scenes: "a\n\nb" })).toEqual({ goal: "x", scenes: ["a", "b"] });
    expect(filledDesignFields(design)).toBe(3);
    expect(filledDesignFields(undefined)).toBe(0);
  });
});

describe("the design run as the Studio reads it", () => {
  it("is none, active, ready or ended by the author, with its reviews and its policy", () => {
    expect(designStatusOf(null)).toEqual({ kind: "none" });
    const rounds = [{ round: 1, score: 7, verdict: "revise" as const, critical: 1, findings: 2, at: at.toISOString() }];
    expect(designStatusOf(stateWith({ design: { startedAt: at.toISOString(), chapters: 8, rounds, review: { maxRounds: 4, targetScore: 8.5 } } }))).toEqual({ kind: "active", startedAt: at.toISOString(), chapters: 8, rounds, maxRounds: 4, target: 8.5 });
    const ready = designStatusOf(stateWith({ design: { startedAt: at.toISOString(), chapters: 8, rounds, endedAt: at.toISOString(), outcome: "plateau" } }));
    expect(ready).toMatchObject({ kind: "ready", outcome: "plateau", maxRounds: 3 });
    expect(designStatusOf(stateWith({ design: { startedAt: at.toISOString(), chapters: 8, rounds: [], endedAt: at.toISOString(), outcome: "author" } })).kind).toBe("ended");
  });

  it("cannot begin without a description, once the autopilot wrote a chapter, or on a personal server that does not design", () => {
    expect(designBlockOf({ description: " ", state: null })).toBe("description");
    const written = stateWith({ plan: { chapters: [{ number: 1, title: "One", slug: "001-one", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "writing", scenes: [{ number: 1, title: "S", goal: "", beats: [], characters: [], status: "written", revisions: 0 }] }], approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false } });
    expect(designBlockOf({ description: "An idea.", state: written })).toBe("written");
    expect(designBlockOf({ description: "An idea.", state: null, serverWithoutDesign: true })).toBe("server");
    expect(designBlockOf({ description: "An idea.", state: null })).toBeNull();
  });

  it("reads the dialog's form: the chapters from the entries the Synopsis has, the policy of the design, and the money cap", () => {
    const form: DesignForm = { chapters: "10", readers: true, target: "8,5", rounds: "4", readerRounds: "", campaignRounds: "", money: "2", tokens: "" };
    const reading = readDesignForm(form, 6);
    expect(reading.valid).toBe(true);
    expect(reading.input).toEqual({ chapters: 10, review: { targetScore: 8.5, maxRounds: 4 } });
    expect(reading.budgetLimit).toBe(2);
    expect(readDesignForm({ ...form, chapters: "4" }, 6).chaptersProblem).toBe("range");
    expect(readDesignForm({ ...form, chapters: "ten" }, 6).chaptersProblem).toBe("number");
    expect(readDesignForm({ ...form, target: "", rounds: "" }, 0).input.review).toBeNull();
    expect(defaultDesignChapters(0)).toBe(12);
    expect(defaultDesignChapters(7)).toBe(7);
  });
});

describe("the author's approval of a design", () => {
  it("is kept in outline/book.md beside the description, names the run it approves, and leaves the rest of the file as it was", () => {
    const file = serializeOutlineBook({ title: "Glass", body: "A harbor town built on glass.", origin: "author", frontmatter: { mood: "grey" } });
    const change = approveDesignChange({ content: file, hash: "h1" }, "2026-11-26T09:00:00.000Z", at);
    expect(change).toMatchObject({ path: OUTLINE_BOOK_FILE, expectedHash: "h1" });
    const document = parseMarkdown(change.content!);
    expect(document.body).toBe("A harbor town built on glass.");
    expect(document.frontmatter.mood).toBe("grey");
    expect(designApprovalOf(change.content!)).toEqual({ at: at.toISOString(), run: "2026-11-26T09:00:00.000Z" });
    expect(designApprovalOf(file)).toBeNull();
    const created = approveDesignChange(undefined, "run", at);
    expect(created.expectedHash).toBeNull();
    expect(designApprovalOf(created.content!)?.run).toBe("run");
    expect(() => approveDesignChange({ content: "---\ntitle: [broken\n---\n", hash: "h" }, "run", at)).toThrow();
  });
});

describe("the Bible composed from the book's files", () => {
  const files = [
    { path: "characters/mira-vale.md", content: "---\ntype: character\nname: Mira Vale\nstory_role: protagonist\narc: From silence to voice\ndesires:\n  - The truth\n---\n\n# Mira Vale\n\nA stubborn young glassmaker.", hash: "c1" },
    { path: "characters/orrin-hale.md", content: "---\ntype: character\nname: Orrin Hale\n---\n\n# Orrin Hale\n\nThe harbor master.", hash: "c2" },
    { path: "locations/glass-harbor.md", content: "---\ntype: location\nname: Glass Harbor\natmosphere: Cold light\n---\n\n# Glass Harbor\n\nA town of workshops.", hash: "l1" },
    { path: "items/the-ledger.md", content: "---\ntype: item\nname: The Ledger\nsignificance: It proves the lie\n---\n", hash: "i1" },
    { path: "secrets/the-wall.md", content: "---\ntype: secret\ntitle: The Wall Is Failing\nholders:\n  - character:orrin-hale\nclues:\n  - chapter: 1\n    note: Salt in the cellar\nlearned_by:\n  - character: character:mira-vale\n    chapter: 3\n---\n\n# The Wall Is Failing\n\nThe sea wall cracked years ago.", hash: "s1" },
    { path: "secrets/the-letter.md", content: "---\ntype: secret\ntitle: The Letter\n---\n\nNobody read it.", hash: "s2" },
    { path: "bible/themes.md", content: serializeBibleThemes({ themes: ["truth"], tone: "Tense" }), hash: "b1" },
    { path: "story-design.md", content: "---\ntype: note\n---\n\n# Story Design\n\nThree movements.", hash: "" },
  ];
  const entries = [
    { number: 1, path: "outline/chapters/001.md", title: "One", body: "", origin: "autopilot" as const, contentDigest: "", intact: true, frontmatter: {}, design: { goal: "g", pov: ["Mira"], events: ["e"], ending: "x", characters: ["Tobias"] } },
    { number: 2, path: "outline/chapters/002.md", title: "Two", body: "", origin: "autopilot" as const, contentDigest: "", intact: true, frontmatter: {}, design: { goal: "g", reveals: ["The Wall Is Failing"], pov: ["Mira"] } },
  ];
  const state = stateWith({ concept: { done: true, generated: true, secrets: [{ slug: "the-wall", title: "The Wall Is Failing", revealChapter: 2 }] } });

  it("reads the cast, the world, the secrets with their ledger and the reveal the plan gives them, and the findings of the checks", () => {
    const data = composeBible({ files, entries, state });
    expect(data.canon.characters.map((entry) => entry.name)).toEqual(["Mira Vale", "Orrin Hale"]);
    expect(data.canon.characters[0].facts).toEqual([{ key: "story_role", value: "protagonist" }, { key: "arc", value: "From silence to voice" }, { key: "desires", value: "The truth" }]);
    expect(data.canon.characters[0].summary).toBe("A stubborn young glassmaker.");
    expect(worldEntries(data)).toBe(2);
    expect(data.themes).toEqual({ themes: ["truth"], tone: "Tense", notes: "" });
    expect(data.storyDesign).toContain("Three movements.");
    expect(data.secrets.map((secret) => [secret.slug, secret.revealChapter, secret.planned])).toEqual([["the-wall", 2, true], ["the-letter", undefined, false]]);
    expect(data.secrets[0].ledger.clues).toEqual([{ chapter: 1, note: "Salt in the cellar" }]);
    const codes = data.findings.map((finding) => `${finding.code}:${finding.chapter ?? finding.secret?.slug}`);
    expect(codes).toEqual(expect.arrayContaining(["reveal-missing:the-letter", "knowledge-before-learning:2", "unknown-character:1", "design-incomplete:2"]));
  });
});

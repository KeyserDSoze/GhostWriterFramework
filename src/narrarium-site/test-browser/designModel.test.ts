import { describe, expect, it } from "vitest";
import { createAutopilotState, serializeBibleThemes, type AutopilotState } from "narrarium-engine";
import { designDraftOf, designOfDraft, designPatchOf, filledDesignFields, sameDesign } from "@/outline/designModel";
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

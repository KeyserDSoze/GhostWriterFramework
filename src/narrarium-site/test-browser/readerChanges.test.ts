import { describe, expect, it } from "vitest";
import { builtinReaderPersonas, emptyReaderPersona, mergeReaderPersonas, parseReaderPersona, serializeReaderPersona, type ReaderPersonaProfile } from "narrarium-engine";
import { planReaderChanges, readerFileContent, readerFilePath, readerPlanCounts, selectReaders, type ReaderDraft } from "@/assistant/pages/readerChanges";
import { checkNewReaders } from "@/assistant/pages/readers";
import { createEmptyAssistantSession } from "@/assistant/store";
import { parseAssistantSessionJson, serializeAssistantSession } from "@/assistant/sessionSchema";
import { isValidAssistantActionShape, isWholeProposal } from "@/assistant/actionValidation";

// The batch of the readers page: what it does to every reader, and the files it writes. Built-in readers are never deleted, only turned off.

function custom(name: string, patch: Partial<ReaderPersonaProfile> = {}): ReaderPersonaProfile {
  const slug = name.toLowerCase().replace(/\W+/g, "-");
  return parseReaderPersona(slug, serializeReaderPersona({ ...emptyReaderPersona("en"), id: `reader:custom:${slug}`, slug, name, description: `${name}.`, profile: `${name}'s profile.`, ...patch }));
}

function draft(name: string, aspects: string[]): ReaderDraft {
  return { name, description: `${name}, a reader.`, profile: `${name} reads with care.`, aspects, preferredGenres: ["historical-fiction"], dislikedGenres: [], experienceLevel: "expert", severity: 7, audienceAge: "adult", interests: [], appreciatedElements: [], frequentCriticisms: [], customPrompt: "" };
}

const readers = () => mergeReaderPersonas("en", [custom("Captain Ada", { enabled: true })]);

describe("a batch of changes to the readers", () => {
  it("creates new readers, turns the built-in ones off, and shows every reader with its state: what changes first", () => {
    const plan = planReaderChanges(readers(), { create: [draft("The Military Historian", ["battles"]), draft("The Court Chronicler", ["etiquette"])], disable: ["@builtin"] }, { language: "en" });
    expect(readerPlanCounts(plan.rows)).toEqual({ created: 2, edited: 0, "turned-on": 0, "turned-off": 8, removed: 0 });
    expect(plan.rows).toHaveLength(28 + 1 + 2);
    expect(plan.rows.slice(0, 2).map((row) => [row.name, row.change, row.before, row.after])).toEqual([["The Military Historian", "created", null, true], ["The Court Chronicler", "created", null, true]]);
    expect(plan.rows.slice(2, 10).every((row) => row.change === "turned-off" && row.builtin && row.before === true && row.after === false)).toBe(true);
    // The genre readers were off already, and the author's reader is not built in: they do not change.
    expect(plan.rows.find((row) => row.id === "reader:genre.fantasy")).toMatchObject({ change: "unchanged", before: false, after: false });
    expect(plan.rows.find((row) => row.name === "Captain Ada")).toMatchObject({ change: "unchanged", after: true });
    expect(plan.write.map((reader) => reader.id)).toEqual([...builtinReaderPersonas("en").filter((reader) => reader.enabled).map((reader) => reader.id), "reader:custom:the-military-historian", "reader:custom:the-court-chronicler"]);
    expect(plan.problems).toEqual([]);
  });

  it("never deletes a built-in reader: removing one turns it off, and says so; the author's readers are removed", () => {
    const plan = planReaderChanges(readers(), { remove: ["Critical Reader", "Captain Ada"] }, { language: "en" });
    expect(plan.rows.find((row) => row.id === "reader:standard.critical")).toMatchObject({ change: "turned-off", after: false, kept: true });
    expect(plan.rows.find((row) => row.name === "Captain Ada")).toMatchObject({ change: "removed", before: true, after: null });
    expect(plan.remove.map((reader) => reader.name)).toEqual(["Captain Ada"]);
    expect(plan.write.map((reader) => reader.id)).toEqual(["reader:standard.critical"]);
  });

  it("edits the fields of a reader or a group, and says which", () => {
    const plan = planReaderChanges(readers(), { update: [{ reader: "Critical Reader", set: { severity: 12, aspects: ["logic", "logic", " pacing "] } }, { reader: "@custom", set: { customPrompt: "Speak like a sailor." } }] }, { language: "en" });
    expect(plan.rows.find((row) => row.id === "reader:standard.critical")).toMatchObject({ change: "edited", fields: ["aspects", "severity"], before: true, after: true });
    expect(plan.write.find((reader) => reader.id === "reader:standard.critical")).toMatchObject({ severity: 10, aspects: ["logic", "pacing"], builtin: true });
    expect(plan.rows.find((row) => row.name === "Captain Ada")).toMatchObject({ change: "edited", fields: ["customPrompt"] });
  });

  it("lets a reader named one by one win over its group: all off but one", () => {
    const plan = planReaderChanges(readers(), { disable: ["@all"], enable: ["critical reader", "reader:genre.mystery"] }, { language: "en" });
    expect(plan.rows.filter((row) => row.after === true).map((row) => row.name).sort()).toEqual(["Critical Reader", "Mystery Reader"]);
    expect(plan.rows.find((row) => row.id === "reader:genre.mystery")).toMatchObject({ change: "turned-on" });
  });

  it("keeps the new readers out of the groups, and lets the batch turn one off by its name", () => {
    const plan = planReaderChanges(readers(), { create: [draft("The Archivist", ["dates"])], disable: ["@all", "The Archivist"] }, { language: "en" });
    expect(plan.rows.find((row) => row.name === "The Archivist")).toMatchObject({ change: "created", after: false });
    const kept = planReaderChanges(readers(), { create: [draft("The Archivist", ["dates"])], disable: ["@custom"] }, { language: "en" });
    expect(kept.rows.find((row) => row.name === "The Archivist")).toMatchObject({ after: true });
  });

  it("says what it could not do: a reader or a group that does not exist, a name that is taken, a rename onto another reader", () => {
    const plan = planReaderChanges(readers(), { create: [draft("Captain Ada", ["x"])], disable: ["Nobody", "@everyone"], update: [{ reader: "Captain Ada", set: { name: "Critical Reader" } }] }, { language: "en" });
    expect(plan.problems).toEqual([
      "A reader named «Captain Ada» already exists: it was not created again.",
      "«Captain Ada» cannot be renamed «Critical Reader»: another reader has that name.",
      "«@everyone» is not a group of readers (the groups are @all, @builtin, @default, @standard, @genre, @custom).",
      "No reader is called «Nobody».",
    ]);
    expect(plan.write).toEqual([]);
  });

  it("gives new readers names and files of their own", () => {
    const existing = [...readers(), custom("The Archivist")];
    const plan = planReaderChanges(existing, { create: [draft("The archivist ", ["dates"]), draft("Archivist!", ["maps"])] }, { language: "it" });
    expect(plan.problems).toEqual(["A reader named «The archivist» already exists: it was not created again."]);
    const created = plan.write.find((reader) => reader.name === "Archivist!")!;
    expect(created).toMatchObject({ slug: "archivist", readerType: "custom", builtin: false, language: "it", enabled: true });
    expect(readerFilePath(created)).toBe("personas/archivist.md");
  });

  it("finds a reader by id, slug or name, and a single one whose name contains the words", () => {
    expect(selectReaders("reader:standard.plot", readers())?.map((reader) => reader.name)).toEqual(["Plot Reader"]);
    expect(selectReaders("standard-plot", readers())?.map((reader) => reader.name)).toEqual(["Plot Reader"]);
    expect(selectReaders("historical", readers())?.map((reader) => reader.name)).toEqual(["Historical Fiction Reader"]);
    expect(selectReaders("reader", readers())).toBeNull();
    expect(selectReaders("@genre", readers())).toHaveLength(20);
  });
});

describe("the files of a batch", () => {
  it("writes a built-in reader's file with its own id, and keeps the keys of an existing file that only the file has", () => {
    const plan = planReaderChanges(readers(), { disable: ["General Reader"] }, { language: "en" });
    const general = plan.write[0];
    const created = readerFileContent(general, null);
    expect(created).toMatch(/^---\ntype: reader-persona\nid: reader:standard.general\n/);
    expect(created).toContain("enabled: false");
    expect(created).toContain("builtin: true");
    const kept = readerFileContent(general, "---\nid: reader:standard.general\nnote_of_the_author: keep me\nenabled: true\n---\n\nOld body.\n");
    expect(kept).toContain("note_of_the_author: keep me");
    expect(kept).toContain("enabled: false");
    expect(parseReaderPersona("standard-general", kept)).toMatchObject({ id: "reader:standard.general", enabled: false, builtin: true });
  });
});

describe("the new readers the model writes", () => {
  it("are as many as asked, with names the book does not have, and each a different kind of reader", () => {
    const fine = [draft("A", ["battles"]), draft("B", ["etiquette"])].map((reader, index) => ({ ...reader, profile: `Profile ${index}.` }));
    expect(checkNewReaders(fine, 2, ["Critical Reader"])).toEqual([]);
    expect(checkNewReaders(fine, 3, [])).toEqual(["2 readers instead of 3"]);
    expect(checkNewReaders([fine[0], { ...fine[1], name: "a" }], 2, [])).toContain("two readers have the same name");
    expect(checkNewReaders(fine, 2, ["b"])).toContain("«b» is the name of a reader the book has");
    expect(checkNewReaders([fine[0], { ...fine[1], aspects: ["Battles"] }], 2, [])).toContain("two readers look at the same aspects: each must be a different kind of reader");
  });
});

describe("a proposal for the readers in the chat", () => {
  it("is applied whole, may delete the file of a reader of the author, and keeps its review when the chat is saved and read again", () => {
    const action = {
      kind: "apply-file-updates" as const, bookId: "book-1", toolId: "edit-page", owner: "local", repo: "book-1", branch: "main", sourceRevision: "x", generatedAt: new Date().toISOString(),
      sourceRevisions: { "personas/standard-general.md": null, "personas/captain-ada.md": "sha" },
      updates: [{ path: "personas/standard-general.md", content: "---\nenabled: false\n---\n" }, { path: "personas/captain-ada.md", content: null }],
      review: { page: "readers", rows: [{ id: "reader:standard.general", name: "General Reader", kind: "standard", builtin: true, before: true, after: false, change: "turned-off" as const }, { id: "reader:custom:captain-ada", name: "Captain Ada", kind: "custom", builtin: false, before: true, after: null, change: "removed" as const }] },
    };
    expect(isWholeProposal(action)).toBe(true);
    expect(isValidAssistantActionShape(action)).toBe(true);
    const session = { ...createEmptyAssistantSession("Readers"), messages: [{ id: "m1", role: "assistant" as const, text: "Proposed.", action }] };
    const restored = parseAssistantSessionJson(serializeAssistantSession(session));
    expect(restored.messages[0].action).toMatchObject({ review: action.review, updates: [{ path: "personas/standard-general.md" }, { path: "personas/captain-ada.md", content: null }] });
    // A file of another kind is never deleted by a proposal.
    expect(isValidAssistantActionShape({ ...action, updates: [{ path: "characters/ada.md", content: null }], sourceRevisions: { "characters/ada.md": "sha" } })).toBe(false);
  });
});

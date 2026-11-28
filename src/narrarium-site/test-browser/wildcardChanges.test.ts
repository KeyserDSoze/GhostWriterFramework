import { describe, expect, it } from "vitest";
import { builtinWildcards, emptyWildcard, mergeWildcards, parseWildcard, serializeWildcard, type WildcardProfile } from "narrarium-engine";
import { planWildcardChanges, selectWildcards, wildcardFileContent, wildcardFilePath, type WildcardDraft } from "@/assistant/pages/wildcardChanges";
import { checkNewWildcards, wildcardsStateText } from "@/assistant/pages/wildcards";
import { isValidAssistantActionShape, isWholeProposal } from "@/assistant/actionValidation";
import { pageIdForPrompt, pageIdForRoute } from "@/assistant/pages/registry";
import { parseAppRoute } from "@/assistant/context";

// The batch of the Wildcards page: what it does to every wildcard of the book, and the files it writes. A built-in or account wildcard is changed in the book
// with a file of its own, and removing it turns it off there; only the book's own wildcards are deleted.

function bookFile(name: string, patch: Partial<WildcardProfile> = {}): WildcardProfile {
  const slug = name.toLowerCase().replace(/\W+/g, "-");
  const profile = { ...emptyWildcard("en"), id: `wildcard:custom:${slug}`, slug, name, mandate: `${name}'s mandate.`, body: `Think like ${name}.`, ...patch };
  return { ...parseWildcard(slug, serializeWildcard(profile), `wildcards/${slug}.md`) };
}
const accountOne = (): WildcardProfile => ({ ...emptyWildcard("en", "sentinel"), id: "wildcard:custom:lawyer", slug: "lawyer", name: "The Lawyer", domain: "maritime law" });
const room = () => mergeWildcards("en", { account: [accountOne()], book: [bookFile("The Hacker", { audacity: 8 })] });

const draft = (name: string, group: WildcardDraft["group"] = "provocateur"): WildcardDraft => ({ name, group, mandate: `${name} finds the exploit.`, temperament: "Laconic.", audacity: 8, canonRespect: "subversive", outputFormat: "ideas", domain: "computer security", prompt: `Think like ${name}.` });

describe("a batch of changes to the wildcards", () => {
  it("creates new wildcards and shows every wildcard with its state, what changes first", () => {
    const plan = planWildcardChanges(room(), { create: [draft("The Phreaker")] }, { language: "en" });
    expect(plan.rows).toHaveLength(14 + 2 + 1);
    expect(plan.rows[0]).toMatchObject({ name: "The Phreaker", change: "created", before: null, after: true, kind: "provocateur" });
    expect(plan.write).toHaveLength(1);
    expect(plan.write[0]).toMatchObject({ id: "wildcard:custom:the-phreaker", slug: "the-phreaker", group: "provocateur", audacity: 8, canonRespect: "subversive", domain: "computer security", body: "Think like The Phreaker.", secrets: "threshold", builtin: false });
    expect(wildcardFilePath(plan.write[0])).toBe("wildcards/the-phreaker.md");
    expect(plan.problems).toEqual([]);
  });

  it("never deletes a built-in or an account wildcard: removing one turns it off in the book; the book's own is removed", () => {
    const plan = planWildcardChanges(room(), { remove: ["The Poet", "The Lawyer", "The Hacker"] }, { language: "en" });
    expect(plan.rows.find((row) => row.id === "wildcard:poet")).toMatchObject({ change: "turned-off", kept: true, builtin: true });
    expect(plan.rows.find((row) => row.id === "wildcard:custom:lawyer")).toMatchObject({ change: "turned-off", kept: true });
    expect(plan.rows.find((row) => row.name === "The Hacker")).toMatchObject({ change: "removed", after: null });
    expect(plan.remove.map((profile) => profile.name)).toEqual(["The Hacker"]);
    expect(plan.write.map(wildcardFilePath).sort()).toEqual(["wildcards/lawyer.md", "wildcards/poet.md"]);
    // The account's wildcard gets a file of its own in the book, with its id: it is changed for this book only.
    expect(parseWildcard("lawyer", wildcardFileContent(plan.write.find((profile) => profile.slug === "lawyer")!, null)).id).toBe("wildcard:custom:lawyer");
  });

  it("edits a wildcard or a group, keeps the choices to the known values, and never lets a provocateur know the secrets as the author", () => {
    const sentinel = mergeWildcards("en", { book: [bookFile("The Watcher", { group: "sentinel", secrets: "author", outputFormat: "findings" })] });
    const plan = planWildcardChanges(sentinel, { update: [{ wildcard: "The Watcher", set: { group: "provocateur", audacity: 14 } }, { wildcard: "@sentinels", set: { canonRespect: "nonsense" as never } }] }, { language: "en" });
    const watcher = plan.write.find((profile) => profile.name === "The Watcher")!;
    expect(watcher).toMatchObject({ group: "provocateur", audacity: 10, secrets: "threshold" });
    expect(plan.rows.find((row) => row.name === "The Watcher")).toMatchObject({ change: "edited", fields: ["group", "audacity"] });
  });

  it("names wildcards by name, id, slug or group, and says what it could not find", () => {
    const wildcards = room();
    expect(selectWildcards("@sentinels", wildcards)?.map((profile) => profile.slug)).toEqual(["ledger-keeper", "continuity-keeper", "secrets-guardian", "domain-expert", "moral-stress-test", "lawyer"]);
    expect(selectWildcards("poet", wildcards)?.[0].id).toBe("wildcard:poet");
    expect(selectWildcards("hacker", wildcards)?.[0].name).toBe("The Hacker");
    const plan = planWildcardChanges(wildcards, { disable: ["@all"], enable: ["The Poet", "Nobody"] }, { language: "en" });
    expect(plan.rows.filter((row) => row.after === true).map((row) => row.name)).toEqual(["The Poet"]);
    expect(plan.problems).toEqual(["No wildcard is called «Nobody»."]);
    expect(planWildcardChanges(wildcards, { create: [draft("The Poet")] }, { language: "en" }).problems[0]).toMatch(/already exists/);
  });

  it("writes a file that keeps the keys it does not know, and is a proposal applied whole that may delete the book's files", () => {
    const existing = "---\ntype: wildcard\nid: wildcard:poet\nname: The Poet\ngroup: provocateur\nmood: nocturnal\n---\n\nOld prompt.\n";
    const poet = { ...builtinWildcards("en").find((profile) => profile.slug === "poet")!, enabled: false };
    expect(wildcardFileContent(poet, existing)).toMatch(/mood: nocturnal/);
    const action = { kind: "apply-file-updates" as const, bookId: "b", toolId: "edit-page", owner: "o", repo: "r", branch: "main", sourceRevision: "x", sourceRevisions: { "wildcards/poet.md": null, "wildcards/hacker.md": "sha" }, generatedAt: "2026-11-28T00:00:00.000Z", updates: [{ path: "wildcards/poet.md", content: "---\n---\n" }, { path: "wildcards/hacker.md", content: null }] };
    expect(isWholeProposal(action as never)).toBe(true);
    expect(isValidAssistantActionShape(action as never)).toBe(true);
  });

  it("checks that new wildcards are as many as asked and named apart", () => {
    expect(checkNewWildcards([draft("A"), draft("A")], 3, ["The Poet"])).toEqual(["2 wildcards instead of 3", "two wildcards have the same name"]);
    expect(checkNewWildcards([draft("The Poet")], 1, ["The Poet"])).toEqual(["«the poet» is the name of a wildcard the book has"]);
  });
});

describe("the page with the Copilot", () => {
  it("is the page of its route, and a request that names provocateurs or sentinels is about it", () => {
    expect(pageIdForRoute(parseAppRoute("/app/books/book-1/wildcards"))).toBe("wildcards");
    expect(pageIdForPrompt("create a provocateur who thinks like a hacker")).toBe("wildcards");
    expect(pageIdForPrompt("crea un provocatore che pensa come un hacker")).toBe("wildcards");
    expect(pageIdForPrompt("spegni le sentinelle")).toBe("wildcards");
    expect(pageIdForPrompt("turn off all the readers")).toBe("readers");
  });

  it("tells the model every wildcard on one line, with its group, origin and what it gives", () => {
    const text = wildcardsStateText(room(), { scope: "book", selected: "The Poet (wildcard:poet)" });
    expect(text).toMatch(/^Wildcards: 16 \(10 provocateurs, 6 sentinels; 2 custom\); 16 on\./);
    expect(text).toContain("- on · The Hacker · wildcard:custom:the-hacker · provocateur · custom (wildcards/the-hacker.md) · audacity 8/10");
    expect(text).toContain("The Lawyer · wildcard:custom:lawyer · sentinel · custom (account)");
    expect(text).toContain("selected: The Poet (wildcard:poet)");
  });
});

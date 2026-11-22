import { describe, expect, it } from "vitest";
import { chapterTargetInstruction, chapterTargetMode, resolveChapterReference } from "@/assistant/outlineTarget";
import { parseOutlineCommand } from "@/assistant/outlineProposal";
import { isOutlineProposal, isValidAssistantActionShape } from "@/assistant/actionValidation";
import type { AssistantAction } from "@/assistant/store";

const route = (kind: string) => ({ kind, bookId: "book" });

describe("which «chapter» the author means", () => {
  it.each([
    ["book-outline", "outline"],
    ["book-autopilot", "outline"],
    // The Configuration page of the autopilot: it is an autopilot page too.
    ["book-autopilot-settings", "outline"],
    ["book", "chapter"],
    ["book-dashboard", "chapter"],
    ["chapter", "chapter"],
    ["paragraph", "chapter"],
    ["reader", "chapter"],
    ["book-director", "chapter"],
    ["app-home", "none"],
    ["app-page", "none"],
  ])("on a %s page it is the %s", (kind, mode) => {
    expect(chapterTargetMode(kind.startsWith("app") ? { kind } : route(kind))).toBe(mode);
  });

  it("is the entry of the outline on the Outline and autopilot pages, the chapter of the book elsewhere, the outline anywhere it is named", () => {
    const addition = "nel capitolo 3 aggiungi che Mira perde la chiave";
    expect(resolveChapterReference(addition, route("book-outline"))).toEqual({ target: "outline", reason: "page" });
    expect(resolveChapterReference(addition, route("book-autopilot"))).toEqual({ target: "outline", reason: "page" });
    expect(resolveChapterReference(addition, route("book-autopilot-settings"))).toEqual({ target: "outline", reason: "page" });
    expect(resolveChapterReference(addition, route("chapter"))).toEqual({ target: "chapter", reason: "page" });
    expect(resolveChapterReference("nella scaletta sposta il capitolo 5 dopo il 7", route("chapter"))).toEqual({ target: "outline", reason: "named" });
    expect(resolveChapterReference("in the outline, move chapter 5 after 7", route("paragraph"))).toEqual({ target: "outline", reason: "named" });
    expect(resolveChapterReference("add that Mira loses the key to that chapter", route("book-outline"))).toEqual({ target: "outline", reason: "page" });
  });

  it("asks which one when the request on an outline page speaks of scenes or prose, and follows the written chapter when it is named", () => {
    expect(resolveChapterReference("riscrivi la scena 2 del capitolo 3", route("book-outline"))).toEqual({ target: "ask", reason: "both" });
    expect(resolveChapterReference("rewrite the prose of chapter 3", route("book-autopilot"))).toEqual({ target: "ask", reason: "both" });
    expect(resolveChapterReference("nel testo del capitolo 3 riscrivi la scena 2", route("book-outline"))).toEqual({ target: "chapter", reason: "named" });
    expect(resolveChapterReference("in the written chapter 3, fix the dialogue", route("book-outline"))).toEqual({ target: "chapter", reason: "named" });
  });

  it("has nothing to say of a request about no chapter, or on a page without a book", () => {
    expect(resolveChapterReference("what is the tone of the book?", route("book-outline"))).toBeNull();
    expect(resolveChapterReference("open chapter 3", { kind: "app-home" })).toBeNull();
  });

  it("is written in the instructions of the Copilot for the page", () => {
    const outline = chapterTargetInstruction(route("book-outline"));
    for (const part of ["outline/chapters/", "«scaletta»", "ask"]) expect(outline).toContain(part);
    expect(chapterTargetInstruction(route("chapter"))).toContain("chapter of the book");
    expect(chapterTargetInstruction({ kind: "app-home" })).toBe("");
  });
});

describe("a request that moves or deletes an entry", () => {
  const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  it.each([
    ["nella scaletta sposta il capitolo 5 dopo il 7", { kind: "move", from: 5, to: 7 }],
    ["sposta il capitolo 2 prima del 6", { kind: "move", from: 2, to: 5 }],
    ["sposta il capitolo 9 dopo il 3", { kind: "move", from: 9, to: 4 }],
    ["move chapter 9 before chapter 3", { kind: "move", from: 9, to: 3 }],
    ["in the outline move chapter 4 to position 1", { kind: "move", from: 4, to: 1 }],
    ["elimina il capitolo 4 dalla scaletta", { kind: "remove", number: 4, renumber: false }],
    ["remove chapter 6 from the outline and renumber the following ones", { kind: "remove", number: 6, renumber: true }],
  ])("«%s» is understood without a model", (prompt, edit) => {
    expect(parseOutlineCommand(prompt, numbers)).toEqual(edit);
  });

  it("is left to the model when it is not that simple, or names a chapter the outline does not have", () => {
    expect(parseOutlineCommand("nel capitolo 3 aggiungi che Mira perde la chiave", numbers)).toBeNull();
    expect(parseOutlineCommand("sposta il capitolo 12 dopo il 7", numbers)).toBeNull();
    expect(parseOutlineCommand("sposta il capitolo 5 dopo il 5", numbers)).toBeNull();
  });
});

describe("a proposal of the Copilot for the outline", () => {
  const provenance = { toolId: "edit-outline", owner: "o", repo: "r", branch: "main", sourceRevision: "x", generatedAt: "2026-11-21T00:00:00.000Z" };
  const proposal = (updates: Array<{ path: string; content: string | null }>): AssistantAction => ({ kind: "apply-file-updates", bookId: "book", updates, sourceRevisions: Object.fromEntries(updates.map((update) => [update.path, "hash"])), ...provenance }) as AssistantAction;

  it("may delete entries of the outline and move many of them at once", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ path: `outline/chapters/${String(index + 1).padStart(3, "0")}.md`, content: index === 59 ? null : "---\n---\n" }));
    expect(isValidAssistantActionShape(proposal(many))).toBe(true);
    expect(isOutlineProposal(proposal(many))).toBe(true);
    expect(isValidAssistantActionShape(proposal([{ path: "outline/book.md", content: "---\n---\nGlass" }]))).toBe(true);
  });

  it("never deletes or touches many files outside the outline", () => {
    expect(isValidAssistantActionShape(proposal([{ path: "chapters/001-x/chapter.md", content: null }]))).toBe(false);
    expect(isValidAssistantActionShape(proposal([{ path: "outline/chapters/001.md", content: null }, { path: "notes.md", content: "x" }]))).toBe(false);
    expect(isValidAssistantActionShape(proposal(Array.from({ length: 9 }, (_, index) => ({ path: `notes/${index}.md`, content: "x" }))))).toBe(false);
    expect(isValidAssistantActionShape(proposal(Array.from({ length: 101 }, (_, index) => ({ path: `outline/chapters/${String(index + 1).padStart(3, "0")}.md`, content: "x" }))))).toBe(false);
    expect(isValidAssistantActionShape(proposal([{ path: "outline/notes.md", content: "x" }, ...Array.from({ length: 8 }, (_, index) => ({ path: `outline/chapters/00${index + 1}.md`, content: "x" }))]))).toBe(false);
    expect(isOutlineProposal(proposal([{ path: "notes.md", content: "x" }]))).toBe(false);
  });
});

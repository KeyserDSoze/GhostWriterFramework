import { describe, expect, it } from "vitest";
import { readerPaginationDirection } from "@/pages/ReaderPreviewPage";

function keyEvent(key: string, target: EventTarget, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key, target, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers } as KeyboardEvent;
}

describe("fullscreen reader keyboard pagination", () => {
  it("maps unmodified horizontal arrows to page directions", () => {
    const article = document.createElement("article");
    expect(readerPaginationDirection(keyEvent("ArrowLeft", article))).toBe(-1);
    expect(readerPaginationDirection(keyEvent("ArrowRight", article))).toBe(1);
    expect(readerPaginationDirection(keyEvent("Escape", article))).toBe(0);
  });

  it("does not steal arrows from editable controls or modified shortcuts", () => {
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(readerPaginationDirection(keyEvent("ArrowRight", input))).toBe(0);
    expect(readerPaginationDirection(keyEvent("ArrowLeft", editable))).toBe(0);
    expect(readerPaginationDirection(keyEvent("ArrowRight", document.body, { ctrlKey: true }))).toBe(0);
  });
});

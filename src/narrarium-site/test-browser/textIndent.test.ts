import { describe, expect, it } from "vitest";
import { handleTextIndent } from "@/editor/textIndent";

function event(value: string, start: number, end: number, shiftKey = false): { target: HTMLTextAreaElement; currentTarget: HTMLTextAreaElement; key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; preventDefault: () => void } {
  const target = document.createElement("textarea");
  target.value = value;
  target.setSelectionRange(start, end);
  return { target, currentTarget: target, key: "Tab", ctrlKey: false, metaKey: false, altKey: false, shiftKey, preventDefault: () => undefined };
}

describe("text indentation", () => {
  it("indents the current line and preserves a caret", () => {
    const input = event("one\ntwo", 5, 5);
    handleTextIndent(input as never);
    expect(input.target.value).toBe("one\n  two");
    expect(input.target.selectionStart).toBe(7);
  });

  it("outdents every selected line", () => {
    const input = event("  one\n  two", 0, 11, true);
    handleTextIndent(input as never);
    expect(input.target.value).toBe("one\ntwo");
  });

  it("does not intercept Ctrl or Cmd Tab", () => {
    const input = event("one", 1, 1);
    input.ctrlKey = true;
    handleTextIndent(input as never);
    expect(input.target.value).toBe("one");
  });
});

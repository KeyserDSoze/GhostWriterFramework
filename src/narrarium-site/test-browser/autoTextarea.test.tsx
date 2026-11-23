import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoTextarea } from "@/components/ui/auto-textarea";

afterEach(cleanup);

function area(props: Partial<React.ComponentProps<typeof AutoTextarea>> = {}): HTMLTextAreaElement {
  render(<AutoTextarea aria-label="Text" defaultValue="one" {...props} />);
  const field = screen.getByLabelText("Text") as HTMLTextAreaElement;
  field.setSelectionRange(0, 0);
  return field;
}

describe("the Tab key in the auto-growing text area", () => {
  it("indents the line, as in an editor, unless told otherwise", () => {
    const field = area();
    // `fireEvent` answers false when the page cancelled the key.
    expect(fireEvent.keyDown(field, { key: "Tab" })).toBe(false);
    expect(field.value).toBe("  one");
  });

  it("moves on to the next control, with or without Shift, when it is a field of a form and not an editor (a keyboard has no other way out)", () => {
    const field = area({ tabIndent: false });
    expect(fireEvent.keyDown(field, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(field, { key: "Tab", shiftKey: true })).toBe(true);
    expect(field.value).toBe("one");
  });

  it("still tells the page's own handler about every key", () => {
    const onKeyDown = vi.fn();
    const field = area({ tabIndent: false, onKeyDown });
    fireEvent.keyDown(field, { key: "Tab" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });
});

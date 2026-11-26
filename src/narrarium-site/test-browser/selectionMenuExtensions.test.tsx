import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { GlobalContextMenu } from "@/components/editor/GlobalContextMenu";
import { selectionMenuRegistry, type SelectionMenuExtension } from "@/components/editor/selectionMenuStore";

// The menu of a selection takes items from the page the selection is in (the reader adds «Annotate»): what the page captured when the menu opened, at
// the top, only in its own region; the page can open the menu from a button of its own.

function select(node: Node, quote: string) {
  const start = (node.textContent ?? "").indexOf(quote);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + quote.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function page() {
  render(
    <MemoryRouter>
      <article data-testid="reader"><p data-testid="prose">The gate stood open beneath a sky the color of old steel.</p></article>
      <p data-testid="elsewhere">A note outside the reader.</p>
      <GlobalContextMenu />
    </MemoryRouter>,
  );
}

function extension(onPick = vi.fn()): SelectionMenuExtension & { captured: unknown[] } {
  const captured: unknown[] = [];
  return {
    id: "reader-test",
    captured,
    capture: (target, selection) => {
      const inside = target instanceof Element && target.closest("[data-testid=reader]");
      if (!inside) return null;
      const context = { quote: selection?.toString() ?? "" };
      captured.push(context);
      return context;
    },
    render: ({ context, close }) => <button type="button" onClick={() => { onPick(context); close(); }}>Annotate «{(context as { quote: string }).quote}»</button>,
  };
}

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false })) as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  selectionMenuRegistry.setState({ extensions: [] });
});

describe("the items a page adds to the menu of a selection", () => {
  it("come first, with the selection as it was when the menu opened, and only in the page's own region", async () => {
    await i18n.changeLanguage("en");
    const onPick = vi.fn();
    const added = extension(onPick);
    const unregister = selectionMenuRegistry.getState().register(added);
    page();
    const prose = screen.getByTestId("prose");
    select(prose.firstChild!, "the color of old steel");

    fireEvent.contextMenu(prose, { clientX: 40, clientY: 40 });
    const item = screen.getByRole("button", { name: "Annotate «the color of old steel»" });
    const menu = item.closest("[data-no-context-menu]")!;
    expect(menu.querySelector("button")).toBe(item);
    expect(screen.getByRole("button", { name: i18n.t("ctx.copy") as string })).toBeInTheDocument();
    // The selection is gone (the focus moved into the menu): the item still has what was captured.
    window.getSelection()!.removeAllRanges();
    fireEvent.click(item);
    expect(onPick).toHaveBeenCalledWith({ quote: "the color of old steel" });
    expect(screen.queryByRole("button", { name: /^Annotate/ })).toBeNull();

    // Outside its region the page adds nothing.
    const elsewhere = screen.getByTestId("elsewhere");
    select(elsewhere.firstChild!, "A note");
    fireEvent.contextMenu(elsewhere, { clientX: 40, clientY: 40 });
    expect(screen.queryByRole("button", { name: /^Annotate/ })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });

    // A page that is gone adds nothing either.
    unregister();
    select(prose.firstChild!, "the color of old steel");
    fireEvent.contextMenu(prose, { clientX: 40, clientY: 40 });
    expect(screen.queryByRole("button", { name: /^Annotate/ })).toBeNull();
  });

  it("can be opened by the page from a button of its own, and a second registration of the same page replaces the first", () => {
    const first = extension();
    const second = { ...extension(), render: () => <button type="button">Second</button> };
    selectionMenuRegistry.getState().register(first);
    selectionMenuRegistry.getState().register(second);
    expect(selectionMenuRegistry.getState().extensions).toEqual([second]);
    page();
    const prose = screen.getByTestId("prose");
    select(prose.firstChild!, "The gate");
    let opened = false;
    act(() => { opened = selectionMenuRegistry.getState().openMenu!(20, 20, prose); });
    expect(opened).toBe(true);
    expect(screen.getByRole("button", { name: "Second" })).toBeInTheDocument();
  });
});

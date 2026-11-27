import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import PageChangesReview from "@/components/assistant/PageChangesReview";
import type { AssistantAction, PageChangesReview as Review } from "@/assistant/store";

// The review of the readers' batch before it is applied: a real table of every reader with its state now and after, and what changes; Apply, Discard and, once
// applied, Undo; the outcome said where the review is, with the focus on it. In English and in Italian.

type Action = Extract<AssistantAction, { kind: "apply-file-updates" | "undo-file-updates" }> & { review: Review };

const review: Review = {
  page: "readers",
  rows: [
    { id: "reader:custom:the-military-historian", name: "The Military Historian", kind: "custom", builtin: false, before: null, after: true, change: "created" },
    { id: "reader:custom:the-court-chronicler", name: "The Court Chronicler", kind: "custom", builtin: false, before: null, after: true, change: "created" },
    { id: "reader:standard.critical", name: "Critical Reader", kind: "standard", builtin: true, before: true, after: false, change: "turned-off", kept: true },
    { id: "reader:standard.plot", name: "Plot Reader", kind: "standard", builtin: true, before: true, after: true, change: "edited", fields: ["severity", "aspects"] },
    { id: "reader:custom:captain-ada", name: "Captain Ada", kind: "custom", builtin: false, before: true, after: null, change: "removed" },
    { id: "reader:genre.fantasy", name: "Fantasy Reader", kind: "genre", builtin: true, before: false, after: false, change: "unchanged" },
  ],
};

function action(kind: Action["kind"] = "apply-file-updates"): Action {
  return { kind, bookId: "book-1", updates: [{ path: "personas/x.md", content: "x" }], review };
}

const handlers = { onApply: vi.fn(), onDiscard: vi.fn(), onUndo: vi.fn() };

beforeEach(async () => {
  Object.values(handlers).forEach((handler) => handler.mockReset());
  await i18n.changeLanguage("en");
});

afterEach(() => cleanup());

describe("the review of a proposal for a page", () => {
  it("is a table of every reader, with a caption, column headers and the reader as the header of its row, what changes first", () => {
    render(<PageChangesReview action={action()} busy={false} enabled {...handlers} />);
    expect(screen.getByRole("heading", { name: "Proposed changes to the simulated readers" })).toBeInTheDocument();
    expect(screen.getByText(/2 created · 1 edited · 1 turned off · 1 removed · after it: 3 on of 5/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Proposed changes to the simulated readers: every item with its state after the change (5 changing, 6 in all)" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Reader", "On / off", "Change"]);
    expect(within(table).getAllByRole("rowheader").map((header) => header.textContent)).toEqual([
      "The Military HistorianCustom", "The Court ChroniclerCustom", "Critical ReaderStandard · built-in", "Plot ReaderStandard · built-in", "Captain AdaCustom", "Fantasy ReaderGenre · built-in",
    ]);
    const row = (name: string) => within(table).getByRole("rowheader", { name: new RegExp(`^${name}`) }).closest("tr")!;
    expect(row("Critical Reader")).toHaveTextContent("On → becomes Off");
    expect(row("Critical Reader")).toHaveTextContent("Turned offBuilt-in: turned off, never deleted");
    expect(row("Plot Reader")).toHaveTextContent("Edited: severity, aspects");
    expect(row("The Military Historian")).toHaveTextContent("None → becomes On");
    expect(row("Captain Ada")).toHaveTextContent("On → becomes None");
    expect(row("Fantasy Reader")).toHaveTextContent("OffNo change");
    // The table scrolls in a region that the keyboard reaches, named by the caption.
    const region = screen.getByRole("region", { name: /every item with its state after the change/ });
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("applies, discards and undoes with its buttons, and says the outcome where it is, with the focus on it", () => {
    const { rerender } = render(<PageChangesReview action={action()} busy={false} enabled {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(handlers.onApply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(handlers.onDiscard).toHaveBeenCalledTimes(1);
    rerender(<PageChangesReview action={action("undo-file-updates")} busy={false} enabled {...handlers} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Applied: 2 created · 1 edited · 1 turned off · 1 removed.");
    expect(status).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
    rerender(<PageChangesReview action={action()} busy={false} enabled {...handlers} />);
    expect(screen.getByRole("status")).toHaveTextContent("Undone: everything is as it was before.");
    expect(screen.getByRole("status")).toHaveFocus();
  });

  it("cannot be applied while the Copilot works, or once its tool is off; Discard stays", () => {
    const { rerender } = render(<PageChangesReview action={action()} busy enabled {...handlers} />);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    rerender(<PageChangesReview action={action()} busy={false} enabled={false} {...handlers} />);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
  });

  it("speaks Italian", async () => {
    await i18n.changeLanguage("it");
    render(<PageChangesReview action={action()} busy={false} enabled {...handlers} />);
    expect(screen.getByRole("heading", { name: "Modifiche proposte ai lettori simulati" })).toBeInTheDocument();
    expect(screen.getByText(/2 creati · 1 modificato · 1 spento · 1 rimosso · dopo: 3 accesi su 5/)).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Lettore", "Acceso / spento", "Modifica"]);
    expect(screen.getByRole("rowheader", { name: /^Critical Reader/ }).closest("tr")).toHaveTextContent("Acceso → diventa Spento");
    expect(screen.getByRole("rowheader", { name: /^Critical Reader/ }).closest("tr")).toHaveTextContent("Predefinito: spento, mai cancellato");
    expect(screen.getByRole("button", { name: "Applica" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scarta" })).toBeInTheDocument();
  });
});

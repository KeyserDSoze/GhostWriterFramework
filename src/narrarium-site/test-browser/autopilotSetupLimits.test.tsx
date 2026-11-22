import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_BRIEF, DEFAULT_OPTIONS, normalizeBrief, normalizeOptions, type AutopilotState } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { SetupCard } from "@/components/autopilot/config/SetupCard";
import type { BookEntry } from "@/types/settings";

const t = (key: string) => i18n.t(key) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };

const runtime = { start: vi.fn(async () => undefined), configure: vi.fn(async () => undefined) };
const run = vi.fn(async (_name: string, action: (runtime: unknown, bookId: string) => Promise<unknown>) => {
  await action(runtime, BOOK.id);
  return true;
});

function openForm(state: AutopilotState | null = null) {
  render(<MemoryRouter><SetupCard book={BOOK} state={state} existingChapters={0} running={false} busy={false} disabled={false} run={run as never} /></MemoryRouter>);
}

const chaptersField = () => screen.getByLabelText(t("autopilot.setup.chapters")) as HTMLInputElement;
const perRunField = () => screen.getByLabelText(t("autopilot.setup.chaptersPerRun")) as HTMLInputElement;

/** What a person does: the field gets every keystroke, then loses the focus. */
function type(field: HTMLInputElement, text: string) {
  for (let length = 1; length <= text.length; length += 1) fireEvent.change(field, { target: { value: text.slice(0, length) } });
  fireEvent.blur(field);
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  runtime.start.mockClear();
  runtime.configure.mockClear();
});

afterEach(cleanup);

describe("the size of the book in the setup form", () => {
  it("takes 1500 chapters typed digit by digit, keeps them after the field loses focus and starts with them", async () => {
    openForm();
    type(chaptersField(), "1500");
    expect(chaptersField().value).toBe("1500");

    fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
    await waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1));
    expect(runtime.start).toHaveBeenCalledWith(BOOK.id, expect.objectContaining({ brief: expect.objectContaining({ targetChapters: 1500 }) }));
  });

  it("takes thousands of chapters per session (0 still means no limit)", async () => {
    openForm();
    type(perRunField(), "5000");
    expect(perRunField().value).toBe("5000");
    type(chaptersField(), "12000");

    fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
    await waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1));
    expect(runtime.start).toHaveBeenCalledWith(BOOK.id, {
      brief: expect.objectContaining({ targetChapters: 12000 }),
      options: expect.objectContaining({ chaptersPerRun: 5000 }),
    });

    type(perRunField(), "0");
    expect(perRunField().value).toBe("0");
  });

  it("is kept as typed by the engine, up to the limit of the form", async () => {
    openForm();
    type(chaptersField(), "1500");
    type(perRunField(), "5000");
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.actions.start") }));
    await waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1));

    const [, started] = runtime.start.mock.calls[0] as unknown as [string, { brief: Parameters<typeof normalizeBrief>[0]; options: Parameters<typeof normalizeOptions>[0] }];
    expect(normalizeBrief(started.brief).targetChapters).toBe(1500);
    expect(normalizeOptions(started.options).chaptersPerRun).toBe(5000);
    expect(normalizeBrief({ targetChapters: 100_000 }).targetChapters).toBe(100_000);
    expect(normalizeOptions({ chaptersPerRun: 100_000 }).chaptersPerRun).toBe(100_000);
  });

  it("keeps the limit as a typo guard, not as a product limit", () => {
    openForm();
    expect(chaptersField()).toHaveAttribute("max", "100000");
    expect(perRunField()).toHaveAttribute("max", "100000");

    type(chaptersField(), "250000");
    expect(chaptersField().value).toBe("100000");
    type(chaptersField(), "0");
    expect(chaptersField().value).toBe("1");
    type(perRunField(), "999999");
    expect(perRunField().value).toBe("100000");
  });

  it("puts the previous value back when the field is left empty", () => {
    openForm();
    type(chaptersField(), "1500");
    fireEvent.change(chaptersField(), { target: { value: "" } });
    expect(chaptersField().value).toBe("");
    fireEvent.blur(chaptersField());
    expect(chaptersField().value).toBe("1500");
  });

  it("saves the same numbers when the autopilot already exists", async () => {
    openForm({ brief: { ...DEFAULT_BRIEF, idea: "A glass harbor" }, options: { ...DEFAULT_OPTIONS } } as AutopilotState);
    type(chaptersField(), "1500");
    type(perRunField(), "300");

    fireEvent.click(screen.getByRole("button", { name: t("autopilot.setup.save") }));
    await waitFor(() => expect(runtime.configure).toHaveBeenCalledTimes(1));
    expect(runtime.configure).toHaveBeenCalledWith(BOOK.id, {
      brief: expect.objectContaining({ targetChapters: 1500 }),
      options: expect.objectContaining({ chaptersPerRun: 300 }),
    });
  });
});

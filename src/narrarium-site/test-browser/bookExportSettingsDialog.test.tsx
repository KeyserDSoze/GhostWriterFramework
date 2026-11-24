import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ save: vi.fn(async () => true) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: env.save, syncStatus: "idle" }) }));

import i18n from "@/i18n";
import { BookExportSettingsDialog } from "@/components/book/BookExportSettingsDialog";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const BOOK: BookEntry = { id: "b1", owner: "ada", repo: "glass-harbor", name: "Glass Harbor", tokenIndex: null, addedAt: "2026-11-01T00:00:00.000Z" };
const bookNow = () => useSettingsStore.getState().settings.books[0];

beforeEach(async () => {
  env.save.mockClear();
  await i18n.changeLanguage("en");
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK] } });
});
afterEach(() => { cleanup(); useSettingsStore.setState({ settings: DEFAULT_SETTINGS }); });

describe("the export settings dialog of the export page, which shares its fields with the Export tab", () => {
  it("edits the presets and saves them, then closes", async () => {
    const onOpenChange = vi.fn();
    render(<BookExportSettingsDialog bookId="b1" open onOpenChange={onOpenChange} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Font size"), { target: { value: "13" } });
    fireEvent.change(within(dialog).getByLabelText("New preset (e.g. Generic publisher)"), { target: { value: "Ebook" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add preset" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(env.save).toHaveBeenCalledTimes(1));
    expect(bookNow().exportProfiles?.map((profile) => profile.name)).toEqual(["Default", "Ebook"]);
    expect(bookNow().exportSettings).toMatchObject({ fontSize: 13 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("changes nothing when it is cancelled, and starts again from the book when it is opened again", async () => {
    const { rerender } = render(<BookExportSettingsDialog bookId="b1" open onOpenChange={() => undefined} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Font size"), { target: { value: "17" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(bookNow().exportSettings).toBeUndefined();
    rerender(<BookExportSettingsDialog bookId="b1" open={false} onOpenChange={() => undefined} />);
    rerender(<BookExportSettingsDialog bookId="b1" open onOpenChange={() => undefined} />);
    expect((within(await screen.findByRole("dialog")).getByLabelText("Font size") as HTMLInputElement).value).toBe("12");
  });
});

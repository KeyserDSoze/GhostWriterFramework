import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => undefined), syncStatus: "idle" }) }));

import i18n from "@/i18n";
import { BookSettingsPage } from "@/pages/BookSettingsPage";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

// The card that connects a local book to GitHub speaks the language of the app from its catalogue, its fields named in it (they were in
// English only), whatever language the settings of the book say.

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T10:00:00.000Z" };

function page() {
  return render(
    <MemoryRouter initialEntries={["/app/books/book-1/settings"]}>
      <Routes><Route path="/app/books/:bookId/settings" element={<BookSettingsPage />} /></Routes>
    </MemoryRouter>,
  );
}

afterEach(async () => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the card that connects a local book to GitHub", () => {
  it.each([
    ["en", "Connect this book to GitHub", "Owner", "Repository", "Overwrite existing repository", "Create or connect private repository"],
    ["it", "Collega il libro a GitHub", "Proprietario", "Repository", "Sovrascrivi repository esistente", "Crea o collega repository privata"],
  ])("speaks %s", async (language, title, owner, repository, overwrite, submit) => {
    await i18n.changeLanguage(language);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], ui: { ...DEFAULT_SETTINGS.ui, language: language === "it" ? "en" : "it" } } });
    useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
    page();
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByLabelText(owner)).toBeInTheDocument();
    expect(screen.getByLabelText(repository)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: overwrite })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: submit })).toBeInTheDocument();
  });
});

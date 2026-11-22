import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import i18n from "@/i18n";
import { Sidebar } from "@/components/layout/Sidebar";
import { parseAppRoute } from "@/assistant/context";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";

const BOOK = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only" as const, addedAt: "2026-11-21T00:00:00.000Z" };

afterEach(async () => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the Outline in the menu of a book", () => {
  it.each<["en" | "it", string]>([["en", "Outline"], ["it", "Scaletta"]])("is right after the dashboard, in %s", async (language, label) => {
    await i18n.changeLanguage(language);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], ui: { ...DEFAULT_SETTINGS.ui, language } } });
    render(<MemoryRouter initialEntries={["/app/books/book-1/outline"]}><Sidebar /></MemoryRouter>);
    const links = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    const outline = screen.getByRole("link", { name: label });
    expect(outline).toHaveAttribute("href", "/app/books/book-1/outline");
    expect(outline.className).toContain("bg-primary");
    expect(links.indexOf("/app/books/book-1/outline")).toBe(links.indexOf("/app/books/book-1/dashboard") + 1);
  });

  it("is a page of its own, loaded only when it is opened", () => {
    expect(parseAppRoute("/app/books/book-1/outline")).toEqual({ kind: "book-outline", bookId: "book-1" });
    const router = readFileSync(resolve(process.cwd(), "src/router.tsx"), "utf8");
    expect(router).toMatch(/path: "books\/:bookId\/outline", lazy: component\(\(\) => import\("@\/pages\/OutlinePage"\), "OutlinePage"\)/);
  });
});

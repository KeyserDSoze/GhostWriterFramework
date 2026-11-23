import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocEntry, DocLang } from "@/lib/generated-docs";

const mocks = vi.hoisted(() => ({
  /** Load the real texts instead of the ones the test gives. */
  real: false,
  /** Every text asked for, as `slug:language`, in order. */
  calls: [] as string[],
  pending: new Map<string, { resolve: (text: string) => void; reject: (error: unknown) => void }>(),
  navigate: null as unknown as NavigateFunction,
}));

vi.mock("@/lib/docContent", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/docContent")>();
  return {
    ...original,
    loadDocMarkdown: (entry: DocEntry, lang: DocLang) => {
      mocks.calls.push(`${entry.slug}:${lang}`);
      if (mocks.real) return original.loadDocMarkdown(entry, lang);
      return new Promise<string>((resolve, reject) => mocks.pending.set(`${entry.slug}:${lang}`, { resolve, reject }));
    },
  };
});

import i18n from "@/i18n";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { DocPage } from "@/pages/public/PublicDocs";
import { AppDocPage } from "@/pages/AppDocsPage";
import { getDocBySlug, localizedDoc, withGeneratedDocs } from "@/lib/docs";
import { docEntries } from "@/lib/generated-docs";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const ROOT = resolve(process.cwd(), "../..");
const t = (key: string) => i18n.t(key) as string;
const DOCS = withGeneratedDocs(docEntries);
const entryOf = (slug: string) => getDocBySlug(slug, DOCS)!;

const SECTIONS: Record<Language, [string, string, string]> = {
  en: ["First section", "Second section", "Third section"],
  it: ["Prima sezione", "Seconda sezione", "Terza sezione"],
};
const ANCHOR: Record<Language, string> = { en: "second-section", it: "seconda-sezione" };
const textOf = (language: Language) => SECTIONS[language].map((heading, index) => `## ${heading}\n\nParagraph ${index + 1}.\n`).join("\n");

/** The text the loader was asked for arrives (in the language it was asked in), or fails. */
async function arrive(slug: string, language: Language) {
  await act(async () => mocks.pending.get(`${slug}:${language}`)!.resolve(textOf(language)));
}
async function fail(slug: string, language: Language) {
  await act(async () => mocks.pending.get(`${slug}:${language}`)!.reject(new TypeError("Failed to fetch dynamically imported module")));
}

function Navigation() {
  mocks.navigate = useNavigate();
  return null;
}

const PAGES = [
  { kind: "public", base: "/docs", page: () => <DocPage /> },
  { kind: "in-app", base: "/app/docs", page: () => <AppDocPage /> },
] as const;
type Page = (typeof PAGES)[number];

function open(page: Page, path: string) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Navigation />
        <Routes><Route path={`${page.base}/:docSlug`} element={page.page()} /></Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const scrolled: Element[] = [];
const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalScrollBy = window.scrollBy;

beforeEach(() => {
  localStorage.setItem("narrarium-theme", "light");
  document.title = "Narrarium";
  mocks.real = false;
  mocks.calls.length = 0;
  mocks.pending.clear();
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});

afterEach(async () => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  window.scrollBy = originalScrollBy;
  await i18n.changeLanguage("en");
});

describe.each(PAGES.flatMap((page) => LANGUAGES.map((language) => ({ ...page, language }))))("the page of a document ($kind, $language)", ({ language, ...page }) => {
  const other: Language = language === "en" ? "it" : "en";

  beforeEach(async () => {
    await i18n.changeLanguage(language);
  });

  it("shows the title and an announced loading state at once, then the text, and loads no other document", async () => {
    open(page, `${page.base}/guide-1-how-it-works`);
    expect(screen.getByRole("heading", { level: 1, name: localizedDoc(entryOf("guide-1-how-it-works"), language).title })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(t("docsContent.loading"));
    await arrive("guide-1-how-it-works", language);
    expect(await screen.findByRole("heading", { level: 2, name: SECTIONS[language][0] })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(mocks.calls).toEqual([`guide-1-how-it-works:${language}`]);
  });

  it("names the document in the title of the page, and moves the focus to the title of the next one", async () => {
    const view = open(page, `${page.base}/guide-1-how-it-works`);
    const first = localizedDoc(entryOf("guide-1-how-it-works"), language).title;
    expect(document.title).toBe(`${first} · Narrarium`);
    await act(async () => mocks.navigate(`${page.base}/dependency-security`));
    const second = localizedDoc(entryOf("dependency-security"), language).title;
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: second }));
    expect(document.title).toBe(`${second} · Narrarium`);
    expect(mocks.calls).toEqual([`guide-1-how-it-works:${language}`, `dependency-security:${language}`]);
    view.unmount();
    expect(document.title).toBe("Narrarium");
  });

  it("says when a document could not be loaded and what to do, and Retry loads it again", async () => {
    open(page, `${page.base}/guide-1-how-it-works`);
    await fail("guide-1-how-it-works", language);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("docsContent.error.title"));
    expect(alert).toHaveTextContent(t("docsContent.error.body"));
    expect(within(alert).getByRole("button", { name: t("docsContent.reload") })).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: t("docsContent.retry") }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(t("docsContent.loading"));
    expect(document.activeElement, "the focus stays in the document, not on the page").not.toBe(document.body);
    await arrive("guide-1-how-it-works", language);
    expect(await screen.findByRole("heading", { level: 2, name: SECTIONS[language][0] })).toBeInTheDocument();
    expect(mocks.calls).toEqual([`guide-1-how-it-works:${language}`, `guide-1-how-it-works:${language}`]);
  });

  it("reaches the section of the address once the text is there", async () => {
    open(page, `${page.base}/guide-1-how-it-works#${ANCHOR[language]}`);
    await arrive("guide-1-how-it-works", language);
    const target = await screen.findByRole("heading", { level: 2, name: SECTIONS[language][1] });
    expect(target).toHaveAttribute("id", ANCHOR[language]);
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(scrolled).toContain(target);
  });

  it("loads the translation when the language changes, keeps the text on screen meanwhile, and keeps the reader where they were", async () => {
    open(page, `${page.base}/guide-1-how-it-works`);
    await arrive("guide-1-how-it-works", language);
    await screen.findByRole("heading", { level: 2, name: SECTIONS[language][1] });
    // Where each heading is on the screen: the reader is in the second section, which began 20 pixels above the top.
    const tops: Record<string, number> = { [SECTIONS[language][0]]: -400, [SECTIONS[language][1]]: -20, [SECTIONS[language][2]]: 300, [SECTIONS[other][0]]: -300, [SECTIONS[other][1]]: 180, [SECTIONS[other][2]]: 500 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = tops[this.textContent ?? ""] ?? 0;
      return { top, bottom: top + 24, left: 0, right: 0, width: 0, height: 24, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    await act(async () => {
      await i18n.changeLanguage(other);
    });
    expect(screen.getByRole("heading", { level: 2, name: SECTIONS[language][1] }), "the text stays while its translation loads").toBeInTheDocument();
    expect(mocks.calls).toEqual([`guide-1-how-it-works:${language}`, `guide-1-how-it-works:${other}`]);
    await arrive("guide-1-how-it-works", other);
    expect(await screen.findByRole("heading", { level: 2, name: SECTIONS[other][1] })).toBeInTheDocument();
    expect(scrollBy).toHaveBeenCalledWith(0, 200);
  });

  it("does not load again a document written once when the language changes", async () => {
    open(page, `${page.base}/dependency-security`);
    await arrive("dependency-security", language);
    await screen.findByRole("heading", { level: 2, name: SECTIONS[language][0] });
    await act(async () => {
      await i18n.changeLanguage(other);
    });
    expect(mocks.calls).toEqual([`dependency-security:${language}`]);
    expect(screen.getByRole("heading", { level: 2, name: SECTIONS[language][0] })).toBeInTheDocument();
  });
});

describe("every document, with its own text", () => {
  it("loads each document in each language from its own source file", async () => {
    const { loadDocMarkdown } = await vi.importActual<typeof import("@/lib/docContent")>("@/lib/docContent");
    expect(DOCS.length).toBeGreaterThanOrEqual(40);
    for (const entry of DOCS) {
      for (const language of LANGUAGES) {
        expect(await loadDocMarkdown(entry, language), `${entry.slug} (${language})`).toBe(readFileSync(resolve(ROOT, localizedDoc(entry, language).sourcePath), "utf8"));
      }
    }
  });

  it.each(PAGES)("opens a guide of the app and a document of the repository on the $kind page, each with the text its loader brings", async (page) => {
    mocks.real = true;
    for (const [slug, heading] of [["autopilot", "Personal server"], ["server", "MCP for each book"]]) {
      const view = open(page, `${page.base}/${slug}`);
      expect(await screen.findByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
      expect(mocks.calls).toContain(`${slug}:en`);
      view.unmount();
    }
  });
});

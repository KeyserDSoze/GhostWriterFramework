import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { McpPage } from "@/pages/public/McpPage";
import { mcpBookTools, type BookToolEntry, type BookToolPermission } from "@/lib/generated-mcp-book-tools";
import { mcpTools } from "@/lib/generated-docs";
import linesEn from "@/i18n/locales/mcpBookTools.en";
import linesIt from "@/i18n/locales/mcpBookTools.it";
import pageEn from "@/i18n/locales/mcpBookPage.en";
import pageIt from "@/i18n/locales/mcpBookPage.it";

type Language = "en" | "it";
const LANGUAGES: Language[] = ["en", "it"];
const PERMISSIONS: BookToolPermission[] = ["read", "write", "run"];
const PAGES = { en: pageEn.mcpBookPage, it: pageIt.mcpBookPage };
const LINES: Record<Language, Record<string, string>> = { en: linesEn.mcpBookTools, it: linesIt.mcpBookTools };
const toolsOf = (permission: BookToolPermission) => mcpBookTools.filter((tool) => tool.permission === permission);

async function open(language: Language, address = "/mcp") {
  await i18n.changeLanguage(language);
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[address]}>
        <McpPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const tableOf = (permission: BookToolPermission, language: Language) => screen.getByRole("table", { name: PAGES[language].permissions[permission].name });
const rowOf = (permission: BookToolPermission, language: Language, name: string) => tableOf(permission, language).querySelector(`tr[data-tool="${name}"]`) as HTMLElement;

beforeEach(async () => {
  localStorage.setItem("narrarium-theme", "light");
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe.each(LANGUAGES)("the public /mcp page (%s)", (language) => {
  const page = PAGES[language];

  it("leads with the MCP of a book on the personal server, then the local and the public MCP, under one title", async () => {
    await open(language);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([page.title, page.packages.title]);
    expect(screen.getByText(page.intro)).toBeInTheDocument();
    expect(screen.getByText(page.lead)).toBeInTheDocument();
    expect(document.documentElement.lang).toBe(language);
  });

  it("says what it is for, how to switch it on, what an assistant may do and how an app connects, each under its own heading", async () => {
    await open(language);
    const book = screen.getByRole("region", { name: page.title });
    for (const heading of [page.use.title, page.start.title, page.permissions.title, page.access.title]) expect(within(book).getByRole("heading", { level: 3, name: heading })).toBeInTheDocument();
    expect(within(book).getByText(page.use.body)).toBeInTheDocument();
    expect(within(book).getByText(page.start.body)).toBeInTheDocument();
    for (const permission of PERMISSIONS) {
      expect(within(book).getByText(page.permissions[permission].name, { selector: "dt" })).toBeInTheDocument();
      expect(within(book).getByText(page.permissions[permission].text, { selector: "dd" })).toBeInTheDocument();
    }
    for (const sentence of [page.access.oauth, page.access.readOnly, page.access.revoke, page.access.token]) expect(within(book).getByText(sentence)).toBeInTheDocument();
  });

  it("links the guide of the book's MCP and the part of the personal server's documentation that holds the details", async () => {
    await open(language);
    expect(screen.getByRole("link", { name: page.start.guide })).toHaveAttribute("href", "/docs/book-mcp");
    expect(screen.getByRole("link", { name: page.start.server })).toHaveAttribute("href", "/docs/server#mcp-for-each-book");
  });

  it("warns, in one sentence that is a note and not an alert, that what an assistant reads can talk it into using the tools", async () => {
    await open(language);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(page.risk.text);
    expect(within(note).getByText(page.risk.label)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists the tools of the server in three tables, one for each permission, in the order the server lists them", async () => {
    await open(language);
    for (const permission of PERMISSIONS) {
      const table = tableOf(permission, language);
      const expected = toolsOf(permission).map((tool) => tool.name);
      expect(expected.length).toBeGreaterThan(0);
      expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(expected);
      expect(within(table).getAllByRole("columnheader")).toHaveLength(2);
    }
    expect(PERMISSIONS.flatMap((permission) => toolsOf(permission))).toHaveLength(mcpBookTools.length);
  });

  it("says in the language of the page what each tool does, with the short line and never the long description of the model", async () => {
    const { container } = await open(language);
    for (const tool of mcpBookTools) {
      const row = rowOf(tool.permission, language, tool.name);
      expect(row, tool.name).not.toBeNull();
      expect(row).toHaveTextContent(LINES[language][tool.name]);
      expect(row.textContent, tool.name).not.toContain(tool.description);
    }
    expect(container.textContent).not.toMatch(/mcpBookTools\.|mcpBookPage\./);
  });

  it("labels what a tool does to the book from its own annotations: only reads, can replace or remove, or does not overwrite", async () => {
    await open(language);
    const label = { readOnly: page.notes.readOnly, destructive: page.notes.destructive, additive: page.notes.additive };
    const kindOf = (tool: BookToolEntry) => (tool.annotations.readOnlyHint ? "readOnly" : tool.annotations.destructiveHint ? "destructive" : "additive");
    const seen = new Set<string>();
    for (const tool of mcpBookTools) {
      const row = rowOf(tool.permission, language, tool.name);
      const kind = kindOf(tool);
      seen.add(kind);
      expect(within(row).getByText(label[kind]), tool.name).toBeInTheDocument();
      for (const other of Object.keys(label).filter((entry) => entry !== kind)) expect(within(row).queryByText(label[other as keyof typeof label]), `${tool.name} is not ${other}`).toBeNull();
    }
    expect([...seen].sort()).toEqual(["additive", "destructive", "readOnly"]);
    expect(within(rowOf("write", language, "update_chapter")).getByText(label.destructive)).toBeInTheDocument();
    expect(within(rowOf("write", language, "create_chapter")).getByText(label.additive)).toBeInTheDocument();
    expect(within(rowOf("read", language, "book_info")).getByText(label.readOnly)).toBeInTheDocument();
  });

  it("names the parameters of a tool, and marks the required ones in words for a screen reader as well as with a star", async () => {
    await open(language);
    const row = rowOf("read", language, "read_chapter");
    expect(within(row).getByText(page.takes.label, { exact: false })).toBeInTheDocument();
    const names = [...row.querySelectorAll("[data-parameter]")].map((parameter) => [parameter.getAttribute("data-parameter"), parameter.getAttribute("data-required")]);
    expect(names).toEqual([["chapter", "true"], ["includeText", "false"], ["offset", "false"], ["limit", "false"]]);
    const chapter = row.querySelector('[data-parameter="chapter"]') as HTMLElement;
    expect(chapter.textContent).toContain("*");
    expect(chapter).toHaveTextContent(page.takes.required);
    expect(row.querySelector('[data-parameter="offset"]')?.textContent).not.toContain("*");
    expect(within(rowOf("read", language, "book_info")).queryByText(page.takes.label, { exact: false })).toBeNull();
    expect(page.tools.legend).toMatch(/\*/);
  });

  it("says what each permission is, and who has it, above its table, with the number of its tools", async () => {
    await open(language);
    for (const permission of PERMISSIONS) {
      const card = tableOf(permission, language).closest("div.rounded-lg") as HTMLElement;
      expect(within(card).getByRole("heading", { level: 3, name: page.permissions[permission].name })).toBeInTheDocument();
      expect(card).toHaveTextContent(page.tables[permission]);
      expect(card).toHaveTextContent(String(toolsOf(permission).length));
    }
    expect(screen.getByText(page.tools.intro)).toBeInTheDocument();
    expect(screen.getByText(page.tools.legend)).toBeInTheDocument();
  });

  it("keeps the local package and the public endpoint as they were, below, with their tables", async () => {
    await open(language);
    const packages = screen.getByRole("region", { name: page.packages.title });
    expect(within(packages).getByText("npx narrarium-mcp-server")).toBeInTheDocument();
    expect(within(packages).getByText("https://narrarium.space/mcp")).toBeInTheDocument();
    expect(within(packages).getAllByRole("heading", { level: 3 }).length).toBeGreaterThanOrEqual(3);
    const local = mcpTools.filter((tool) => tool.surface === "local");
    const publicTools = mcpTools.filter((tool) => tool.surface === "public");
    expect(within(packages).getAllByRole("row").length).toBeGreaterThanOrEqual(local.length + publicTools.length);
    for (const tool of publicTools) expect(within(packages).getAllByText(tool.name).length, tool.name).toBeGreaterThan(0);
  });

  it("lets every column of cards shrink, so that a wide table scrolls inside its card and the page itself never scrolls sideways on a phone", async () => {
    const { container } = await open(language);
    const columns = [...container.querySelectorAll("main .grid")].filter((grid) => [...grid.children].some((child) => child.classList.contains("rounded-lg")));
    expect(columns.length, "the page has columns of cards").toBeGreaterThanOrEqual(4);
    for (const column of columns) expect(column.classList.contains("grid-cols-1"), `a column of cards that may shrink: ${column.className}`).toBe(true);
    for (const table of container.querySelectorAll("main table")) expect(table.closest(".overflow-x-auto"), "the table scrolls in its card").not.toBeNull();
  });

  it("is built so that it reads well on a phone and with a screen reader: named tables, row headers, a labelled way to jump, and tables that scroll inside their card", async () => {
    const { container } = await open(language);
    const jump = screen.getByRole("navigation", { name: page.jump.label });
    const links = within(jump).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([[page.title, "#book"], [page.packages.title, "#packages"]]);
    for (const link of links) expect(container.querySelector((link as HTMLAnchorElement).getAttribute("href") as string), link.textContent ?? "").not.toBeNull();
    for (const table of screen.getAllByRole("table")) {
      expect(table, "a table has a name").toHaveAccessibleName();
      expect(table.closest("div.overflow-x-auto"), "a wide table scrolls inside its card").not.toBeNull();
      for (const header of within(table).getAllByRole("columnheader")) expect(header).toHaveAttribute("scope", "col");
    }
    for (const header of container.querySelectorAll('tbody th')) expect(header).toHaveAttribute("scope", "row");
    const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size, "every id is used once").toBe(ids.length);
    for (const region of screen.getAllByRole("region")) expect(region).toHaveAccessibleName();
  });
});

describe("the two languages", () => {
  it("do not show each other's words or a key that has no text", async () => {
    const english = await open("en");
    const englishText = english.container.textContent ?? "";
    english.unmount();
    const italian = await open("it");
    const italianText = italian.container.textContent ?? "";
    for (const text of [englishText, italianText]) expect(text).not.toMatch(/mcpBookTools\.|mcpBookPage\.|mcpPageContent\./);
    for (const tool of mcpBookTools) {
      expect(italianText).toContain(LINES.it[tool.name]);
      expect(englishText).toContain(LINES.en[tool.name]);
      expect(italianText).not.toContain(LINES.en[tool.name]);
    }
    expect(italianText).not.toContain(PAGES.en.use.body);
    expect(englishText).not.toContain(PAGES.it.use.body);
  });
});

describe.each(LANGUAGES)("an address that names a part of the page (%s)", (language) => {
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const scrolled: Element[] = [];

  beforeEach(() => {
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it.each(["book", "packages"])("brings #%s into view once the page is there, and leaves the focus on it for the next key", async (id) => {
    await open(language, `/mcp#${id}`);
    await waitFor(() => expect(scrolled.map((element) => element.id)).toEqual([id]));
    const part = document.getElementById(id) as HTMLElement;
    expect(part).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement).toBe(part);
    expect(part).toHaveAccessibleName(id === "book" ? PAGES[language].title : PAGES[language].packages.title);
  });

  it("does not move anything when the address names no part, or a part that is not there", async () => {
    const { unmount } = await open(language, "/mcp");
    unmount();
    await open(language, "/mcp#nowhere");
    expect(scrolled).toEqual([]);
    expect(document.activeElement).toBe(document.body);
  });
});

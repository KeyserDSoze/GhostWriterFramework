import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MobileSidebar, Sidebar } from "@/components/layout/Sidebar";
import { OUTLINE_PAGE_READY, bookMenuGroups } from "@/components/layout/bookMenu";
import { useNavGroupsStore } from "@/store/navGroupsStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

type Menu = "desktop" | "mobile";
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const ROOT = "/app/books/book-1";
const t = (key: string) => i18n.t(key) as string;

/** The groups the owner chose, in his order, with the address of every entry (the Outline waits for its page). */
const GROUPS: Array<[string, string[]]> = [
  ["nav.groupBook", [ROOT, `${ROOT}/dashboard`, `${ROOT}/reader`, `${ROOT}/export`]],
  ["autopilot.title", [`${ROOT}/autopilot`, `${ROOT}/autopilot/settings`]],
  ["nav.groupProfiles", [`${ROOT}/director`, `${ROOT}/ghostwriters`, `${ROOT}/evaluation-style`, `${ROOT}/simulated-readers`]],
  ["nav.groupTools", [`${ROOT}/audit`, `${ROOT}/research`, `${ROOT}/assets`]],
];
const CANON = ["characters", "locations", "factions", "items", "timelines", "secrets"].map((section) => `${ROOT}#${section}`);

function open(menu: Menu, path: string, language: "en" | "it" = "en") {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], ui: { ...DEFAULT_SETTINGS.ui, language } } });
  const Component = menu === "desktop" ? Sidebar : MobileSidebar;
  return render(<MemoryRouter initialEntries={[path]}><Component /></MemoryRouter>);
}

const group = (key: string) => screen.getByRole("region", { name: t(key) });
const toggleOf = (key: string) => within(group(key)).getByRole("button", { name: t(key) });
const hrefs = (root: HTMLElement) => within(root).queryAllByRole("link").map((link) => link.getAttribute("href"));
const allHrefs = () => screen.getAllByRole("link").map((link) => link.getAttribute("href"));

beforeEach(async () => {
  localStorage.clear();
  useNavGroupsStore.setState({ collapsed: [] });
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  useUiStore.setState({ sidebarCollapsed: false });
  useNavGroupsStore.setState({ collapsed: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe.each<Menu>(["desktop", "mobile"])("the menu of a book (%s)", (menu) => {
  it("is made of titled groups, in the order the owner chose: Book, Autopilot, Profiles, Tools", async () => {
    open(menu, ROOT);
    // A title is a heading (a screen reader lists it, and jumps from one to the next), not only grey text.
    const titles = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent?.trim());
    expect(titles).toEqual(GROUPS.map(([key]) => t(key)));
    for (const [key, entries] of GROUPS) expect(hrefs(group(key)), key).toEqual(entries);
  });

  it("keeps the canon as it was, after the groups, and puts the settings of the book at the bottom of the menu of the book, apart", () => {
    open(menu, ROOT);
    const links = allHrefs();
    const lastGroupEntry = links.indexOf(`${ROOT}/assets`);
    const settings = links.indexOf(`${ROOT}/settings`);
    const canon = CANON.map((href) => links.indexOf(href));
    expect(canon.every((index) => index > settings), "the canon after the menu of the book").toBe(true);
    expect(canon).toEqual([...canon].sort((a, b) => a - b));
    expect(canon[canon.length - 1] - canon[0]).toBe(CANON.length - 1);
    expect(settings).toBeGreaterThan(lastGroupEntry);
    // Apart: not in a group of its own, nor in one of the others.
    for (const [key] of GROUPS) expect(hrefs(group(key))).not.toContain(`${ROOT}/settings`);
    expect(screen.getByRole("link", { name: t("bookPage.bookSettings") })).toHaveAttribute("href", `${ROOT}/settings`);
    expect(screen.getAllByRole("link", { name: t("bookPage.characters") })).toHaveLength(1);
  });

  it("calls the two pages of the autopilot Live and Configuration, each with its address", () => {
    open(menu, ROOT);
    const autopilot = group("autopilot.title");
    expect(within(autopilot).getByRole("link", { name: t("nav.autopilotLive") })).toHaveAttribute("href", `${ROOT}/autopilot`);
    expect(within(autopilot).getByRole("link", { name: t("nav.autopilotSettings") })).toHaveAttribute("href", `${ROOT}/autopilot/settings`);
    expect(t("nav.autopilotLive")).toBe("Live");
    expect(t("nav.autopilotSettings")).toBe("Configuration");
  });

  it.each([
    [`${ROOT}/autopilot`, "nav.autopilotLive"],
    [`${ROOT}/autopilot/settings`, "nav.autopilotSettings"],
    [`${ROOT}/director`, "director.title"],
    [ROOT, "nav.bookOverview"],
  ])("marks the page that is open (%s) with aria-current, and only that one", (path, key) => {
    open(menu, path);
    const menuOfBook = screen.getByRole("navigation", { name: BOOK.name });
    const current = within(menuOfBook).getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName(t(key));
    expect(current[0]).toHaveAttribute("href", path);
    // The highlight says the same thing: the entry that is current is the one that looks it.
    expect(within(menuOfBook).getAllByRole("link").filter((link) => link.classList.contains("bg-primary"))).toEqual(current);
  });

  it("collapses a group with the button of its title, says so with aria-expanded, and remembers it on this device", () => {
    const view = open(menu, ROOT);
    const button = toggleOf("nav.groupTools");
    expect(button).toHaveAttribute("aria-expanded", "true");
    const list = document.getElementById(button.getAttribute("aria-controls") ?? "") as HTMLElement;
    expect(list, "the button names what it opens and closes").not.toBeNull();
    expect(within(list).getByRole("link", { name: t("audit.title") })).toBeVisible();

    fireEvent.click(button);
    expect(toggleOf("nav.groupTools")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: t("audit.title") })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("narrarium-nav-groups") ?? "{}").state?.collapsed).toEqual(["tools"]);

    // The next visit on this device finds it as it was left.
    view.unmount();
    open(menu, ROOT);
    expect(toggleOf("nav.groupTools")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggleOf("nav.groupTools"));
    expect(toggleOf("nav.groupTools")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: t("audit.title") })).toBeInTheDocument();
  });

  it("always opens the group of the page that is open, even when it was collapsed", () => {
    act(() => useNavGroupsStore.setState({ collapsed: ["autopilot", "profiles"] }));
    open(menu, `${ROOT}/autopilot/settings`);
    expect(toggleOf("autopilot.title")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: t("nav.autopilotSettings") })).toHaveAttribute("aria-current", "page");
    // The other groups stay as the author left them.
    expect(toggleOf("nav.groupProfiles")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: t("director.title") })).not.toBeInTheDocument();
  });

  it("opens the Tools on the page of one research, which is one of its pages", () => {
    act(() => useNavGroupsStore.setState({ collapsed: ["tools"] }));
    open(menu, `${ROOT}/research/rome`);
    expect(toggleOf("nav.groupTools")).toHaveAttribute("aria-expanded", "true");
  });

  it("has buttons that show where the focus is, and are reached with the keyboard as any button", () => {
    open(menu, ROOT);
    for (const [key] of GROUPS) {
      const button = toggleOf(key);
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("type", "button");
      expect(button.className).toMatch(/focus-visible:ring-2/);
      expect(button.closest("h2"), "the button is the title").not.toBeNull();
    }
  });

  it("says it in Italian with the names the owner confirmed", async () => {
    await i18n.changeLanguage("it");
    open(menu, ROOT, "it");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent?.trim())).toEqual(["Libro", "Autopilot", "Profili", "Strumenti"]);
    const names = (key: string) => within(group(key)).getAllByRole("link").map((link) => link.textContent?.trim());
    expect(names("nav.groupBook")).toEqual(["Panoramica", "Dashboard", "Reader", "Esporta"]);
    expect(names("autopilot.title")).toEqual(["In diretta", "Configurazione"]);
    expect(names("nav.groupProfiles")).toEqual(["Direttore", "Ghostwriter", "Stile di valutazione", "Lettori simulati"]);
    expect(names("nav.groupTools")).toEqual(["Audit", "Ricerche", "Asset"]);
    expect(screen.getByRole("link", { name: "Impostazioni libro" })).toHaveAttribute("href", `${ROOT}/settings`);
  });
});

describe("the Outline (another delivery makes its page)", () => {
  it("is not in the menu while its page is not ready", () => {
    expect(OUTLINE_PAGE_READY).toBe(false);
    open("desktop", ROOT);
    expect(allHrefs()).not.toContain(`${ROOT}/outline`);
  });

  it("is ready to appear in the Book group, after the Dashboard, when its page is", () => {
    const groups = bookMenuGroups("book-1", { outlineReady: true });
    const book = groups.find((entry) => entry.id === "book");
    expect(book?.items.map((item) => item.href)).toEqual([ROOT, `${ROOT}/dashboard`, `${ROOT}/outline`, `${ROOT}/reader`, `${ROOT}/export`]);
    expect(book?.items[2].labelKey).toBe("nav.outline");
    expect([i18n.getFixedT("en")("nav.outline"), i18n.getFixedT("it")("nav.outline")]).toEqual(["Outline", "Scaletta"]);
  });

  it("leaves the groups as they are without it", () => {
    const groups = bookMenuGroups("book-1", { outlineReady: false });
    expect(groups.map((entry) => entry.id)).toEqual(["book", "autopilot", "profiles", "tools"]);
    expect(groups.flatMap((entry) => entry.items.map((item) => item.href))).toEqual(GROUPS.flatMap(([, entries]) => entries));
  });
});

describe("the other menus", () => {
  it("keep the entries of the settings as they were", () => {
    open("desktop", "/app/settings/ai-router");
    expect(screen.queryByRole("region", { name: t("nav.groupBook") })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("settingsSection.aiRouterTitle") })).toHaveAttribute("aria-current", "page");
  });

  it("show the groups of the book on the pages of its chapters too, with nothing marked as open in them", () => {
    open("desktop", `${ROOT}/chapters/001-start`);
    expect(group("nav.groupBook")).toBeInTheDocument();
    for (const [key] of GROUPS) expect(within(group(key)).queryAllByRole("link").filter((link) => link.hasAttribute("aria-current"))).toEqual([]);
  });
});

vi.setConfig({ testTimeout: 30_000 });

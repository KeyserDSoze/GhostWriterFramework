import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, RouterProvider, createMemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { AssistantLauncher } from "@/components/assistant/AssistantLauncher";
import { FloatingLayers } from "@/components/layout/FloatingLayers";
import { MobileNavDrawer, useNavDrawer } from "@/components/layout/MobileNavDrawer";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useDirtyNavigationGuard } from "@/hooks/useDirtyNavigationGuard";
import { useNavGroupsStore } from "@/store/navGroupsStore";
import { useSaveStore } from "@/store/saveStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

// G8 and G9 of the review, on a phone: the floating buttons and the mini-player must not cover the field that is being written in (WCAG 2.2,
// 2.4.11), the menu of the app is a drawer that the thumb, the Escape key and the back gesture all close, and the close button of every
// dialog is a target a finger can hit, named in the language of the app.

const t = (key: string) => i18n.t(key) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };

/** The screen: a phone (narrow, touch) or a computer (wide, mouse). The layout asks with `matchMedia`. */
function screenOf(kind: "phone" | "computer") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: kind === "phone" && /max-width|pointer:\s*coarse/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

beforeEach(async () => {
  localStorage.clear();
  useUiStore.setState({ floatingHidden: false });
  useNavGroupsStore.setState({ collapsed: [] });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK] } });
  useSaveStore.setState({ current: null });
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useSaveStore.setState({ current: null });
  await i18n.changeLanguage("en");
});

describe("the floating buttons while a field of the page is being written in", () => {
  function page() {
    return render(
      <MemoryRouter initialEntries={["/app/books/book-1"]}>
        <main>
          <label>Title <input type="text" /></label>
          <label>Notes <textarea /></label>
          <label>Count <input type="number" /></label>
          <button type="button">A plain button</button>
          <label>Agree <input type="checkbox" /></label>
        </main>
        <label>Search the dossier <input type="search" /></label>
        <FloatingLayers><AssistantLauncher /></FloatingLayers>
      </MemoryRouter>,
    );
  }
  const launcher = () => screen.getByRole("button", { name: t("assistant.floatingButton") });
  const shown = () => { try { expect(launcher()).toBeVisible(); return true; } catch { return false; } };
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });

  it("step aside on a phone while a text field of the page has the focus, and come back when it is left", async () => {
    screenOf("phone");
    page();
    expect(launcher()).toBeVisible();
    act(() => screen.getByLabelText("Title").focus());
    await settle();
    expect(launcher()).not.toBeVisible();
    act(() => (document.activeElement as HTMLElement).blur());
    await settle();
    expect(launcher()).toBeVisible();
  });

  it("let a tap through to the page under them while they are aside", async () => {
    screenOf("phone");
    page();
    act(() => screen.getByLabelText("Notes").focus());
    await settle();
    const layer = launcher().closest("[data-floating-layers]") as HTMLElement;
    expect(layer).not.toBeNull();
    expect(getComputedStyle(layer).pointerEvents).toBe("none");
  });

  it("do not come back for a moment while the focus goes from one field to the next", async () => {
    screenOf("phone");
    page();
    act(() => screen.getByLabelText("Title").focus());
    await settle();
    const seen: boolean[] = [];
    const observer = new MutationObserver(() => seen.push(shown()));
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["style", "class", "hidden"] });
    act(() => screen.getByLabelText("Notes").focus());
    await settle();
    act(() => screen.getByLabelText("Count").focus());
    await settle();
    observer.disconnect();
    expect(seen.filter(Boolean), "never shown between two fields").toEqual([]);
    expect(launcher()).not.toBeVisible();
  });

  it("stay for a control that opens no keyboard, and for a field outside the page (a dialog, the dossier, the Copilot)", async () => {
    screenOf("phone");
    page();
    act(() => screen.getByRole("button", { name: "A plain button" }).focus());
    await settle();
    expect(launcher()).toBeVisible();
    act(() => screen.getByLabelText("Agree").focus());
    await settle();
    expect(launcher()).toBeVisible();
    act(() => screen.getByLabelText("Search the dossier").focus());
    await settle();
    expect(launcher()).toBeVisible();
  });

  it("step aside while the keyboard moves the focus through the page, and come back as soon as the focus reaches them", async () => {
    screenOf("phone");
    page();
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => screen.getByRole("button", { name: "A plain button" }).focus());
    await settle();
    expect(launcher()).not.toBeVisible();
    // Aside, they are still in the order of the Tab key: reached, they are shown again.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
    act(() => launcher().focus());
    await settle();
    expect(launcher()).toBeVisible();
  });

  it("stay where they are on a computer with a mouse: the field and the buttons fit side by side", async () => {
    screenOf("computer");
    page();
    act(() => screen.getByLabelText("Title").focus());
    await settle();
    expect(launcher()).toBeVisible();
  });
});

describe("the menu of the app on a phone", () => {
  const confirm = vi.fn(() => true);
  function Opener() {
    const drawer = useNavDrawer();
    const location = useLocation();
    useDirtyNavigationGuard(t("common.unsavedNavigationConfirm"));
    return (
      <>
        <button type="button" onClick={drawer.show}>{t("shell.openNav")}</button>
        <p data-testid="where">{location.pathname}</p>
        <MobileNavDrawer />
      </>
    );
  }
  function app(path = "/app/books/book-1") {
    const router = createMemoryRouter([{ path: "*", element: <Opener /> }], { initialEntries: ["/app/books", path], initialIndex: 1 });
    render(<RouterProvider router={router} />);
    return router;
  }
  const drawer = () => screen.queryByRole("dialog", { name: t("shell.navMenu") });
  const open = () => fireEvent.click(screen.getByRole("button", { name: t("shell.openNav") }));
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  beforeEach(() => {
    confirm.mockClear();
    vi.stubGlobal("confirm", confirm);
  });

  it("is a dialog with a name, and the focus goes into it", () => {
    screenOf("phone");
    app();
    open();
    expect(drawer()).not.toBeNull();
    expect(drawer()?.contains(document.activeElement)).toBe(true);
    expect(within(drawer() as HTMLElement).getByRole("link", { name: t("nav.outline") })).toBeInTheDocument();
  });

  it("closes with the Escape key, and the focus goes back to the button that opened it", async () => {
    screenOf("phone");
    const router = app();
    const button = screen.getByRole("button", { name: t("shell.openNav") });
    button.focus();
    fireEvent.click(button);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(drawer()).toBeNull();
    await flush();
    expect(document.activeElement).toBe(button);
    expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1");
    // The step the menu took in the history is given back: the next back goes to the page before.
    await act(async () => { await router.navigate(-1); });
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/app\/books$/);
  });

  it("closes with its close button, a target a thumb can hit, named in the language of the app", async () => {
    screenOf("phone");
    app();
    open();
    const close = within(drawer() as HTMLElement).getByRole("button", { name: t("common.close") });
    expect(close).toHaveClass("h-11", "w-11");
    fireEvent.click(close);
    expect(drawer()).toBeNull();
    await flush();
    expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1");
  });

  it("closes with the back gesture, and the page stays where it was", async () => {
    screenOf("phone");
    const router = app();
    open();
    expect(drawer()).not.toBeNull();
    await act(async () => { await router.navigate(-1); });
    expect(drawer()).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1");
    // And the next back goes to the page before, not to the menu again.
    await act(async () => { await router.navigate(-1); });
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/app\/books$/);
  });

  it("takes the place of its own step in the history when one of its links is followed: back goes to the page before the menu", async () => {
    screenOf("phone");
    const router = app();
    open();
    fireEvent.click(within(drawer() as HTMLElement).getByRole("link", { name: t("nav.outline") }));
    await flush();
    expect(drawer()).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1/outline");
    await act(async () => { await router.navigate(-1); });
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/app\/books\/book-1$/);
    expect(drawer(), "the menu is not opened again by going back").toBeNull();
  });

  it("does not ask about unsaved changes to be opened or closed: only leaving the page asks", async () => {
    screenOf("phone");
    useSaveStore.setState({ current: { dirty: true, save: () => true } });
    const router = app();
    open();
    await flush();
    expect(drawer()).not.toBeNull();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await flush();
    open();
    await flush();
    await act(async () => { await router.navigate(-1); });
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1");
    open();
    await flush();
    fireEvent.click(within(drawer() as HTMLElement).getByRole("link", { name: t("nav.outline") }));
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("has bigger rows for a thumb on a touch screen", () => {
    screenOf("phone");
    app();
    open();
    const link = within(drawer() as HTMLElement).getByRole("link", { name: t("nav.outline") });
    expect(link).toHaveClass("[@media(pointer:coarse)]:min-h-11");
    const group = within(drawer() as HTMLElement).getByRole("button", { name: t("nav.groupBook") });
    expect(group).toHaveClass("[@media(pointer:coarse)]:min-h-11");
  });

  it("does not carry the hash or the state of the page into its step: what the page did once for them is not done again, and they are back when it closes", async () => {
    screenOf("phone");
    const router = createMemoryRouter([{ path: "*", element: <Opener /> }], { initialEntries: ["/app/books", { pathname: "/app/books/book-1", hash: "#outline-chapter-2", state: { auditTextOffset: 4 } }], initialIndex: 1 });
    render(<RouterProvider router={router} />);
    open();
    await flush();
    expect(drawer()).not.toBeNull();
    expect(router.state.location.hash).toBe("");
    expect(router.state.location.state).toEqual({ narrariumNavDrawer: true });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await flush();
    expect(router.state.location.pathname).toBe("/app/books/book-1");
    expect(router.state.location.hash).toBe("#outline-chapter-2");
    expect(router.state.location.state).toEqual({ auditTextOffset: 4 });
  });

  it("is named in Italian", async () => {
    await i18n.changeLanguage("it");
    screenOf("phone");
    app();
    open();
    expect(screen.getByRole("dialog", { name: "Menu di navigazione" })).toBeInTheDocument();
    expect(within(drawer() as HTMLElement).getByRole("button", { name: "Chiudi" })).toBeInTheDocument();
  });
});

describe("the close button of a dialog", () => {
  function dialog() {
    return render(<Dialog open><DialogContent><DialogTitle>Export the book</DialogTitle><p>Choose a format.</p></DialogContent></Dialog>);
  }

  it("is named in the language of the app", async () => {
    dialog();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    cleanup();
    await i18n.changeLanguage("it");
    dialog();
    expect(screen.getByRole("button", { name: "Chiudi" })).toBeInTheDocument();
  });

  it("is a target of at least 24 px, and of 44 px on a touch screen", () => {
    dialog();
    const close = screen.getByRole("button", { name: t("common.close") });
    expect(close).toHaveClass("size-9");
    expect(close).toHaveClass("[@media(pointer:coarse)]:size-11");
    expect(close).toHaveClass("inline-flex", "items-center", "justify-center");
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { read } from "./support/sources.mjs";

/**
 * G8 and G9 of the review: on a phone the floating buttons (the Copilot, the autopilot, the book actions) and the live panel covered the
 * switches and the fields at the end of a form, and the top bar of the app was cut at the right edge. The room for them is kept by the
 * layout, not by luck: the page of the app reserves it at the bottom, and every layer that floats takes its place above what a page
 * reserves for its own bar of actions (`--bottom-reserve`). The geometry itself is checked in a real browser at 390 px; this keeps the contract written.
 */

const rem = (value) => Number.parseFloat(value);

test("the scrolling page of the app keeps room at the bottom for the floating buttons, and for the bar of actions a page may have", async () => {
  const shell = await read("src/components/layout/Shell.tsx");
  const main = /<main className="([^"]*)"/.exec(shell)?.[1] ?? "";
  assert.match(main, /(?<![:\w-])pb-\[calc\([^\]]*var\(--bottom-reserve,0px\)[^\]]*var\(--dock-reserve,0px\)\)\]/, "on a phone the padding at the bottom adds what the page reserves and what the live panel takes");
  assert.match(main, /lg:pb-\[calc\([^\]]*var\(--bottom-reserve,0px\)\)\]/, "on a wide screen the launchers are alone");
  assert.doesNotMatch(main, /(^|\s)(sm:)?p-[46](\s|$)/, "a shorthand padding would take the room back at some width");
  const below = rem(/(?<![:\w-])pb-\[calc\(([\d.]+)rem/.exec(main)?.[1] ?? "0");
  // The book actions button sits at 5rem and is 2.75rem tall: what is below the top of it cannot be reached by the last field.
  assert.ok(below >= 7.75, `room for the floating buttons on a phone (saw ${below}rem)`);
});

test("the page scrolls its anchors and its focused controls clear of a band that sticks to the top and of a bar that sticks to the bottom", async () => {
  const shell = await read("src/components/layout/Shell.tsx");
  const main = /<main className="([^"]*)"/.exec(shell)?.[1] ?? "";
  assert.match(main, /\bscroll-pt-\[var\(--top-reserve,0px\)\]/);
  // WCAG 2.2, 2.4.11 (focus not obscured): a control reached with the Tab key is scrolled to the edge of the page, which is under the bar of actions of a phone unless the page says so.
  assert.match(main, /\bscroll-pb-\[var\(--bottom-reserve,0px\)\]/);
});

test("the floating layers sit above the bar of actions a page reserves at the bottom", async () => {
  const launcher = await read("src/components/assistant/AssistantLauncher.tsx");
  assert.match(launcher, /bottom-\[calc\(1rem\+var\(--bottom-reserve,0px\)\)\]/);
  assert.match(launcher, /lg:bottom-\[calc\(1\.5rem\+var\(--bottom-reserve,0px\)\)\]/);
  const actions = await read("src/components/layout/FloatingActions.tsx");
  assert.match(actions, /bottom-\[calc\(5rem\+var\(--bottom-reserve,0px\)\)\]/);
  assert.match(actions, /lg:bottom-\[calc\(6rem\+var\(--bottom-reserve,0px\)\)\]/);
});

test("the live panel is never above the buttons of the assistant: on a phone it sits over the book actions button, which is the highest of them", async () => {
  const dock = await read("src/components/autopilot/AutopilotDock.tsx");
  const mobile = /(?<![:\w-])bottom-\[calc\(([\d.]+)rem\+var\(--bottom-reserve,0px\)\)\]/.exec(dock)?.[1];
  assert.ok(mobile, "the panel has an offset from the bottom on a phone");
  assert.ok(rem(mobile) >= 8, `above the book actions button (5rem + 2.75rem + a gap): saw ${mobile}rem`);
  const wide = /lg:bottom-\[calc\(([\d.]+)rem\+var\(--bottom-reserve,0px\)\)\]/.exec(dock)?.[1];
  assert.ok(wide && rem(wide) >= 5.5, `above the launchers (1.5rem + 2.75rem) on a wide screen: saw ${wide}rem`);
});

test("the live panel does not cover the page for good: it asks for room at the bottom while it is open on a phone", async () => {
  const dock = await read("src/components/autopilot/AutopilotDock.tsx");
  assert.match(dock, /useReserveSpace\([^)]*"--dock-reserve"/, "the panel reserves the room it takes, under its own name: it is not lifted by itself");
  const hook = await read("src/hooks/useReserveSpace.ts");
  assert.match(hook, /export function useReserveSpace\(/);
  const band = await read("src/components/autopilot/AutopilotControlBand.tsx");
  assert.match(band, /useReserveSpace\([^)]*"--top-reserve"/, "the band that sticks tells the page how much of its top it covers");
  const page = await read("src/pages/AutopilotPage.tsx");
  assert.match(page, /useReserveSpace\([^)]*"--bottom-reserve"/, "the bar of actions at the bottom tells the page and the floating layers how much room it takes");
});

test("the top bar of the app does not overflow on a phone: what does not fit moves to the menu of the account", async () => {
  const topbar = await read("src/components/layout/Topbar.tsx");
  // The buttons that can wait, and the same actions in the menu for the widths where the buttons are not there.
  for (const label of ["shell.hideFloating", "shell.readPage", "notes.title"]) {
    assert.ok(topbar.includes(label), `${label} is still offered`);
  }
  assert.ok((topbar.match(/hidden sm:inline-flex/g) ?? []).length >= 3, "the buttons that can wait are hidden below sm");
  assert.ok((topbar.match(/sm:hidden/g) ?? []).length >= 3, "the same actions are in the menu, only below sm");
  assert.match(topbar, /min-w-0/, "the right side of the bar can shrink instead of pushing the edge out");
});

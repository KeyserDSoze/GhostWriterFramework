import assert from "node:assert/strict";
import test from "node:test";
import { baseUtilities, read, stringLiterals } from "./support/sources.mjs";

/**
 * P8-4: in the dark theme the floating layers (the autopilot dock, the dossier, menus, dialogs, selects, toasts, the install prompt) and
 * the cards used to melt into the page: their edge was `--border`, 1.4:1 against the background. They now draw their edge with
 * `border-layer`, a token that is 3:1 against the page, the card and the popover in the dark theme (see themeContrast.test.mjs) and the
 * soft `--border` in the light one. This test makes sure the edge is really applied.
 */

/**
 * A raised surface is a bordered, opaque surface that casts a shadow: a floating layer (dialog, menu, select, dock, prompt, toast, launcher),
 * or a card (`bg-card` with `shadow-sm`, hand-written or the shared Card component). List rows and chips have no shadow and keep the soft border.
 */
const isRaised = (list) => {
  const utilities = baseUtilities(list);
  if (!utilities.includes("border")) return false;
  if (utilities.includes("bg-card") || utilities.includes("bg-popover")) return utilities.some((utility) => /^shadow-(sm|md|lg|xl|2xl)$/.test(utility));
  if (utilities.includes("bg-background")) return utilities.some((utility) => /^shadow-(md|lg|xl|2xl)$/.test(utility));
  return false;
};

test("every raised surface of the app (floating layers and cards: opaque, bordered, with a shadow) draws its edge with border-layer", async () => {
  const raised = (await stringLiterals(/shadow-(sm|md|lg|xl|2xl)/)).filter(({ list }) => isRaised(list));
  assert.ok(raised.length >= 20, `the scan should find the floating layers and the cards of the app (saw ${raised.length})`);
  const missing = raised.filter(({ list }) => !baseUtilities(list).includes("border-layer"));
  assert.deepEqual(missing.map(({ file, line, list }) => `${file}:${line} ${list.slice(0, 100)}`), []);
});

test("the shared components and the autopilot dock carry the edge (card, dialog, menus, select, toast, dock)", async () => {
  const expected = {
    "src/components/ui/card.tsx": 1,
    "src/components/ui/dialog.tsx": 2,
    "src/components/ui/dropdown-menu.tsx": 2,
    "src/components/ui/select.tsx": 1,
    "src/components/ui/toast.tsx": 1,
    "src/components/autopilot/AutopilotDock.tsx": 1,
    "src/components/autopilot/AutopilotLauncher.tsx": 1,
    "src/components/layout/DossierDock.tsx": 3,
    "src/components/layout/FloatingActions.tsx": 1,
    "src/components/layout/InstallPrompt.tsx": 1,
    "src/components/editor/GlobalContextMenu.tsx": 2,
  };
  for (const [file, count] of Object.entries(expected)) {
    const source = await read(file);
    const found = source.match(/\bborder-layer\b/g)?.length ?? 0;
    assert.ok(found >= count, `${file}: expected at least ${count} border-layer, found ${found}`);
  }
});

test("the dock keeps its position and content: only colour, border and shadow classes changed", async () => {
  const dock = await read("src/components/autopilot/AutopilotDock.tsx");
  assert.match(dock, /fixed bottom-20 right-4 z-40 flex max-h-\[min\(70dvh,38rem\)\] w-\[min\(26rem,calc\(100vw-2rem\)\)\] flex-col overflow-hidden rounded-2xl/);
  assert.match(dock, /lg:bottom-24 lg:right-6/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { read } from "./support/sources.mjs";

/**
 * Phase 2 of the mobile work, the pages of the autopilot on a phone (real Chromium with touch, 320 to 768 px). What jsdom cannot lay out is kept
 * here as a contract; the geometry is measured again with the audit scripts.
 */

const COARSE = "[@media(pointer:coarse)]:";

test("the table of the chapter map scrolls inside its own frame: what screen readers alone read (`sr-only`) does not widen the page", async () => {
  // The cells say «none» to a screen reader with a visually hidden span, absolutely positioned: without a positioned frame its containing block was the
  // page, the span sat beyond the right edge of the screen, and on a phone the page grew 27 px wider (the floating buttons went off the screen with it).
  const table = await read("src/components/autopilot/map/MapTable.tsx");
  const region = /<div role="region"[^>]*className="([^"]*)"/.exec(table)?.[1] ?? "";
  assert.match(region, /\brelative\b/, "the frame of the table is positioned");
  assert.match(region, /\boverflow-auto\b/);
  const panel = await read("src/components/autopilot/map/ChapterPanel.tsx");
  assert.match(panel, /<div className="relative overflow-x-auto">\s*<table aria-labelledby=\{id\}/, "the table of the rounds of a chapter too");
});

test("the grid of the chapter map: scene cells a finger can hit, and a frame that gives the scroll back to the page", async () => {
  const grid = await read("src/components/autopilot/map/MapGrid.tsx");
  const cell = /role="gridcell"[\s\S]*?className=\{cn\("([^"]*)"/.exec(grid)?.[1] ?? "";
  assert.match(cell, /(?<![:\w-])h-8 w-8\b/, "32 px with a mouse");
  assert.ok(cell.includes(`${COARSE}h-11`) && cell.includes(`${COARSE}w-11`), `44 px under a finger (saw "${cell}")`);
  const frame = /ref=\{grid\}[\s\S]*?className="([^"]*)"/.exec(grid)?.[1] ?? "";
  // A frame 28rem tall on a 568 px phone left no room to scroll the page, and `overscroll-contain` kept the thumb in it.
  assert.match(frame, /max-h-\[min\(28rem,60dvh\)\]/, "never taller than 60% of the screen");
  assert.doesNotMatch(frame, /(?<![:\w-])overscroll-contain\b/, "a finger that reaches the end of the map goes on scrolling the page");
  assert.match(frame, /\[@media\(pointer:fine\)\]:overscroll-contain/, "a mouse wheel stays in the map");
});

test("the Director page at 320 px: the rows of the readers' weights shrink with the screen, and the vision fits above the save bar", async () => {
  const page = await read("src/pages/DirectorPage.tsx");
  assert.match(page, /<div key=\{reader\.slug\} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border px-3 py-1\.5">/, "a row of a reader can be narrower than its name and its menu");
  assert.match(page, /<AutoTextarea id="director-vision"[^\n]*maxHeight=\{visionHeight\}/, "the vision grows up to a height that fits above the bar, then scrolls inside");
  // Given the focus while partly on the screen, a field is not scrolled by the browser: Chromium left the vision 31–44% under the bar at 390 and 768 px.
  assert.match(page, /<AutoTextarea id="director-vision"[^\n]*onFocus=\{revealAboveBar\}/, "the vision comes whole into view above the bar when it takes the focus");
  assert.match(page, /const revealAboveBar = [^\n]*scrollIntoView\?\.\(\{ block: "nearest" \}\)/, "with the least movement, the page's scroll padding keeping it above the bar");
  // The defaults of a director never saved are not changes of the author: leaving the page after only reading it asks nothing.
  assert.match(page, /useRegisterPageSave\(\{ dirty: edited,/, "only the author's changes count when the page is left");
});

test("the plan approval screen and the chapter panel on a phone: names of the cast a finger can hit, a panel whose top keeps only its title and its close", async () => {
  const approval = await read("src/components/autopilot/plan/PlanApproval.tsx");
  const cast = /<Link to=\{`\/app\/books\/\$\{encodeURIComponent\(bookId\)\}\/canon\/characters\/[^`]*`\} className="([^"]*)">\{member\.name\}<\/Link>/.exec(approval)?.[1] ?? "";
  assert.match(cast, /(?<![:\w-])min-h-6\b/, `the name of a character is a 24 px target (saw "${cast}")`);
  assert.ok(cast.includes(`${COARSE}min-h-11`), "and 44 px under a finger");
  const panel = await read("src/components/autopilot/map/ChapterPanel.tsx");
  const sticky = /<div className="(sticky top-0[^"]*)">([\s\S]*?)<\/div>/.exec(panel);
  assert.ok(sticky, "the panel has a top that stays");
  assert.match(sticky[2], /<DialogTitle/, "the title stays at the top");
  assert.match(sticky[2], /<DialogClose asChild>/, "and the close");
  assert.doesNotMatch(sticky[2], /<DialogDescription|chapterPanel\.open/, "what the chapter is and its links scroll with the rest (they took half of a 568 px screen)");
});

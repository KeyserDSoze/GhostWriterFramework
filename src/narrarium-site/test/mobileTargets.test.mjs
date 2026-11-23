import assert from "node:assert/strict";
import test from "node:test";
import { read } from "./support/sources.mjs";

/**
 * P11 of the review, the pages outside the autopilot on a phone. The mobile audit (Chromium with touch, 320 to 1280 px) measured targets under the
 * 24 px of WCAG 2.2 (2.5.8), rows of actions that pushed the page sideways at 320 px (1.4.10, reflow) and a long word that did not wrap. The
 * geometry is checked again in the browser with the audit script; this keeps the contract written where jsdom has no layout: at least 24 px on
 * every screen, and 44 px where the pointer is a finger (`[@media(pointer:coarse)]:`), as far as the row allows.
 */

const COARSE = "[@media(pointer:coarse)]:";
/** The class list of the JSX element that has `marker` in its attributes (a label key, an aria-label, a handler). */
function classesNear(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `the source still has ${marker}`);
  const start = source.lastIndexOf("<", at);
  const end = source.indexOf(">", at + marker.length);
  const tag = source.slice(start, end);
  return /className="([^"]*)"/.exec(tag)?.[1] ?? /className=\{[^}]*"([^"]*)"/.exec(tag)?.[1] ?? "";
}
const atLeast24 = (classes, what) => assert.match(classes, /(?<![:\w-])(h-(6|7|8|9|10|11)|min-h-(6|7|8|9|10|11)|size-(6|7|8|9|10|11))\b/, `${what}: at least 24 px tall (saw "${classes}")`);
const fingerSized = (classes, what, size = "11") => assert.ok(classes.includes(`${COARSE}h-${size}`) || classes.includes(`${COARSE}min-h-${size}`) || classes.includes(`${COARSE}size-${size}`), `${what}: ${Number(size) * 4} px on a touch screen (saw "${classes}")`);

// Two arrows one above the other: 24 px each, 32 px under a finger (a 64 px column, as tall as the row can take).
test("the arrows that move a chapter on the page of the book are 24 px, and bigger under a finger", async () => {
  const list = await read("src/components/book/ChapterReorderList.tsx");
  for (const marker of ['"bookPage.moveChapterUp"', '"bookPage.moveChapterDown"']) {
    const classes = classesNear(list, marker);
    assert.match(classes, /(?<![:\w-])h-6\b/, `${marker}: 24 px tall`);
    assert.match(classes, /(?<![:\w-])w-6\b/, `${marker}: 24 px wide`);
    fingerSized(classes, marker, "8");
  }
});

test("the rows of the scenes on the page of the chapter: arrows, title, actions and delete are targets a finger can hit", async () => {
  const page = await read("src/pages/ChapterPage.tsx");
  for (const marker of ['"chapter.moveParagraphUp"', '"chapter.moveParagraphDown"']) {
    const classes = classesNear(page, marker);
    assert.match(classes, /(?<![:\w-])h-6\b/, `${marker}: 24 px tall`);
    fingerSized(classes, marker, "8");
  }
  // Bigger targets take room from the title: below a width the row wraps (the menu and delete go to a second line) instead of cutting the title to a few letters.
  assert.match(page, /"flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2\.5 text-sm transition-colors"/, "the row of a scene wraps");
  assert.match(page, /<div className="ml-auto flex items-center gap-1">\s*<ParagraphActionChip/, "the actions of a scene stay at the right, also on the second line");
  const group = page.indexOf('<div className="ml-auto flex items-center gap-1">');
  const close = page.indexOf("</DropdownMenu>", group);
  const deleteAt = page.indexOf('"chapter.deleteParagraphAria"', group);
  assert.ok(deleteAt > close && page.slice(close, deleteAt).split("</div>").length === 1, "delete is in the same group as the menu: the two wrap together");
  const title = /<Link\s+to=\{`\/app\/books\/\$\{bookId\}\/chapters\/\$\{chapterId\}\/paragraphs\/\$\{p\.number\}`\}\s+className="([^"]*)"/.exec(page)?.[1] ?? "";
  assert.match(title, /(?<![:\w-])py-2\b/, "the title of a scene is a link as tall as a button (36 px), not as its line of text");
  assert.match(title, /(?<![:\w-])min-w-\[6rem\]/, "the title keeps at least 6rem before the row wraps");
  assert.ok(title.includes(`${COARSE}py-3`), `the title of a scene: 44 px on a touch screen (saw "${title}")`);
  const more = classesNear(page, 'aria-label={t("assistant.quickActions")}');
  fingerSized(more, "the menu of a scene", "9");
  const remove = classesNear(page, '"chapter.deleteParagraphAria"');
  atLeast24(remove, "delete a scene");
  fingerSized(remove, "delete a scene", "9");
});

test("the fields of a canon entry and of a scene: the remove buttons and Add field are targets, the row of actions wraps", async () => {
  for (const file of ["src/pages/CanonEntityPage.tsx", "src/pages/ParagraphPage.tsx"]) {
    const page = await read(file);
    const remove = classesNear(page, '"canon.removeAria"');
    atLeast24(remove, `${file}: remove a field`);
    fingerSized(remove, `${file}: remove a field`);
    const add = classesNear(page, "onClick={() => setShowAddMeta(true)}");
    atLeast24(add, `${file}: Add field`);
    fingerSized(add, `${file}: Add field`);
  }
  const canon = await read("src/pages/CanonEntityPage.tsx");
  assert.match(canon, /<div className="flex flex-wrap items-center gap-2">\s*<Badge variant="outline" className="font-mono text-xs">\{branch\}/, "branch, Regenerate and Save go to the next line at 320 px instead of pushing the page sideways");
  // At 320 px the value of a field was a 65 px box: the field goes under its name instead.
  for (const [file, key] of [["src/pages/CanonEntityPage.tsx", "entry.key"], ["src/pages/ParagraphPage.tsx", "e.key"]]) {
    const page = await read(file);
    assert.ok(page.includes(`<div key={${key}} className="flex flex-wrap items-center gap-x-3 gap-y-1">`), `${file}: a field row wraps`);
    assert.match(page, /className="h-[78] min-w-\[8rem\] flex-1 text-xs font-mono"/, `${file}: the value keeps 8rem before it goes under the name`);
  }
});

test("the bar of the scene wraps instead of pushing the page sideways, and its menu button keeps its size", async () => {
  const page = await read("src/pages/ParagraphPage.tsx");
  assert.match(page, /<div className="flex min-w-0 flex-wrap items-center justify-end gap-2">\s*<Badge variant="outline" className="max-w-\[42vw\]/, "the buttons of the scene go to a second line at 768 px and 1280 px");
  const menu = classesNear(page, 'className="h-9 w-9');
  assert.match(menu, /\bshrink-0\b/, "the menu of the scene is never squeezed under 36 px");
});

test("small links and buttons met by the audit are at least 24 px, and 44 px under a finger", async () => {
  const outline = await read("src/pages/OutlinePage.tsx");
  const help = classesNear(outline, 'to="/app/docs/outline"');
  atLeast24(help, "How the Outline works");
  fingerSized(help, "How the Outline works");
  const card = await read("src/components/outline/OutlineEntryCard.tsx");
  atLeast24(classesNear(card, "status.written.slug"), "Chapter already written");
  const server = await read("src/components/settings/PersonalServerSettingsBody.tsx");
  for (const marker of ["href={LOCAL_ADMIN_URL}", "onClick={() => setShowManual((value) => !value)}"]) {
    const classes = classesNear(server, marker);
    atLeast24(classes, marker);
    fingerSized(classes, marker);
  }
  const settings = await read("src/pages/SettingsPage.tsx");
  for (const marker of ['{t("costs.mediaPricingTitle")}', '{t("costs.chatPricingTitle")}']) {
    const summary = /<summary className="([^"]*)">\{t\("costs\.(media|chat)PricingTitle"\)\}/g;
    assert.ok(settings.includes(marker));
    for (const match of settings.matchAll(summary)) assert.match(match[1], /(?<![:\w-])py-1\b/, `${match[2]} prices: the summary is at least 24 px tall`);
  }
  const sidebar = await read("src/components/layout/Sidebar.tsx");
  assert.match(classesNear(sidebar, 'to="/app/patch-notes"'), /(?<![:\w-])py-1\b/, "the version link is 24 px tall");
  assert.match(classesNear(sidebar, 'title={t("nav.collapseSidebar")}'), /\bshrink-0\b/, "the button that collapses the sidebar is not squeezed to 21 px");
});

test("rows of actions wrap at 320 px and a long word in a hint breaks instead of pushing the page sideways", async () => {
  const chats = await read("src/pages/AssistantChatsPage.tsx");
  assert.match(chats, /<div className="flex flex-wrap gap-2">\s*<input ref=\{importInputRef\}/, "Import and New go to the next line on a phone");
  const book = await read("src/pages/BookSettingsPage.tsx");
  assert.match(book, /<Button className="h-auto min-h-10 whitespace-normal text-left \[@media\(pointer:coarse\)\]:min-h-11" onClick=\{\(\) => void handleAttachToGitHub\(\)\}/, "Create or connect the repository wraps inside its button, and is 44 px tall under a finger");
  const settings = await read("src/pages/SettingsPage.tsx");
  assert.match(settings, /<div className="min-w-\[12rem\] flex-1 break-words">\s*<p className="text-sm font-medium">\{t\("settings\.chatModels"\)\}/, "chat_template_kwargs.reasoning_strength breaks at 320 px");
});

test("the top bar keeps its buttons on the screen with text at 200%: the name of the app and the status of the repository give up their room first", async () => {
  const topbar = await read("src/components/layout/Topbar.tsx");
  assert.match(topbar, /<div className="flex min-w-0 items-center gap-2 lg:hidden">/, "the group of the menu button can shrink");
  assert.match(topbar, /<span className="hidden min-w-0 truncate font-semibold min-\[360px\]:block">Narrarium<\/span>/, "the name of the app is cut before a button is");
  assert.match(topbar, /<span className="min-w-0 max-w-\[34vw\] truncate sm:max-w-none">\{visibleRepoStatus\.label\}<\/span>/, "the status of the repository is cut before a button is");
  for (const marker of ['aria-label={t("shell.openNav")}', 'aria-label={t("dossier.title")}']) assert.match(classesNear(topbar, marker), /\bshrink-0\b/, `${marker}: an icon button is never squeezed`);
  assert.match(topbar, /className="relative shrink-0 rounded-full"/, "the account button is never squeezed");
});

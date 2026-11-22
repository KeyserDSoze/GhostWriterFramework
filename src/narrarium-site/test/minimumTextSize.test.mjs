import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const SITE = new URL("../", import.meta.url);
const SRC = new URL("../src/", import.meta.url);

/** No text of the interface is smaller than the `text-xs` step of the scale (0.75rem = 12px). */
const MINIMUM_PX = 12;
const ROOT_PX = 16;

/**
 * Reasoned exceptions, for what is not readable text (a decorative glyph, a tick mark). Each entry names the file and the exact
 * utility, with the reason. There are none today: the former 9–11px labels, counters and badges were all moved to `text-xs`.
 *
 * @type {Array<{ file: string, text: string, reason: string }>}
 */
const EXCEPTIONS = [];

/** `10` → 10px, `0.7rem` → 11.2px, `9pt` → 12px. Relative `em`/`%` are measured against the 16px root, the most generous reading. */
function toPixels(value, unit) {
  const n = Number(value);
  if (unit === "px") return n;
  if (unit === "rem" || unit === "em") return n * ROOT_PX;
  if (unit === "pt") return (n * 4) / 3;
  if (unit === "%") return (n / 100) * ROOT_PX;
  return Number.NaN;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * Every font size below the minimum in one file: Tailwind arbitrary sizes (`text-[10px]`, also after variants and inside `@apply`),
 * `font-size:` declarations (CSS, `<style>`, style attributes) and style objects (`fontSize: 11`, `fontSize: "0.7rem"`).
 */
function smallText(file, text) {
  const found = [];
  const record = (index, snippet, px) => found.push({ file, line: lineOf(text, index), text: snippet, px });
  for (const match of text.matchAll(/(?<![\w[-])text-\[([\d.]+)(px|rem|em|pt|%)\]/g)) {
    const px = toPixels(match[1], match[2]);
    if (px < MINIMUM_PX) record(match.index, match[0], px);
  }
  for (const match of text.matchAll(/font-size\s*:\s*([\d.]+)(px|rem|em|pt|%)/gi)) {
    const px = toPixels(match[1], match[2]);
    if (px < MINIMUM_PX) record(match.index, match[0], px);
  }
  for (const match of text.matchAll(/\bfontSize\s*:\s*(?:([\d.]+)\b(?!\s*[*+/-])(?!\s*\w)|["'`]([\d.]+)(px|rem|em|pt|%)["'`])/g)) {
    const px = match[1] !== undefined ? Number(match[1]) : toPixels(match[2], match[3]);
    if (px < MINIMUM_PX) record(match.index, match[0], px);
  }
  return found;
}

async function filesOf(root, pattern) {
  const entries = await readdir(root, { recursive: true });
  return entries.filter((entry) => pattern.test(entry) && !entry.split(path.sep).includes("node_modules")).sort();
}

/** The sources whose text reaches the screen: the app, its stylesheet and the HTML shells. Generated documentation and translations carry prose, not styles. */
async function interfaceFiles() {
  const files = [];
  for (const entry of await filesOf(SRC, /\.(ts|tsx|css)$/)) {
    if (/(^|[\\/])generated-|(^|[\\/])i18n[\\/]locales[\\/]|\.d\.ts$/.test(entry)) continue;
    files.push({ name: `src/${entry.split(path.sep).join("/")}`, url: new URL(entry, SRC) });
  }
  for (const name of ["index.html", "msal-popup.html", "auth/microsoft-callback.html"]) files.push({ name, url: new URL(name, SITE) });
  for (const entry of await filesOf(new URL("public/", SITE), /\.(html|css)$/)) files.push({ name: `public/${entry}`, url: new URL(`public/${entry}`, SITE) });
  return files;
}

test("the scanner reads the shapes a small font size can take (so the scan below cannot pass by accident)", () => {
  const sizes = (source) => smallText("sample.tsx", source).map((hit) => hit.px);
  assert.deepEqual(sizes('<p className="text-[10px] font-semibold">'), [10]);
  assert.deepEqual(sizes('<p className="sm:text-[11px] hover:text-[9px]">'), [11, 9]);
  assert.deepEqual(sizes("@apply text-[0.7rem] leading-4;"), [11.2]);
  assert.deepEqual(sizes("font-size: 10px; font-size: 0.65rem"), [10, 10.4]);
  assert.deepEqual(sizes("style={{ fontSize: 11, fontSize: '0.7rem', fontSize: \"9px\" }}"), [11, 11.2, 9]);
  assert.deepEqual(sizes("<p className=\"text-xs text-[12px] text-[0.98rem] text-[#333] text-[length:var(--x)]\" style={{ fontSize: 12 }} />"), []);
  assert.deepEqual(sizes("fontSize: `${settings.reader.fontSize}px`, fontSize: settings.fontSize * 2"), []);
  assert.deepEqual(sizes("font-size: 1em; font-size: 0.75rem; font-size: 9pt"), []);
});

test("no text of the interface is smaller than 12px: no text-[Npx] below the scale, no font-size or fontSize below it", async () => {
  const files = await interfaceFiles();
  assert.ok(files.length > 200, `the scan should cover the whole app (saw ${files.length} files)`);
  const hits = [];
  for (const { name, url } of files) hits.push(...smallText(name, await readFile(url, "utf8")));
  const unexplained = hits.filter((hit) => !EXCEPTIONS.some((exception) => exception.file === hit.file && exception.text === hit.text));
  assert.deepEqual(
    unexplained.map((hit) => `${hit.file}:${hit.line} ${hit.text} (${hit.px}px)`),
    [],
    "replace with text-xs (12px), or add a reasoned exception for what is not readable text",
  );
});

test("every exception is documented and still needed", async () => {
  const hits = [];
  for (const { name, url } of await interfaceFiles()) hits.push(...smallText(name, await readFile(url, "utf8")));
  for (const exception of EXCEPTIONS) {
    assert.ok(exception.reason.trim().length > 20, `${exception.file}: the reason must explain why this is not readable text`);
    assert.ok(hits.some((hit) => hit.file === exception.file && hit.text === exception.text), `${exception.file}: ${exception.text} is no longer in the source, remove the exception`);
  }
});

test("the project scale has no step below 12px (tailwind.config.js adds no custom font size)", async () => {
  const config = (await import("../tailwind.config.js")).default;
  const sizes = { ...(config.theme?.fontSize ?? {}), ...(config.theme?.extend?.fontSize ?? {}) };
  for (const [name, value] of Object.entries(sizes)) {
    const size = Array.isArray(value) ? value[0] : value;
    const match = /^([\d.]+)(px|rem|em|pt)$/.exec(String(size));
    assert.ok(match, `fontSize.${name} should be a plain length`);
    assert.ok(toPixels(match[1], match[2]) >= MINIMUM_PX, `fontSize.${name} = ${size} is below ${MINIMUM_PX}px`);
  }
});

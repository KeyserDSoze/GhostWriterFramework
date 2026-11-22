import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const SRC = new URL("../src/", import.meta.url);
const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");

// ---------------------------------------------------------------------------------------------------------------------
// A tiny reader for the at-rules of the stylesheet: enough to find `@layer base { @media (...) { selector { declarations } } }`.
// ---------------------------------------------------------------------------------------------------------------------

function closingBrace(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The bodies of every at-rule whose prelude matches `prelude` (a regular expression source), nested ones included. */
function atRuleBodies(source, prelude) {
  const bodies = [];
  const pattern = new RegExp(`${prelude}\\s*\\{`, "g");
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const open = match.index + match[0].length - 1;
    const close = closingBrace(source, open);
    if (close < 0) break;
    bodies.push(source.slice(open + 1, close));
  }
  return bodies;
}

const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");
const REDUCE = "@media\\s*\\(\\s*prefers-reduced-motion\\s*:\\s*reduce\\s*\\)";

/** `{ selectors: [...], declarations: { "animation-duration": { value: "0.01ms", important: true } } }` for each flat rule of a body. */
function flatRules(body) {
  const rules = [];
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = {};
    for (const declaration of match[2].split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const value = declaration.slice(colon + 1).trim();
      declarations[declaration.slice(0, colon).trim()] = { value: value.replace(/\s*!important$/, ""), important: /!important$/.test(value) };
    }
    rules.push({ selectors: match[1].split(",").map((selector) => selector.trim().replace(/\s+/g, " ")), declarations });
  }
  return rules;
}

const milliseconds = (value) => (value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1000);

/** The global reduced-motion rules of `@layer base` (the media block may sit inside any of the base layers). */
function globalReducedMotionRules(source) {
  const rules = [];
  for (const layer of atRuleBodies(withoutComments(source), "@layer\\s+base")) {
    for (const body of atRuleBodies(layer, REDUCE)) rules.push(...flatRules(body));
  }
  return rules;
}

test("the stylesheet reads the way the helpers expect (sanity check of the tiny parser)", () => {
  const sample = "@layer base { @media (prefers-reduced-motion: reduce) { *, *::before { animation-duration: 0.01ms !important; scroll-behavior: auto !important } } .x { color: red } }";
  const [rule] = globalReducedMotionRules(sample);
  assert.deepEqual(rule.selectors, ["*", "*::before"]);
  assert.deepEqual(rule.declarations["animation-duration"], { value: "0.01ms", important: true });
  assert.equal(milliseconds("0.01ms"), 0.01);
  assert.equal(milliseconds("0s"), 0);
  assert.deepEqual(globalReducedMotionRules("@media (prefers-reduced-motion: reduce) { * { animation: none } }"), [], "a media block outside @layer base does not count");
});

/** The rule of `@layer base` that reaches every element (and its pseudo-elements) when motion is reduced. */
function everythingRule() {
  return globalReducedMotionRules(css).find((rule) => ["*", "*::before", "*::after"].every((selector) => rule.selectors.includes(selector)));
}

test("@layer base switches off animations, transitions and smooth scrolling for prefers-reduced-motion: reduce, on every element", () => {
  const everything = everythingRule();
  assert.ok(everything, "a rule for *, *::before and *::after inside @media (prefers-reduced-motion: reduce) inside @layer base");
  const { declarations } = everything;
  const problems = [];
  const need = (property, check, explanation) => {
    const declaration = declarations[property];
    if (!declaration) problems.push(`${property} is missing (${explanation})`);
    else if (!declaration.important) problems.push(`${property} must be !important, otherwise the utilities of the components win over it`);
    else if (!check(declaration.value)) problems.push(`${property}: ${declaration.value} (${explanation})`);
  };
  need("animation-duration", (value) => milliseconds(value) <= 1, "animations end at once, they are not removed: libraries that wait for animationend keep working");
  need("animation-iteration-count", (value) => value === "1", "no animation runs forever");
  need("transition-duration", (value) => milliseconds(value) <= 1, "transitions are practically instant");
  need("scroll-behavior", (value) => value === "auto", "no smooth scrolling");
  assert.deepEqual(problems, []);
});

test("nothing in the stylesheet or the components defeats the global rule with an !important animation or transition", async () => {
  // Every important animation/transition declaration of the stylesheet is one of those of the global rule.
  const important = [...withoutComments(css).matchAll(/(animation|transition)[\w-]*\s*:[^;}]*!important/g)].length;
  const ofTheGlobalRule = Object.entries(everythingRule()?.declarations ?? {}).filter(([property, declaration]) => /^(animation|transition)/.test(property) && declaration.important).length;
  assert.equal(important, ofTheGlobalRule, "an important animation/transition declaration outside the reduced-motion rule");
  const modifiers = [];
  for (const file of await sourceFiles()) {
    const text = await readFile(new URL(file, SRC), "utf8");
    for (const match of text.matchAll(/(?<![\w-])!(?:[\w-]+:)*(animate|transition|duration|delay|ease)-[\w[\]./-]*/g)) modifiers.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(modifiers, [], "Tailwind important modifiers on animation utilities");
});

async function sourceFiles() {
  const entries = await readdir(SRC, { recursive: true });
  return entries.filter((entry) => /\.(ts|tsx)$/.test(entry) && !/generated-|i18n[\\/]locales/.test(entry)).sort();
}

async function compile(classes) {
  const config = (await import("../tailwind.config.js")).default;
  const result = await postcss([tailwindcss({ ...config, content: [{ raw: classes.join(" "), extension: "html" }] })]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

test("every animate-* utility the components use is covered by the global rule: it exists, and the utilities compile to plain declarations it overrides, the endless ones included", async () => {
  assert.ok(everythingRule(), "the global reduced-motion rule is what covers the animate-* utilities");
  const used = new Set();
  for (const file of await sourceFiles()) {
    const text = await readFile(new URL(file, SRC), "utf8");
    for (const match of text.matchAll(/(?<![\w-])((?:[\w-]+(?:\[[^\]]*\])?:)*animate-[\w[\]./%-]+)/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 4, `the components use animations (saw ${[...used].join(", ")})`);
  const sheet = await compile([...used]);
  for (const name of ["animate-spin", "animate-pulse", "animate-ping"]) assert.ok(used.has(name) || [...used].some((item) => item.endsWith(`:${name}`)), `${name} is used by the components`);
  assert.match(sheet, /animation:[^;}]*infinite/, "the components do use endless animations");
  const declarations = [...sheet.matchAll(/animation[\w-]*\s*:[^;}]*/g)].map((match) => match[0]);
  assert.ok(declarations.length >= 3);
  for (const declaration of declarations) assert.doesNotMatch(declaration, /!important/, declaration);
});

test("no component hides a loading indicator when motion is reduced: the stopped spinner stays on screen as a still ring", async () => {
  const offenders = [];
  for (const file of await sourceFiles()) {
    const text = await readFile(new URL(file, SRC), "utf8");
    for (const match of text.matchAll(/motion-reduce:(hidden|invisible|sr-only|opacity-0)/g)) offenders.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(offenders, []);
});

test("programmatic smooth scrolling goes through the helper that honours the preference (CSS scroll-behavior does not reach it)", async () => {
  const offenders = [];
  for (const file of await sourceFiles()) {
    if (file === `lib${path.sep}motion.ts`) continue;
    const text = await readFile(new URL(file, SRC), "utf8");
    for (const match of text.matchAll(/behavior\s*:\s*["']smooth["']/g)) offenders.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(offenders, [], "use scrollBehavior() from @/lib/motion");
  const helper = await readFile(new URL("lib/motion.ts", SRC), "utf8");
  assert.match(helper, /export function scrollBehavior\(/);
  assert.match(helper, /prefers-reduced-motion: reduce/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import ts from "typescript";
import { read, sourceFiles, splitVariants, stringLiterals } from "./support/sources.mjs";

const require = createRequire(import.meta.url);
const palette = require("tailwindcss/colors");
const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");

// ---------------------------------------------------------------------------------------------------------------------
// WCAG 2.x maths. Colours are rounded to 8 bits exactly like the browser does when it paints (and when getComputedStyle reports them).
// ---------------------------------------------------------------------------------------------------------------------

function hslToRgb(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((value) => Math.round(value * 255));
}

function triplet(value) {
  const match = /^\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*$/.exec(value ?? "");
  if (!match) throw new Error(`"${value}" is not an "H S% L%" triplet`);
  return hslToRgb(Number(match[1]), Number(match[2]), Number(match[3]));
}

const hexToRgb = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
const channel = (value) => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function ratio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** `top` painted at `alpha` over the opaque `bottom` (Tailwind's `bg-x/15`). */
const over = (top, alpha, bottom) => top.map((value, index) => Math.round(value * alpha + bottom[index] * (1 - alpha)));

// ---------------------------------------------------------------------------------------------------------------------
// The tokens of both themes, read from the stylesheet.
// ---------------------------------------------------------------------------------------------------------------------

function readTokens(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const themes = { light: /** @type {Record<string, string>} */ ({}), dark: /** @type {Record<string, string>} */ ({}) };
  for (const [theme, selector] of [["light", ":root"], ["dark", ".dark"]]) {
    const block = new RegExp(`(?:^|[}\\s])${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "g");
    for (const match of clean.matchAll(block)) {
      for (const declaration of match[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) themes[theme][declaration[1]] = declaration[2].trim();
    }
  }
  return themes;
}

const tokens = readTokens(css);
const THEMES = /** @type {const} */ (["light", "dark"]);
const SURFACES = ["background", "card", "popover", "muted"];
const HOVER_SURFACES = ["secondary", "accent"];

/** Collects every failing pair so that one run names all of them, instead of stopping at the first. */
function checker() {
  const failures = [];
  const report = [];
  const colour = (theme, name) => {
    const value = tokens[theme][name];
    if (value !== undefined) return triplet(value);
    const note = `${theme}: --${name} is not defined`;
    if (!failures.includes(note)) failures.push(note);
    return null;
  };
  const expectRatio = (theme, label, foreground, background, minimum) => {
    if (!foreground || !background) return;
    const value = ratio(foreground, background);
    report.push({ theme, label, ratio: Math.round(value * 100) / 100, minimum });
    if (value < minimum) failures.push(`${theme}: ${label} = ${value.toFixed(2)}:1, needs at least ${minimum}:1`);
  };
  const tokenPair = (theme, foreground, background, minimum, note = "") =>
    expectRatio(theme, `--${foreground} on --${background}${note}`, colour(theme, foreground), colour(theme, background), minimum);
  return { failures, report, colour, expectRatio, tokenPair, done: () => assert.equal(failures.length, 0, `\n${failures.join("\n")}\n`) };
}

test("the contrast helpers agree with the published WCAG reference values", () => {
  assert.equal(Math.round(ratio([255, 255, 255], [0, 0, 0]) * 100) / 100, 21);
  assert.equal(Math.round(ratio(hexToRgb("#767676"), [255, 255, 255]) * 100) / 100, 4.54);
  assert.equal(Math.round(ratio(hexToRgb("#777777"), [255, 255, 255]) * 100) / 100, 4.48);
  assert.deepEqual(hslToRgb(0, 0, 100), [255, 255, 255]);
  assert.deepEqual(hslToRgb(0, 100, 50), [255, 0, 0]);
  assert.deepEqual(triplet("120 4% 40%"), [98, 106, 98]);
  assert.deepEqual(over([255, 0, 0], 0.5, [0, 0, 0]), [128, 0, 0]);
});

test("the light and the dark theme define the same colour tokens", () => {
  const missingInDark = Object.keys(tokens.light).filter((name) => name !== "radius" && !(name in tokens.dark));
  const missingInLight = Object.keys(tokens.dark).filter((name) => !(name in tokens.light));
  assert.deepEqual(missingInDark, [], "tokens of :root that .dark does not override");
  assert.deepEqual(missingInLight, [], "tokens of .dark that :root does not define");
});

test("body text, muted text and the labels of buttons reach WCAG AA on the surfaces they sit on (both themes)", () => {
  const c = checker();
  for (const theme of THEMES) {
    c.tokenPair(theme, "foreground", "background", 7);
    c.tokenPair(theme, "card-foreground", "card", 7);
    c.tokenPair(theme, "popover-foreground", "popover", 7);
    for (const surface of [...SURFACES, ...HOVER_SURFACES]) c.tokenPair(theme, "muted-foreground", surface, 4.5);
    c.tokenPair(theme, "primary-foreground", "primary", 4.5);
    c.tokenPair(theme, "accent-foreground", "accent", 4.5);
    c.tokenPair(theme, "secondary-foreground", "secondary", 4.5);
    c.tokenPair(theme, "destructive-foreground", "destructive", 4.5);
    // The text that stays on a button while the pointer is over it: `hover:bg-primary/90` and friends, painted over the page and over a card.
    /** @type {Array<[string, number]>} */
    const hovers = [["primary", 0.9], ["secondary", 0.8], ["destructive", 0.9]];
    for (const [token, alpha] of hovers) {
      const foreground = c.colour(theme, `${token}-foreground`);
      for (const surface of ["background", "card"]) {
        const base = c.colour(theme, token);
        const under = c.colour(theme, surface);
        if (base && under) c.expectRatio(theme, `--${token}-foreground on hover:bg-${token}/${Math.round(alpha * 100)} over --${surface}`, foreground, over(base, alpha, under), 4.5);
      }
    }
  }
  c.done();
});

test("destructive text (text-destructive) reaches 4.5:1 on every surface and on the tinted error boxes, in both themes", () => {
  const c = checker();
  for (const theme of THEMES) {
    for (const surface of [...SURFACES, ...HOVER_SURFACES]) c.tokenPair(theme, "destructive-text", surface, 4.5);
    // `border-destructive/40 bg-destructive/10 text-destructive` error panels (and the 5 % variant) over every surface.
    const text = c.colour(theme, "destructive-text");
    const tint = c.colour(theme, "destructive");
    for (const surface of SURFACES) {
      const under = c.colour(theme, surface);
      if (!text || !tint || !under) continue;
      for (const alpha of [0.05, 0.1]) c.expectRatio(theme, `--destructive-text on bg-destructive/${Math.round(alpha * 100)} over --${surface}`, text, over(tint, alpha, under), 4.5);
    }
  }
  c.done();
});

test("the destructive button (bg-destructive + text-destructive-foreground) is AA in both themes", () => {
  const c = checker();
  for (const theme of THEMES) c.tokenPair(theme, "destructive-foreground", "destructive", 4.5, " (button label)");
  c.done();
});

test("the outline of a form control reaches 3:1 against the page, the card, the popover and a muted panel (WCAG 1.4.11)", () => {
  const c = checker();
  for (const theme of THEMES) {
    // The same token outlines text fields and selects and paints the unchecked switch track.
    for (const surface of SURFACES) c.tokenPair(theme, "field", surface, 3, " (field outline, unchecked switch track)");
    assert.notEqual(tokens[theme].field, tokens[theme].border, `${theme}: --field has to be its own token, --border stays the soft divider`);
  }
  c.done();
});

test("the focus ring reaches 3:1 against the page, the card and the popover, and keeps its page-coloured gap around buttons", async () => {
  const c = checker();
  for (const theme of THEMES) for (const surface of ["background", "card", "popover"]) c.tokenPair(theme, "ring", surface, 3, " (focus ring)");
  c.done();
  // The ring is drawn 2px away from the control, with the page colour in the gap, so it stays visible around a primary or a destructive
  // button whatever their own colour is. Without the gap a primary button (ring and fill are the same teal) would show no ring at all.
  for (const file of ["button.tsx", "input.tsx", "textarea.tsx", "select.tsx", "switch.tsx", "tabs.tsx"]) {
    const source = await readFile(new URL(`../src/components/ui/${file}`, import.meta.url), "utf8");
    assert.match(source, /ring-offset-background/, `${file}: ring offset colour`);
    assert.match(source, /focus(-visible)?:ring-2/, `${file}: focus ring width`);
    assert.match(source, /focus(-visible)?:ring-ring/, `${file}: focus ring colour`);
    assert.match(source, /focus(-visible)?:ring-offset-2/, `${file}: focus ring gap`);
  }
  for (const theme of THEMES) {
    const ring = triplet(tokens[theme].ring);
    const page = triplet(tokens[theme].background);
    assert.ok(ratio(ring, page) >= 3, `${theme}: ring against the offset gap (--background)`);
  }
});

test("floating layers keep a visible edge in the dark theme: --layer reaches 3:1 against the page, the card and the popover", () => {
  const c = checker();
  for (const surface of ["background", "card", "popover"]) c.tokenPair("dark", "layer", surface, 3, " (edge of dock, dialog, menu, card)");
  c.colour("light", "layer");
  c.done();
});

// ---------------------------------------------------------------------------------------------------------------------
// Tailwind wiring: what the utilities of the components really compile to.
// ---------------------------------------------------------------------------------------------------------------------

async function compile(classes) {
  const config = (await import("../tailwind.config.js")).default;
  const result = await postcss([tailwindcss({ ...config, content: [{ raw: classes.join(" "), extension: "html" }] })]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

/** The declarations of the rule whose selector is `selector` (written the way it appears in the CSS, escapes included). */
function rule(sheet, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(sheet)?.[1] ?? "";
}

test("text-destructive uses --destructive-text while backgrounds and borders keep --destructive; the field and layer tokens are utilities", async () => {
  const sheet = await compile(["text-destructive", "hover:text-destructive", "text-destructive/50", "bg-destructive", "border-destructive", "border-destructive/40", "bg-destructive/10", "text-destructive-foreground", "border-field", "bg-field", "border-layer", "border-input"]);
  assert.match(rule(sheet, ".text-destructive"), /hsl\(var\(--destructive-text\)/);
  assert.match(rule(sheet, ".hover\\:text-destructive:hover"), /hsl\(var\(--destructive-text\)/);
  assert.match(rule(sheet, ".text-destructive\\/50"), /hsl\(var\(--destructive-text\) \/ 0\.5\)/);
  assert.match(rule(sheet, ".bg-destructive"), /hsl\(var\(--destructive\)\)/);
  assert.match(rule(sheet, ".border-destructive"), /hsl\(var\(--destructive\)\)/);
  assert.match(rule(sheet, ".border-destructive\\/40"), /hsl\(var\(--destructive\) \/ 0\.4\)/);
  assert.match(rule(sheet, ".bg-destructive\\/10"), /hsl\(var\(--destructive\) \/ 0\.1\)/);
  assert.match(rule(sheet, ".text-destructive-foreground"), /hsl\(var\(--destructive-foreground\)\)/);
  assert.match(rule(sheet, ".border-field"), /hsl\(var\(--field\)\)/);
  assert.match(rule(sheet, ".bg-field"), /hsl\(var\(--field\)\)/);
  assert.match(rule(sheet, ".border-layer"), /hsl\(var\(--layer\)\)/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Which components draw their outline with the field token.
// ---------------------------------------------------------------------------------------------------------------------

test("input, textarea, select and the switch track draw their outline with the field token, not with the soft decorative border", async () => {
  for (const file of ["input.tsx", "textarea.tsx", "select.tsx", "auto-textarea.tsx"]) {
    const source = await read(`src/components/ui/${file}`);
    assert.match(source, /\bborder-field\b/, `${file}: outline`);
    assert.doesNotMatch(source, /\bborder-input\b/, `${file}: still uses the soft border-input`);
  }
  const switchSource = await read("src/components/ui/switch.tsx");
  assert.match(switchSource, /data-\[state=unchecked\]:bg-field/, "unchecked switch track");
  assert.doesNotMatch(switchSource, /bg-input/, "switch track must not use the soft --input fill");
  const login = await read("src/components/auth/LoginScreen.tsx");
  assert.doesNotMatch(login, /\bborder-input\b/, "LoginScreen checkbox");
});

/** Raw form controls written by hand (outside components/ui) that draw a border must use the field token too. */
test("every hand-written input or textarea that draws a border uses the field outline", async () => {
  const offenders = [];
  for (const file of await sourceFiles()) {
    if (!file.endsWith(".tsx") || file.startsWith(`components${path.sep}ui${path.sep}`)) continue;
    const text = await read(`src/${file}`);
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sourceFile);
        if (tag === "input" || tag === "textarea" || tag === "select") {
          const attributes = Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute).map((attribute) => [attribute.name.getText(sourceFile), attribute.initializer?.getText(sourceFile) ?? ""]));
          const type = /["'](\w+)["']/.exec(attributes.type ?? "")?.[1] ?? "text";
          if (!["checkbox", "radio", "file", "hidden", "range", "submit", "button", "color"].includes(type)) {
            const tokensOfClass = (attributes.className ?? "").split(/[\s"'`{}]+/);
            if (tokensOfClass.includes("border") && !tokensOfClass.includes("border-field")) {
              offenders.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1} <${tag}> draws a plain border`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  assert.deepEqual(offenders, []);
  // The search box of the dossier is a bordered wrapper around a borderless input.
  assert.match(await read("src/components/layout/DossierDock.tsx"), /rounded-lg border border-field bg-background/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Status pills, badges and coloured text in the components, in both themes.
// ---------------------------------------------------------------------------------------------------------------------

const FAMILIES = new Set(["slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"]);
const SEMANTIC = new Set(["background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "destructive", "destructive-foreground"]);
const TEXT_SIZE = /^(xs|sm|base|lg|xl|[2-9]xl|\[[\d.]+(px|rem|em)\])$/;
const FILL_TEXT = new Set(["primary-foreground", "secondary-foreground", "accent-foreground", "destructive-foreground"]);

/** A colour utility of the shapes the project writes (`bg-amber-500/15`, `text-muted-foreground`, `text-white`); anything else gives null. */
function parseColourUtility(utility) {
  const arbitrary = /^!?(bg|text)-\[#([0-9a-fA-F]{6})\](?:\/(\d{1,3}))?$/.exec(utility);
  if (arbitrary) return { kind: arbitrary[1], name: `#${arbitrary[2]}`, shade: undefined, alpha: arbitrary[3] === undefined ? 1 : Number(arbitrary[3]) / 100, rgb: hexToRgb(`#${arbitrary[2]}`) };
  const match = /^!?(bg|text)-([a-z]+(?:-foreground)?)(?:-(\d{2,3}))?(?:\/(\d{1,3}))?$/.exec(utility);
  if (!match) return null;
  const [, kind, name, shade, alpha] = match;
  const isWhiteOrBlack = name === "white" || name === "black";
  if (!isWhiteOrBlack && !SEMANTIC.has(name) && !(FAMILIES.has(name) && shade)) return null;
  return { kind, name, shade, alpha: alpha === undefined ? 1 : Number(alpha) / 100 };
}

function resolveColour(parsed, theme) {
  const { kind, name, shade } = parsed;
  if (parsed.rgb) return parsed.rgb;
  if (name === "white") return [255, 255, 255];
  if (name === "black") return [0, 0, 0];
  if (shade) return hexToRgb(palette[name][shade]);
  // Mirrors tailwind.config.js: text-destructive reads --destructive-text, every other destructive utility reads --destructive.
  const token = kind === "text" && name === "destructive" ? "destructive-text" : name;
  const value = tokens[theme][token];
  return value === undefined ? null : triplet(value);
}

/** What a class list says about its own text and background colour, per theme (only the base and `dark:` variants count). */
function analyseClassList(list) {
  const slots = { base: { bg: null, text: null }, dark: { bg: null, text: null } };
  let textSize = false;
  let width = false;
  let height = false;
  for (const token of list.split(/\s+/).filter(Boolean)) {
    const { variants, utility } = splitVariants(token);
    if (variants.length === 0) {
      if (/^text-/.test(utility) && TEXT_SIZE.test(utility.slice(5))) textSize = true;
      if (/^(w|size)-\d/.test(utility)) width = true;
      if (/^(h|size)-\d/.test(utility)) height = true;
    }
    const slot = variants.length === 0 ? slots.base : variants.length === 1 && variants[0] === "dark" ? slots.dark : null;
    if (!slot) continue;
    const parsed = parseColourUtility(utility);
    if (parsed) slot[parsed.kind] = parsed;
  }
  return { slots, icon: width && height && !textSize };
}

/** The contrast failures of one class list: `[{ theme, text, background, ratio, minimum }]`. */
function classListFailures(list) {
  const { slots, icon } = analyseClassList(list);
  const failures = [];
  for (const theme of THEMES) {
    const text = (theme === "dark" ? slots.dark.text ?? slots.base.text : slots.base.text);
    const background = (theme === "dark" ? slots.dark.bg ?? slots.base.bg : slots.base.bg);
    if (!text) continue;
    // The text colour of a coloured fill (primary-foreground, white…) is only meaningful on that fill; when the fill is painted by a parent
    // element the class list alone cannot tell what it sits on.
    if (!background && (FILL_TEXT.has(text.name) || text.name === "white" || text.name === "black")) continue;
    const textColour = resolveColour(text, theme);
    if (!textColour) continue;
    let surfaces;
    if (background) {
      const fill = resolveColour(background, theme);
      if (!fill) continue;
      surfaces = background.alpha >= 1 ? [fill] : SURFACES.map((surface) => over(fill, background.alpha, triplet(tokens[theme][surface])));
    } else {
      surfaces = SURFACES.map((surface) => triplet(tokens[theme][surface]));
    }
    const minimum = icon ? 3 : 4.5;
    const worst = Math.min(...surfaces.map((surface) => ratio(text.alpha < 1 ? over(textColour, text.alpha, surface) : textColour, surface)));
    if (worst < minimum) {
      const label = (parsed) => `${parsed.name}${parsed.shade ? `-${parsed.shade}` : ""}${parsed.alpha < 1 ? `/${Math.round(parsed.alpha * 100)}` : ""}`;
      failures.push({ theme, text: label(text), background: background ? label(background) : "the page", ratio: Math.round(worst * 100) / 100, minimum });
    }
  }
  return failures;
}

const classLists = () => stringLiterals(/\b(?:bg|text)-[a-z]/);

test("the class-list analyser flags low contrast pairs and accepts good ones (so the scan below cannot pass by accident)", () => {
  const themesOf = (list) => classListFailures(list).map((failure) => failure.theme);
  assert.deepEqual(themesOf("rounded-full bg-amber-500/15 px-2 text-xs text-amber-700 dark:text-amber-300"), ["light"]);
  assert.deepEqual(themesOf("rounded-full bg-amber-500/15 px-2 text-xs text-amber-800 dark:text-amber-300"), []);
  assert.deepEqual(themesOf("h-4 w-4 text-amber-600"), ["light"], "an icon needs 3:1: amber-600 has 2.7:1 on the page");
  assert.deepEqual(themesOf("h-4 w-4 text-emerald-700 dark:text-emerald-300"), []);
  assert.deepEqual(themesOf("hover:text-red-100 md:text-red-50 data-[state=open]:text-red-50"), [], "only the base and dark: variants are checked");
  assert.deepEqual(themesOf("h-9 w-9 text-primary-foreground"), [], "the label colour of a fill painted by a parent cannot be judged from the class list");
  assert.deepEqual(themesOf("w-full bg-[#0078d4] text-white hover:bg-[#106ebe]"), [], "arbitrary hex fills are read");
  assert.deepEqual(themesOf("w-full bg-[#9ec9f5] text-white"), ["light", "dark"]);
  assert.deepEqual(themesOf("text-sm text-muted-foreground/50"), ["light", "dark"], "alpha text is composited over the surface");
  assert.deepEqual(splitVariants("dark:hover:bg-[#fff]/10"), { variants: ["dark", "hover"], utility: "bg-[#fff]/10" });
  assert.deepEqual(splitVariants("data-[state=open]:bg-accent"), { variants: ["data-[state=open]"], utility: "bg-accent" });
});

test("coloured pills, badges and status text keep 4.5:1 (3:1 for icons) on their own background in both themes", async () => {
  const lists = await classLists();
  const withText = lists.filter(({ list }) => analyseClassList(list).slots.base.text || analyseClassList(list).slots.dark.text);
  const pairs = lists.filter(({ list }) => {
    const { slots } = analyseClassList(list);
    return (slots.base.bg || slots.dark.bg) && (slots.base.text || slots.dark.text);
  });
  assert.ok(withText.length > 300, `the scan should see the colour utilities of the whole site (saw ${withText.length} class lists with a text colour)`);
  assert.ok(pairs.length > 30, `the scan should see the tinted pills of the site (saw ${pairs.length} with a background and a text colour)`);
  const failures = [];
  for (const { file, line, list } of withText) {
    for (const failure of classListFailures(list)) {
      failures.push(`${file}:${line} [${failure.theme}] ${failure.text} on ${failure.background} = ${failure.ratio}:1 (needs ${failure.minimum}:1) in "${list.length > 90 ? `${list.slice(0, 90)}…` : list}"`);
    }
  }
  assert.equal(failures.length, 0, `\n${failures.join("\n")}\n`);
});

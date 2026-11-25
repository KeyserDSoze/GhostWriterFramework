import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Brainstorming's accent (`.brainstorm-accent` in src/index.css) replaces the primary colour and the focus ring of what it wraps: the launcher's
// pill, the button of the Synopsis page and the whole panel in that mode (its header, the author's bubbles, the buttons, the rings). It must keep the
// contrast WCAG 2.2 AA asks of the theme's own primary, in both themes.

const css = (await readFile(new URL("../src/index.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");

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
  assert.ok(match, `"${value}" is an "H S% L%" triplet`);
  return hslToRgb(Number(match[1]), Number(match[2]), Number(match[3]));
}

const channel = (value) => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

function block(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, `src/index.css has ${selector}`);
  return Object.fromEntries([...match[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((declaration) => [declaration[1], declaration[2].trim()]));
}

const themes = {
  light: { base: block(":root"), accent: block(".brainstorm-accent") },
  dark: { base: { ...block(":root"), ...block(".dark") }, accent: block(".dark .brainstorm-accent") },
};

for (const [theme, { base, accent }] of Object.entries(themes)) {
  test(`the accent of Brainstorming keeps the contrast of the primary colour (${theme})`, () => {
    for (const name of ["primary", "primary-foreground", "ring"]) assert.ok(accent[name], `${theme}: --${name} is set by the accent`);
    const primary = triplet(accent.primary);
    const label = ratio(triplet(accent["primary-foreground"]), primary);
    assert.ok(label >= 4.5, `${theme}: a label on the accent is ${label.toFixed(2)}:1`);
    for (const surface of ["background", "card", "popover"]) {
      const text = ratio(primary, triplet(base[surface]));
      assert.ok(text >= 4.5, `${theme}: the accent as text on --${surface} is ${text.toFixed(2)}:1`);
      const ring = ratio(triplet(accent.ring), triplet(base[surface]));
      assert.ok(ring >= 3, `${theme}: the focus ring on --${surface} is ${ring.toFixed(2)}:1`);
    }
    assert.notEqual(accent.primary, base.primary, `${theme}: the accent is not the theme's own primary`);
  });
}

test("the accent is an orange: the colour of Brainstorming, not of the Copilot", () => {
  for (const { accent } of Object.values(themes)) {
    const hue = Number(/^\s*([\d.]+)/.exec(accent.primary)[1]);
    assert.ok(hue >= 10 && hue <= 35, `hue ${hue}`);
  }
});

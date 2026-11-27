import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

// What the specs of the review share for looking at a page the way a person does: pictures of it at the two sizes that matter (a phone, a desktop) in both themes, and the contrast of a text.

const SIZES = [{ width: 390, height: 844, label: "390x844" }, { width: 1280, height: 800, label: "1280x800" }] as const;

/**
 * A picture of the page at 390x844 and at 1280x800, light and dark, in the folder `NARRARIUM_SHOTS` names (nothing is taken, and nothing is written, when it is not set). The theme is the
 * `dark` class of the page, which the theme provider of the app toggles; the page goes back to the size and the theme it had.
 * `prepare` runs at each size, once the page is laid out for it (to open or scroll what the picture is about).
 */
export async function capture(page: Page, name: string, options: { prepare?: (size: { width: number; height: number }) => Promise<void> } = {}): Promise<void> {
  const folder = process.env.NARRARIUM_SHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  const before = page.viewportSize();
  const wasDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await options.prepare?.(size);
    for (const scheme of ["light", "dark"] as const) {
      await setTheme(page, scheme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${folder}/${name}-${size.label}-${scheme}.png` });
    }
  }
  await setTheme(page, wasDark ? "dark" : "light");
  if (before) await page.setViewportSize(before);
}

/**
 * The contrast ratio (WCAG 2.x) between the colour of a text and what it is drawn on, as the browser paints it: the background is the first one under the text that is not clear,
 * with the transparency of the ones in between worked out. 4.5 is the least for text of normal size.
 */
export function contrast(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    type Color = { r: number; g: number; b: number; a: number };
    const parse = (value: string): Color => {
      const found = /rgba?\(([^)]+)\)/.exec(value);
      if (!found) return { r: 0, g: 0, b: 0, a: 0 };
      const [r, g, b, a] = found[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a: a === undefined || Number.isNaN(a) ? 1 : a };
    };
    const over = (top: Color, bottom: Color): Color => {
      const a = top.a + bottom.a * (1 - top.a);
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
      const mix = (front: number, back: number) => (front * top.a + back * bottom.a * (1 - top.a)) / a;
      return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
    };
    const layers: Color[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) layers.push(parse(getComputedStyle(node).backgroundColor));
    let background: Color = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) background = over(layer, background);
    const style = getComputedStyle(element);
    const opacity = (() => {
      let value = 1;
      for (let node: Element | null = element; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
      return value;
    })();
    const text = over({ ...parse(style.color), a: parse(style.color).a * opacity }, background);
    const luminance = (color: Color) => {
      const channel = (value: number) => {
        const unit = value / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    };
    const [lighter, darker] = [luminance(text), luminance(background)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
  });
}

/**
 * Sets the theme of the page, as the toggle of the app does: its `dark` class. The colours of the page change at once, with no transition: what is measured or photographed after it
 * is the theme, and not a colour on its way to it.
 */
export async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((dark) => {
    if (!document.getElementById("e2e-no-transitions")) {
      const style = document.createElement("style");
      style.id = "e2e-no-transitions";
      style.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
      document.head.append(style);
    }
    document.documentElement.classList.toggle("dark", dark);
  }, theme === "dark");
}

/** How far the content of an element reaches beyond its box on the right: more than zero is a sideways scroll. */
export function horizontalOverflow(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.scrollWidth - element.clientWidth);
}

/**
 * The elements inside `container` that reach beyond its right edge, as «tag.class (Npx past)»: it says which one makes a screen too wide. What sits in a box that scrolls or clips by itself (a
 * table in its own scrolling region) is left out: it is meant to reach further.
 */
export function overflowing(container: Locator): Promise<string[]> {
  return container.evaluate((root) => {
    const edge = root.getBoundingClientRect().right;
    const found: string[] = [];
    for (const element of Array.from(root.querySelectorAll("*"))) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.right <= edge + 1) continue;
      let own = false;
      for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowX;
        if (overflow === "auto" || overflow === "scroll" || overflow === "hidden") own = true;
      }
      if (own) continue;
      const name = typeof element.className === "string" && element.className ? `.${element.className.split(/\s+/).slice(0, 3).join(".")}` : "";
      found.push(`${element.tagName.toLowerCase()}${name} (${Math.round(box.right - edge)}px past)`);
    }
    return found.slice(0, 12);
  });
}

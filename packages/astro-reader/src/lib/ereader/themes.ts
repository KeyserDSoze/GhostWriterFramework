/**
 * The colors and fonts of the reader. The shell writes them as CSS custom properties from this table, and a test checks every pair the
 * page uses against WCAG 2.2 AA (4.5:1 for text, 3:1 for the parts of the interface and the focus ring).
 */

export interface ReaderPalette {
  /** The page. */
  bg: string;
  /** The bars and the dialogs. */
  surface: string;
  text: string;
  /** Secondary text (numbers, dates, hints). */
  muted: string;
  /** Links and the selected options. */
  accent: string;
  /** Text on the accent (the selected option, the main button). */
  onAccent: string;
  /** Lines that separate (decorative). */
  rule: string;
  /** The edge of a field or of an unselected option: it must be seen (3:1). */
  control: string;
  focus: string;
  /** A highlight, and the text on it. */
  mark: string;
  markText: string;
}

export const READER_PALETTES: Record<"light" | "sepia" | "dark", ReaderPalette> = {
  light: {
    bg: "#fbfaf7",
    surface: "#f1eee7",
    text: "#1d1b18",
    muted: "#55504a",
    accent: "#7a3f0c",
    onAccent: "#ffffff",
    rule: "#d9d3c8",
    control: "#77706a",
    focus: "#1a56c4",
    mark: "#fbe38e",
    markText: "#1d1b18",
  },
  sepia: {
    bg: "#f4ecd8",
    surface: "#eadfc4",
    text: "#3a2e1f",
    muted: "#5e4d36",
    accent: "#7a3f0c",
    onAccent: "#ffffff",
    rule: "#d8c9a6",
    control: "#7d6a50",
    focus: "#1b4fae",
    mark: "#f2cf72",
    markText: "#2e2416",
  },
  dark: {
    bg: "#141311",
    surface: "#1f1d1a",
    text: "#e8e2d6",
    muted: "#b2aa9b",
    accent: "#e9ad6b",
    onAccent: "#1a1206",
    rule: "#3a3631",
    control: "#8c8476",
    focus: "#8fb4ff",
    mark: "#5c4a14",
    markText: "#fbf4e4",
  },
};

export const READER_FONTS: Record<"serif" | "classic" | "sans" | "readable", string> = {
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
  classic: 'Baskerville, "Baskerville Old Face", "Hoefler Text", Garamond, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  readable: 'Verdana, "Atkinson Hyperlegible", Tahoma, "DejaVu Sans", sans-serif',
};

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`«${hex}» is not #rrggbb`);
  const [r, g, b] = match.slice(1).map((part) => channel(parseInt(part, 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colors. */
export function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (light + 0.05) / (dark + 0.05);
}

/** The CSS of the three themes: `[data-theme=...]` on the root, and `auto` following the device. */
export function paletteCss(): string {
  const variables = (palette: ReaderPalette) =>
    Object.entries(palette).map(([name, value]) => `--er-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value};`).join("");
  return [
    `:root,:root[data-theme="light"]{${variables(READER_PALETTES.light)}color-scheme:light;}`,
    `:root[data-theme="sepia"]{${variables(READER_PALETTES.sepia)}color-scheme:light;}`,
    `:root[data-theme="dark"]{${variables(READER_PALETTES.dark)}color-scheme:dark;}`,
    `@media (prefers-color-scheme: dark){:root[data-theme="auto"]{${variables(READER_PALETTES.dark)}color-scheme:dark;}}`,
  ].join("\n");
}

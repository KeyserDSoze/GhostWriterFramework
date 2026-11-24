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
export declare const READER_PALETTES: Record<"light" | "sepia" | "dark", ReaderPalette>;
export declare const READER_FONTS: Record<"serif" | "classic" | "sans" | "readable", string>;
/** WCAG relative luminance of `#rrggbb`. */
export declare function luminance(hex: string): number;
/** WCAG contrast ratio of two colors. */
export declare function contrastRatio(foreground: string, background: string): number;
/** The CSS of the three themes: `[data-theme=...]` on the root, and `auto` following the device. */
export declare function paletteCss(): string;
//# sourceMappingURL=themes.d.ts.map
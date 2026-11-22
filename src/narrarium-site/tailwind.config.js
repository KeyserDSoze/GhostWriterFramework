import { fileURLToPath } from "url";
import path from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    path.join(__dirname, "./src/**/*.{ts,tsx}"),
    `!${path.join(__dirname, "./src/lib/generated-docs.ts")}`,
    path.join(__dirname, "./index.html"),
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        // Outline of text fields, selects and switch tracks: 3:1 against the page (WCAG 1.4.11). --border and --input stay decorative.
        field: "hsl(var(--field))",
        // Edge of the surfaces that float over the page: clearly visible in the dark theme, the soft border in the light one.
        layer: "hsl(var(--layer))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      // `text-destructive` is red TEXT: it reads --destructive-text (readable on the page in both themes).
      // `bg-destructive`, `border-destructive` and the tints (`bg-destructive/10`) keep reading --destructive, the fill of the button.
      textColor: {
        destructive: { DEFAULT: "hsl(var(--destructive-text))" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
};

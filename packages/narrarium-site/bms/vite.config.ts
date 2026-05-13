import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

// BMS_BASE env lets GitHub Actions override at build time.
// Default to /bms/ for production (served from narrarium.net/bms/).
// Use / locally.
const bmsBase =
  process.env.NODE_ENV === "production"
    ? (process.env.BMS_BASE ?? "/bms/")
    : "/";

export default defineConfig({
  root: path.resolve(__dirname),
  base: bmsBase,
  plugins: [react()],
  css: {
    postcss: {
      plugins: [
        tailwindcss({ config: path.resolve(__dirname, "tailwind.config.js") }),
        autoprefixer(),
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../public/bms"),
    emptyOutDir: true,
  },
});

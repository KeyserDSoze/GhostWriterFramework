import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { createRequire } from "module";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

const require = createRequire(import.meta.url);
const pkg = require("./package.json") as { version: string };

const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const siteBase =
  process.env.SITE_BASE ??
  process.env.DOCS_BASE ??
  (process.env.GITHUB_ACTIONS === "true" && repoName ? `/${repoName}/` : "/");

export default defineConfig({
  root: path.resolve(__dirname),
  base: siteBase,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});

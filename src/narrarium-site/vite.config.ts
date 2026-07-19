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
  plugins: [
    react(),
    {
      name: "narrarium-version-manifest",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: `${JSON.stringify({ version: pkg.version })}\n`,
        });
      },
    },
  ],
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
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("react-router-dom") || id.includes("@remix-run") || id.includes("react") || id.includes("scheduler")) {
            return "framework-vendor";
          }
          if (id.includes("@azure/msal") || id.includes("@react-oauth/google")) return "auth-vendor";
          if (id.includes("@octokit")) return "github-vendor";
          if (id.includes("pdfjs-dist")) return "pdf-vendor";
          if (id.includes("jszip")) return "zip-vendor";
          if (id.includes("mammoth")) return "docx-vendor";
          if (id.includes("openai") || id.includes("@azure/openai")) return "ai-vendor";
          if (id.includes("marked")) return "docs-vendor";
          return undefined;
        },
      },
    },
  },
});

import { defineConfig } from "astro/config";
import chokidar from "chokidar";
import { defaultBookRoot } from "./scripts/book-config.mjs";
import { formatWatchedPath, resolveBookRoot, resolveBookWatchTargets } from "./scripts/book-dev-utils.mjs";
import { narrariumReaderOutput } from "./scripts/reader-output.mjs";

const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const BOOK_GENERATION = Symbol.for("narrarium.bookGeneration");
const base = process.env.SITE_BASE ?? (process.env.GITHUB_ACTIONS === "true" && repoName ? `/${repoName}/` : "/");
const site = process.env.SITE_URL;

function narrariumBookReloadPlugin() {
  return {
    name: "narrarium-book-reload",
    configureServer(server) {
      const bookRoot = resolveBookRoot(defaultBookRoot);
      // The reader's build (src/lib/reader-build.ts) is rebuilt when this number changes: together with the cleared route cache below,
      // so that version.json never names a bundle the server does not know yet.
      globalThis[BOOK_GENERATION] = 0;
      const watchTargets = resolveBookWatchTargets(bookRoot);
      let reloadTimer = null;
      const watcher = chokidar.watch(watchTargets, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 150,
          pollInterval: 50,
        },
      });

      const queueReload = (eventName, filePath) => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          server.config.logger.info(`[narrarium-reader] Reloading after ${eventName} ${formatWatchedPath(filePath, bookRoot)}`);
          globalThis[BOOK_GENERATION] = (globalThis[BOOK_GENERATION] ?? 0) + 1;
          // The pages' getStaticPaths() are cached by the dev server: a new chapter, or the new name of the reader's bundle, needs them again.
          for (const [name, environment] of Object.entries(server.environments ?? {})) {
            if (name !== "client") environment.hot?.send?.("astro:content-changed", {});
          }
          server.ws.send({ type: "full-reload" });
        }, 120);
      };

      watcher.on("all", (eventName, filePath) => {
        queueReload(eventName, filePath);
      });

      server.config.logger.info(`[narrarium-reader] Hot reload watching ${bookRoot}`);

      server.httpServer?.once("close", () => {
        clearTimeout(reloadTimer);
        void watcher.close();
      });
    },
  };
}

/** The book watcher of `astro dev` only: `astro build` starts a Vite server of its own too, and must not watch the book. */
function narrariumBookReload() {
  return {
    name: "narrarium-book-reload",
    hooks: {
      "astro:config:setup": ({ command, updateConfig }) => {
        if (command === "dev") updateConfig({ vite: { plugins: [narrariumBookReloadPlugin()] } });
      },
    },
  };
}

export default defineConfig({
  output: "static",
  site,
  base,
  trailingSlash: "always",
  integrations: [narrariumBookReload(), narrariumReaderOutput()],
});

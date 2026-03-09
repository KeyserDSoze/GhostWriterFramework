import { defineConfig } from "astro/config";
import chokidar from "chokidar";
import { defaultBookRoot } from "./scripts/book-config.mjs";
import { formatWatchedPath, resolveBookRoot, resolveBookWatchTargets } from "./scripts/book-dev-utils.mjs";

const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.SITE_BASE ?? (process.env.GITHUB_ACTIONS === "true" && repoName ? `/${repoName}/` : "/");
const site = process.env.SITE_URL;

function narrariumBookReloadPlugin() {
  return {
    name: "narrarium-book-reload",
    configureServer(server) {
      const bookRoot = resolveBookRoot(defaultBookRoot);
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

export default defineConfig({
  output: "static",
  site,
  base,
  trailingSlash: "always",
  vite: {
    plugins: [narrariumBookReloadPlugin()],
  },
});

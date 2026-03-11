import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import chokidar from "chokidar";
import { defaultBookRoot } from "./book-config.mjs";
import { exportReaderEpub, formatWatchedPath, resolveBookRoot, resolveBookWatchTargets } from "./book-dev-utils.mjs";

const require = createRequire(import.meta.url);
const astroCliPath = resolveAstroCliPath();
const bookRoot = resolveBookRoot(defaultBookRoot);
const watchTargets = resolveBookWatchTargets(bookRoot);

let queuedReason = null;
let debounceTimer = null;
let exportInFlight = false;
let shuttingDown = false;

await runExport("startup");

const watcher = chokidar.watch(watchTargets, {
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 150,
    pollInterval: 50,
  },
});

watcher.on("all", (eventName, filePath) => {
  const action = describeEvent(eventName);
  queueExport(`${action} ${formatWatchedPath(filePath, bookRoot)}`);
});

console.log(`[narrarium-reader] Watching book files in ${bookRoot}`);

const astroProcess = spawn(process.execPath, [astroCliPath, "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

astroProcess.on("exit", async (code, signal) => {
  await closeWatcher();
  if (signal) {
    process.exit(0);
  }
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(debounceTimer);
    await closeWatcher();
    astroProcess.kill(signal);
  });
}

function queueExport(reason) {
  queuedReason = reason;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void flushQueuedExport();
  }, 120);
}

async function flushQueuedExport() {
  if (!queuedReason || exportInFlight) {
    return;
  }

  const reason = queuedReason;
  queuedReason = null;
  await runExport(reason);

  if (queuedReason) {
    await flushQueuedExport();
  }
}

async function runExport(reason) {
  exportInFlight = true;
  try {
    const { result, validation } = await exportReaderEpub(defaultBookRoot);
    if (result.skipped) {
      console.log(`[narrarium-reader] ${validation.detail}`);
    } else if (reason === "startup") {
      console.log(`[narrarium-reader] Exported EPUB with ${result.chapterCount} chapters to ${result.outputPath}`);
    } else {
      console.log(`[narrarium-reader] Updated EPUB after ${reason}`);
    }

    if (validation.status === "passed") {
      console.log(`[narrarium-reader] ${validation.detail}`);
    } else if (validation.status === "failed") {
      console.error(`[narrarium-reader] ${validation.detail}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[narrarium-reader] EPUB export failed: ${message}`);
  } finally {
    exportInFlight = false;
  }
}

async function closeWatcher() {
  await watcher.close().catch(() => undefined);
}

function describeEvent(eventName) {
  switch (eventName) {
    case "add":
      return "added";
    case "addDir":
      return "created";
    case "change":
      return "saved";
    case "unlink":
      return "removed";
    case "unlinkDir":
      return "deleted";
    default:
      return eventName;
  }
}

function resolveAstroCliPath() {
  const astroPackageJsonPath = require.resolve("astro/package.json");
  const astroPackageJson = require(astroPackageJsonPath);
  const astroBin = typeof astroPackageJson.bin === "string" ? astroPackageJson.bin : astroPackageJson.bin?.astro;

  if (!astroBin) {
    throw new Error("Could not resolve Astro CLI entry from astro/package.json");
  }

  return path.join(path.dirname(astroPackageJsonPath), astroBin);
}

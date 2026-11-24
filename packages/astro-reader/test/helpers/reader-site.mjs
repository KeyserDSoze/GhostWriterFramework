import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChapter, createCharacterProfile, createParagraph, initializeBookRepo } from "narrarium";

/** Helpers of the tests that build a real reader site with Astro and open it in a browser. */

export const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
/** Astro moves its assets with rename(): the output must be on the package's own file system, not in os.tmpdir(). */
export const outputRoot = path.join(packageRoot, ".test-output");

const require = createRequire(import.meta.url);
const astroPackage = require.resolve("astro/package.json");
const astroBin = path.join(path.dirname(astroPackage), require(astroPackage).bin.astro ?? require(astroPackage).bin);

/** Sentences and names that must never be in clear in a protected build. */
export const MARKERS = {
  firstScene: "QUAYMARKER the lanterns of the quay burned green and nobody looked up.",
  secondScene: "TIDEMARKER the tide went out at noon and did not come back.",
  thirdScene: "GATEMARKER Lyra counted the bells and found one too many.",
  chapterTitles: ["Lanterns Over Water", "The Long Tide"],
  sceneTitles: ["The Quay At Dusk", "Low Water", "The Ninth Bell"],
  character: "Ottoline Varga",
};

export async function createSampleBook(root, { title = "The Glass Harbor", language = "en", extraParagraphs = 6 } = {}) {
  await initializeBookRepo(root, { title, language, author: "Ada Byron" });
  await createChapter(root, { number: 1, title: MARKERS.chapterTitles[0] });
  const filler = Array.from({ length: extraParagraphs }, (_, index) => `Paragraph ${index + 1}: the harbor kept its own counsel, and the gulls wrote nothing down. The rope smelled of tar and of the years it had held.`).join("\n\n");
  await createParagraph(root, { chapter: "001-lanterns-over-water", number: 1, title: MARKERS.sceneTitles[0], body: `${MARKERS.firstScene}\n\n${filler}` });
  await createParagraph(root, { chapter: "001-lanterns-over-water", number: 2, title: MARKERS.sceneTitles[1], body: `${MARKERS.secondScene}\n\n${filler}` });
  await createChapter(root, { number: 2, title: MARKERS.chapterTitles[1] });
  await createParagraph(root, { chapter: "002-the-long-tide", number: 1, title: MARKERS.sceneTitles[2], body: `${MARKERS.thirdScene}\n\n${filler}` });
  await createCharacterProfile(root, { name: MARKERS.character, roleTier: "supporting", storyRole: "ally", speakingStyle: "Dry.", backgroundSummary: "Keeps the harbor's ledgers.", functionInBook: "Witness." });
  return root;
}

/** `astro build` of the package's reader for `bookRoot`, in a process of its own, with exactly the variables given. */
export async function buildReaderSite({ bookRoot, name, base = "/glass-harbor/", env = {} }) {
  const outDir = path.join(outputRoot, name);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/^(READER_PASSWORD_SECRETS|NARRARIUM_READER_|GITHUB_)/.test(key)) delete childEnv[key];
  }
  Object.assign(childEnv, { NARRARIUM_BOOK_ROOT: bookRoot, SITE_BASE: base, NARRARIUM_READER_BOOK_ID: "test-book", ASTRO_TELEMETRY_DISABLED: "1" }, env);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [astroBin, "build", "--outDir", outDir], { cwd: packageRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output, outDir }));
  });
}

/**
 * `astro dev` of the package's reader for `bookRoot`, in the foreground (`--ignore-lock`: Astro would otherwise send it to the background
 * when it thinks an agent runs it), on a free port. Resolves once version.json answers.
 */
export async function startDevServer({ bookRoot, env = {} }) {
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/^(READER_PASSWORD_SECRETS|NARRARIUM_READER_|GITHUB_)/.test(key)) delete childEnv[key];
  }
  // Polling: a small temporary book, and machines whose inotify watchers run out.
  Object.assign(childEnv, { NARRARIUM_BOOK_ROOT: bookRoot, SITE_BASE: "/", NARRARIUM_READER_BOOK_ID: "test-book", ASTRO_TELEMETRY_DISABLED: "1", CHOKIDAR_USEPOLLING: "1" }, env);
  const child = spawn(process.execPath, [astroBin, "dev", "--port", String(port), "--host", "127.0.0.1", "--ignore-lock"], { cwd: packageRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`astro dev exited:\n${output}`);
    const ok = await fetch(`${url}version.json`).then((response) => response.ok, () => false);
    if (ok) break;
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(`astro dev did not answer in time:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    url,
    output: () => output,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }),
  };
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".bin": "application/octet-stream",
  ".epub": "application/epub+zip",
  ".png": "image/png",
};

/**
 * A static server like GitHub Pages for a project site (`/glass-harbor/...`, `max-age=600` on everything). The site it serves can be swapped
 * (a new publication), and the shell can come from another build than the rest (an HTML a cache kept).
 */
export async function serveSite(base = "/glass-harbor/") {
  let siteDir = null;
  let shellDir = null;
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push(`${url.pathname}${url.search}`);
    if (!url.pathname.startsWith(base) || !siteDir) {
      response.writeHead(404).end();
      return;
    }
    let relative = decodeURIComponent(url.pathname.slice(base.length));
    if (relative === "" || relative.endsWith("/")) relative += "index.html";
    const root = relative === "index.html" && shellDir ? shellDir : siteDir;
    const file = path.join(root, relative);
    if (!file.startsWith(root)) {
      response.writeHead(403).end();
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "max-age=600" });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}${base}`,
    requests,
    publish(dir) {
      siteDir = dir;
      shellDir = null;
    },
    /** Serve the HTML of `oldDir` with everything else from the current site. */
    keepShellFrom(oldDir) {
      shellDir = oldDir;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Chromium from Playwright, or null when it is not installed here (the test then says so and skips). */
export async function launchChromium() {
  try {
    const { chromium } = await import("@playwright/test");
    return await chromium.launch();
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

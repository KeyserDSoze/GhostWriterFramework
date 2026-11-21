// Bundles the CLI and the server process (with the shared engine) into self-contained files:
// the published package has no runtime dependencies, so one signed tarball is all that runs.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL(".", import.meta.url));
rmSync(new URL("./dist", import.meta.url), { recursive: true, force: true });
// CommonJS dependencies (yaml) call require() for Node built-ins: give the ESM bundle a real one.
const requireShim = "import { createRequire as __narrariumCreateRequire } from \"node:module\"; const require = __narrariumCreateRequire(import.meta.url);";
const common = { absWorkingDir: root, bundle: true, platform: "node", target: "node22", format: "esm", sourcesContent: false, legalComments: "none", logLevel: "warning", banner: { js: requireShim } };
await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/server.mjs", sourcemap: true });
await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/cli.mjs", sourcemap: true, banner: { js: `#!/usr/bin/env node\n${requireShim}` } });
await build({ ...common, entryPoints: ["src/testing.ts"], outfile: "dist/testing.mjs" });

import path from "node:path";
import { installOutboundNetwork } from "./network.js";
import { SUPERVISED_ENV, defaultDataRoot } from "./runtime-install.js";
import { startNarrariumServer, type RunningNarrariumServer } from "./server.js";
import { SERVER_VERSION } from "./version.js";

/** Server process: `node server.mjs --data-root DIR [--verbose]`, normally started by the supervisor. */
const args = process.argv.slice(2);
let dataRoot: string | undefined;
let verbose = false;
let valid = true;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--data-root" && args[index + 1] && !args[index + 1].startsWith("--")) dataRoot = path.resolve(args[++index]);
  else if (args[index] === "--verbose") verbose = true;
  else valid = false;
}

if (!valid || !dataRoot) {
  process.stderr.write("Usage: node server.mjs --data-root DIRECTORY [--verbose]\n");
  process.exitCode = 2;
} else {
  let server: RunningNarrariumServer | undefined;
  let restoreNetwork: (() => void) | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await server?.close();
    } finally {
      restoreNetwork?.();
    }
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  try {
    server = await startNarrariumServer({
      dataDir: dataRoot,
      log: (line) => {
        if (verbose || line.startsWith("Error") || line.startsWith("Admin error") || line.startsWith("Update") || line.startsWith("The data folder")) process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
      },
    });
    restoreNetwork = installOutboundNetwork(server.allowedBases);
    const rootFlag = path.resolve(defaultDataRoot()) === dataRoot ? "" : ` --data-root "${dataRoot}"`;
    const lines = [
      `Narrarium personal server ${SERVER_VERSION}${process.env[SUPERVISED_ENV] === "1" ? " (supervised)" : ""}`,
      `  API:          ${server.url}`,
      `  Admin panel:  ${server.adminUrl}`,
      `  Data folder:  ${server.data.root}`,
      "",
      `  Admin code:   npx narrarium-server admin-code${rootFlag}   (stored in ${server.auth.adminCodePath})`,
      "  Connect Narrarium: Settings → Personal server → Pair, then approve the request in the admin panel.",
      "  Press Ctrl+C to stop. Running autopilots pause and resume from their last saved step.",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  } catch (error) {
    process.stderr.write(`The server could not start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    await stop();
  }
}

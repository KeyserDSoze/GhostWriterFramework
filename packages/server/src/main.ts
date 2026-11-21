import path from "node:path";
import { installOutboundNetwork } from "./network.js";
import { resolveDataRoot } from "./data-root.js";
import { SUPERVISED_ENV } from "./runtime-install.js";
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
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      try {
        await server?.close();
      } finally {
        restoreNetwork?.();
      }
    })();
    return stopped;
  };
  // A closed terminal (SIGHUP) and Ctrl+Break (Windows) end the server as cleanly as Ctrl+C does: nothing it started is left running.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.once(signal, () => void stop());

  /** One line on stderr: when, what, and a few frames of the stack; never anything from a request. */
  const report = (kind: string, reason: unknown) => {
    const detail = reason instanceof Error
      ? `${reason.name}: ${reason.message.slice(0, 500)}\n${(reason.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 5).join("\n")}`.trimEnd()
      : String(reason).slice(0, 500);
    process.stderr.write(`[${new Date().toISOString()}] ${kind}: ${detail}\n`);
  };
  // A request that fails must never end the process: an unhandled rejection is reported and the server keeps serving.
  process.on("unhandledRejection", (reason) => report("Unhandled rejection", reason));
  // An uncaught exception leaves the process in an unknown state: stop cleanly, then exit (after five seconds at the latest).
  let crashing = false;
  process.on("uncaughtException", (error) => {
    report("Uncaught exception", error);
    if (crashing) return;
    crashing = true;
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 5000).unref();
    void stop().catch(() => undefined).finally(() => process.exit(1));
  });
  try {
    server = await startNarrariumServer({
      dataDir: dataRoot,
      // Without its lock this server may be one of two on the same folder: it has stopped, and the process ends with an error, so that
      // a supervisor or a service manager starts a server that takes the lock again (or reports that another one has it).
      onLockLost: () => {
        process.exitCode = 1;
        void stop().catch(() => undefined).finally(() => process.exit(1));
      },
      log: (line) => {
        if (verbose || line.startsWith("Error") || line.startsWith("Admin error") || line.startsWith("Update") || line.startsWith("The data folder")) process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
      },
    });
    restoreNetwork = installOutboundNetwork(server.allowedBases);
    const rootFlag = path.resolve(resolveDataRoot()) === dataRoot ? "" : ` --data-root "${dataRoot}"`;
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

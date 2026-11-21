#!/usr/bin/env node
import { access, constants } from "node:fs/promises";
import net from "node:net";
import { DEFAULT_SERVER_PORT, ENGINE_VERSION } from "narrarium-engine";
import { DataDirectory, defaultDataDirectory } from "./config.js";
import { gitVersion } from "./git.js";
import { startNarrariumServer } from "./server.js";
import { SERVER_VERSION } from "./version.js";

interface ParsedArguments {
  command: string[];
  flags: Map<string, string[]>;
}

function parseArguments(argv: string[]): ParsedArguments {
  const command: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      const [name, inline] = value.slice(2).split("=", 2);
      const next = inline ?? (argv[index + 1] && !argv[index + 1].startsWith("-") ? argv[++index] : "true");
      flags.set(name, [...(flags.get(name) ?? []), next]);
    } else if (value === "-h" || value === "-v") {
      flags.set(value === "-h" ? "help" : "version", ["true"]);
    } else {
      command.push(value);
    }
  }
  return { command, flags };
}

function flag(parsed: ParsedArguments, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1);
}

const HELP = `Narrarium personal server ${SERVER_VERSION}

Runs the Narrarium autopilot and the director for your books on this computer,
even with the browser closed, and keeps them in sync with the web app.

Usage:
  npx narrarium-server [start] [options]     Start the server (default command)
  npx narrarium-server token create [--label NAME]
                                             Create a client token for a browser or device
  npx narrarium-server token list            List client tokens
  npx narrarium-server token revoke ID       Revoke a client token
  npx narrarium-server status                Show configuration, books and whether it runs
  npx narrarium-server doctor                Check Node.js, git, data folder and port

Options:
  --port N          Port to listen on (default ${DEFAULT_SERVER_PORT})
  --host ADDRESS    Address to bind (default 127.0.0.1; use 0.0.0.0 only behind a trusted network)
  --data DIR        Data folder (default ~/.narrarium-server or NARRARIUM_SERVER_HOME)
  --origin URL      Allow another web origin to call the server (repeatable)
  --allow-host HOST Accept this Host header, e.g. a tunnel hostname (repeatable)
  --label NAME      Name shown in Narrarium for this server
  --verbose         Log every request
  -h, --help        Show this help
  -v, --version     Show the version
`;

function dataDirectory(parsed: ParsedArguments): DataDirectory {
  return new DataDirectory(flag(parsed, "data") ?? defaultDataDirectory());
}

async function start(parsed: ParsedArguments): Promise<void> {
  const port = flag(parsed, "port") ? Number(flag(parsed, "port")) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error("--port must be a number between 0 and 65535.");
  const verbose = parsed.flags.has("verbose");
  const server = await startNarrariumServer({
    dataDir: flag(parsed, "data"),
    port,
    host: flag(parsed, "host"),
    label: flag(parsed, "label"),
    origins: parsed.flags.get("origin"),
    allowHosts: parsed.flags.get("allow-host"),
    log: (line) => {
      if (verbose || line.startsWith("Error") || line.startsWith("Book")) console.log(`[${new Date().toISOString()}] ${line}`);
    },
  });
  const git = await gitVersion();
  const lines = [
    `Narrarium personal server ${SERVER_VERSION} (engine ${ENGINE_VERSION})`,
    `  Address: ${server.url}`,
    `  Name:    ${server.config.label}`,
    `  Data:    ${server.data.root}`,
    `  Git:     ${git ? `${git} — GitHub books enabled` : "not found — only local books (install git to host GitHub books)"}`,
    `  Books:   ${server.books.all().length}`,
  ];
  if (server.initialToken) {
    lines.push("", "  Client token (shown only once, keep it private):", `    ${server.initialToken}`, "", "  Create more with: npx narrarium-server token create --label \"my laptop\"");
  }
  lines.push("", "  In Narrarium open Settings → Personal server, paste the address and a client token.", "  Press Ctrl+C to stop. Running autopilots pause and resume from their last saved step.");
  console.log(lines.join("\n"));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping: pausing running autopilots…");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

async function token(parsed: ParsedArguments): Promise<void> {
  const data = dataDirectory(parsed);
  await data.ensure();
  const action = parsed.command[1] ?? "list";
  if (action === "create") {
    const created = await data.createToken(flag(parsed, "label") ?? "client");
    console.log(`Token ${created.id} created. Copy it now, it is not shown again:\n\n  ${created.token}\n`);
    return;
  }
  if (action === "list") {
    const tokens = await data.tokens();
    if (!tokens.length) console.log("No client tokens. Create one with: npx narrarium-server token create");
    for (const entry of tokens) console.log(`${entry.id}  ${entry.label}  created ${entry.createdAt}`);
    return;
  }
  if (action === "revoke") {
    const id = parsed.command[2];
    if (!id) throw new Error("Usage: npx narrarium-server token revoke ID");
    console.log(await data.revokeToken(id) ? `Token ${id} revoked.` : `No token with id ${id}.`);
    return;
  }
  throw new Error(`Unknown token command: ${action}`);
}

async function probe(port: number): Promise<{ running: boolean; label?: string; version?: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/info`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { running: false };
    const info = await response.json() as { label?: string; serverVersion?: string };
    return { running: true, label: info.label, version: info.serverVersion };
  } catch {
    return { running: false };
  }
}

async function status(parsed: ParsedArguments): Promise<void> {
  const data = dataDirectory(parsed);
  const config = await data.readJson<{ port?: number; label?: string; host?: string } | null>("config.json", null);
  const port = Number(flag(parsed, "port") ?? config?.port ?? DEFAULT_SERVER_PORT);
  const running = await probe(port);
  const books = await data.books();
  const ai = await data.aiConfig();
  console.log([
    `Data:    ${data.root}`,
    `Server:  ${running.running ? `running on port ${port} (${running.label}, ${running.version})` : `not running on port ${port}`}`,
    `Tokens:  ${(await data.tokens()).length}`,
    `AI:      ${ai.config.aiIntegrations.length ? `${ai.config.aiIntegrations.length} integration(s), sent ${ai.updatedAt}` : "not configured yet (send it from Narrarium)"}`,
    `Books:   ${books.length}`,
    ...books.map((book) => `  - ${book.title} [${book.storage.kind === "github" ? `${book.storage.owner}/${book.storage.repo}@${book.storage.branch}` : "local"}]`),
  ].join("\n"));
}

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer().once("error", () => resolve(false)).once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, host);
  });
}

async function doctor(parsed: ParsedArguments): Promise<void> {
  const data = dataDirectory(parsed);
  const port = Number(flag(parsed, "port") ?? DEFAULT_SERVER_PORT);
  const major = Number(process.versions.node.split(".")[0]);
  const git = await gitVersion();
  let writable = true;
  try {
    await data.ensure();
    await access(data.root, constants.W_OK);
  } catch {
    writable = false;
  }
  const running = await probe(port);
  const free = running.running || await portFree(port, "127.0.0.1");
  const checks: Array<[boolean, string]> = [
    [major >= 20, `Node.js ${process.versions.node} (20 or newer required)`],
    [Boolean(git), git ? `${git}` : "git not found: only local books can be hosted"],
    [writable, `Data folder ${data.root} ${writable ? "is writable" : "is not writable"}`],
    [free, running.running ? `Port ${port} is used by this server` : free ? `Port ${port} is free` : `Port ${port} is used by another program: start with --port`],
  ];
  for (const [ok, message] of checks) console.log(`${ok ? "✓" : "✗"} ${message}`);
  if (checks.some(([ok]) => !ok)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.flags.has("version") || parsed.command[0] === "version") {
    console.log(SERVER_VERSION);
    return;
  }
  if (parsed.flags.has("help") || parsed.command[0] === "help") {
    console.log(HELP);
    return;
  }
  const command = parsed.command[0] ?? "start";
  if (command === "start") return start(parsed);
  if (command === "token" || command === "tokens") return token(parsed);
  if (command === "status") return status(parsed);
  if (command === "doctor") return doctor(parsed);
  throw new Error(`Unknown command: ${command}. Run npx narrarium-server --help`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

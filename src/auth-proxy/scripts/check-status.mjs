#!/usr/bin/env node
// Prints, in words, which sign-in providers the live Worker has configured, from its
// GET /oauth/status answer (booleans only: no secret is read or printed).
//
//   node check-status.mjs [<worker url>] [--worker-name <name>] [--lang it|en] [--strict]
//
// The Worker URL is the argument. Only without one, the fallback is the environment variable
// WORKER_BASE_URL or VITE_GITHUB_MODELS_BASE, then `gh variable get VITE_GITHUB_MODELS_BASE`
// (the repository variable still points to the OLD Worker until the owner switches it, so pass
// the new URL, or --worker-name auth-proxy to point a *.workers.dev fallback at that Worker).
// Exit status: 0 the Worker answered, 1 it could not be read, 2 (with --strict) it answered but at
// least one provider is not configured, 64 usage error.

import { execFileSync } from "node:child_process";
import { describeStatus, fetchOAuthStatus, normalizeBaseUrl, retargetWorkerName } from "./oauth-status.mjs";

const MESSAGES = {
  it: {
    usage: "Uso: node check-status.mjs [<url del Worker>] [--worker-name <nome>] [--lang it|en] [--strict]",
    noUrl: "Non so l'indirizzo del Worker: passalo come argomento oppure imposta la variabile del repository VITE_GITHUB_MODELS_BASE (gh variable set VITE_GITHUB_MODELS_BASE).",
    checking: (url) => `Controllo ${url}/oauth/status ...`,
    unreachable: (reason) => `Non riesco a leggere lo stato: ${reason}. Il Worker potrebbe non essere ancora pubblicato; riprova tra qualche secondo.`,
    allOk: "Tutto configurato.",
    someMissing: "Alcuni accessi non sono ancora configurati: segui le indicazioni sopra.",
  },
  en: {
    usage: "Usage: node check-status.mjs [<worker url>] [--worker-name <name>] [--lang it|en] [--strict]",
    noUrl: "The Worker address is unknown: pass it as an argument or set the repository variable VITE_GITHUB_MODELS_BASE (gh variable set VITE_GITHUB_MODELS_BASE).",
    checking: (url) => `Checking ${url}/oauth/status ...`,
    unreachable: (reason) => `Could not read the status: ${reason}. The Worker may not be published yet; try again in a few seconds.`,
    allOk: "Everything is configured.",
    someMissing: "Some sign-in providers are not configured yet: follow the hints above.",
  },
};

function parseArguments(argv) {
  const options = { language: "it", strict: false, url: undefined, workerName: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") options.strict = true;
    else if (argument === "--lang") options.language = argv[(index += 1)];
    else if (argument.startsWith("--lang=")) options.language = argument.slice("--lang=".length);
    else if (argument === "--worker-name") options.workerName = argv[(index += 1)];
    else if (argument.startsWith("--worker-name=")) options.workerName = argument.slice("--worker-name=".length);
    else if (argument.startsWith("-")) return null;
    else if (options.url === undefined) options.url = argument;
    else return null;
  }
  if (options.workerName !== undefined && retargetWorkerName("https://x.y.workers.dev", options.workerName) === null) return null;
  return options.language in MESSAGES ? options : null;
}

function discoverUrl(argument) {
  const candidates = [argument, process.env.WORKER_BASE_URL, process.env.VITE_GITHUB_MODELS_BASE];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim() !== "") return normalizeBaseUrl(candidate);
  }
  try {
    const output = execFileSync("gh", ["variable", "get", "VITE_GITHUB_MODELS_BASE"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
    return normalizeBaseUrl(output);
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error(MESSAGES.it.usage);
    return 64;
  }
  const text = MESSAGES[options.language];
  let baseUrl = discoverUrl(options.url);
  // --worker-name only retargets a fallback (the repository variable); an explicit URL is used as given.
  if (baseUrl && options.workerName !== undefined && options.url === undefined) baseUrl = retargetWorkerName(baseUrl, options.workerName);
  if (!baseUrl) {
    console.error(text.noUrl);
    return 64;
  }

  console.log(text.checking(baseUrl));
  const result = await fetchOAuthStatus(baseUrl, {
    attempts: Number(process.env.OAUTH_STATUS_ATTEMPTS) || 3,
    delayMs: Number(process.env.OAUTH_STATUS_DELAY_MS ?? 3000),
  });
  if (!result.ok) {
    console.error(text.unreachable(result.reason));
    return 1;
  }

  const rows = describeStatus(result.flags, { language: options.language });
  for (const row of rows) {
    const mark = row.state === "configured" ? "OK " : row.state === "unknown" ? "?  " : "-- ";
    console.log(`${mark}${row.provider.label}: ${row.label}${row.state === "configured" ? "" : `. ${row.action}`}`);
  }
  const allConfigured = rows.every((row) => row.state === "configured");
  console.log(allConfigured ? text.allOk : text.someMissing);
  return options.strict && !allConfigured ? 2 : 0;
}

process.exitCode = await main();

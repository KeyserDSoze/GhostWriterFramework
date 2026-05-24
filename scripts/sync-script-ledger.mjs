#!/usr/bin/env node

import path from "node:path";
import { syncScriptLedger } from "../packages/core/dist/index.js";

const args = process.argv.slice(2);
const helpRequested = args.includes("--help") || args.includes("-h");
const failOnError = args.includes("--fail-on-error");
const failOnWarning = args.includes("--fail-on-warning");
const rootArg = args.find((arg) => !arg.startsWith("-"));

if (helpRequested) {
  console.log([
    "Usage: npm run sync:script-ledger -- [book-root] [--fail-on-error] [--fail-on-warning]",
    "",
    "Regenerates state/script-ledger.md from scripts/**/*.md without calling an AI.",
    "If book-root is omitted, the current working directory is used.",
  ].join("\n"));
  process.exit(0);
}

const rootPath = path.resolve(rootArg ?? process.cwd());
const result = await syncScriptLedger(rootPath);

console.log(`Script ledger synced at ${result.filePath}.`);
console.log(`Checks: ${result.errorCount} errors, ${result.warningCount} warnings.`);

if (result.ledger.checks.length > 0) {
  console.log("");
  console.log("Issues:");
  for (const check of result.ledger.checks) {
    const location = `${check.path}${check.line ? `:${check.line}` : ""}`;
    console.log(`- ${check.severity} ${check.code} ${location}: ${check.message}`);
  }
}

if ((failOnError && result.errorCount > 0) || (failOnWarning && (result.errorCount > 0 || result.warningCount > 0))) {
  process.exit(1);
}

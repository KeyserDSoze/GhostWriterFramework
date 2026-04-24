#!/usr/bin/env node
// Thin wrapper that invokes the Python manuscript builder.
// If Python is not installed it prints a friendly warning and exits cleanly.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "build_manuscript.py");

function findPython() {
  for (const cmd of ["python3", "python"]) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "pipe" });
      return cmd;
    } catch { /* not found, try next */ }
  }
  return null;
}

const py = findPython();
if (!py) {
  console.warn("");
  console.warn("[WARNING] Python is not installed or not in PATH.");
  console.warn("  Manuscript export requires Python 3 and the python-docx package.");
  console.warn("  Install Python from https://www.python.org/downloads/");
  console.warn("  Then run:  pip install -r scripts/requirements-manuscript.txt");
  console.warn("");
  process.exit(1);
}

// Forward remaining CLI args to the Python script.
const args = [script, "--book-root", ".", ...process.argv.slice(2)];
try {
  execFileSync(py, args, { stdio: "inherit" });
} catch (err) {
  process.exit(err.status ?? 1);
}

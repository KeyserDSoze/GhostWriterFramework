import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { exportEpub } from "narrarium";
import { loadReaderEnvFiles } from "./env-loader.mjs";

loadReaderEnvFiles();

const watchPatterns = [
  "book.md",
  "guidelines/**/*",
  "chapters/**/*",
  "characters/**/*",
  "locations/**/*",
  "factions/**/*",
  "items/**/*",
  "secrets/**/*",
  "timeline/**/*",
  "resumes/**/*",
  "evaluations/**/*",
  "research/**/*",
  "assets/**/*",
  "AGENTS.md",
  "opencode.jsonc",
  ".opencode/**/*",
  ".claude/**/*",
];

export function resolveBookRoot(defaultBookRoot, cwd = process.cwd()) {
  const configured = readBookRootEnv();
  return path.resolve(cwd, configured ?? defaultBookRoot);
}

export function resolveBookWatchTargets(bookRoot) {
  return watchPatterns.map((pattern) => path.join(bookRoot, pattern));
}

export function formatWatchedPath(filePath, basePath) {
  const relative = path.relative(basePath, filePath);
  const target = relative && !relative.startsWith("..") ? relative : filePath;
  return toPosix(target);
}

export async function exportReaderEpub(defaultBookRoot, cwd = process.cwd()) {
  const bookRoot = resolveBookRoot(defaultBookRoot, cwd);
  const outputPath = path.resolve(cwd, "public", "downloads", "book.epub");

  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await exportEpub(bookRoot, { outputPath });
  const validation = await runOptionalEpubCheck(result.outputPath);

  return {
    bookRoot,
    outputPath,
    result,
    validation,
  };
}

export async function runOptionalEpubCheck(outputPath) {
  const jarPath = process.env.EPUBCHECK_JAR;
  const explicitCommand = process.env.EPUBCHECK_CMD;

  if (jarPath) {
    return runCommand("java", ["-jar", jarPath, outputPath]);
  }

  if (explicitCommand) {
    return runCommand(explicitCommand, [outputPath]);
  }

  return {
    status: "skipped",
    detail: "EPUBCheck not configured. Set EPUBCHECK_JAR or EPUBCHECK_CMD to validate EPUB output.",
  };
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (error) => {
      resolve({
        status: "skipped",
        detail: `EPUBCheck could not start: ${error.message}`,
      });
    });
    child.on("close", (code) => {
      const detail = `${stdout.join("")}${stderr.join("")}`.trim();
      resolve({
        status: code === 0 ? "passed" : "failed",
        detail: detail || (code === 0 ? "EPUBCheck passed." : `EPUBCheck failed with exit code ${code}.`),
      });
    });
  });
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function readBookRootEnv() {
  for (const key of ["NARRARIUM_BOOK_ROOT", "GHOSTWRITER_BOOK_ROOT"]) {
    const value = normalizeEnvValue(process.env[key]);
    if (value && !isClearlyInvalidBookRootValue(value)) {
      return value;
    }
  }

  return undefined;
}

function normalizeEnvValue(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim() || undefined;
  }

  return trimmed;
}

function isClearlyInvalidBookRootValue(value) {
  return value === "/" || value === "\\" || /^[a-zA-Z]:(?:[\\/])?$/.test(value);
}

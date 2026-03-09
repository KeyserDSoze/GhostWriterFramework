#!/usr/bin/env node

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { scaffoldReaderSite } from "./scaffold.js";

type ParsedArgs = {
  targetDir?: string;
  bookRoot?: string;
  packageName?: string;
  coreDependency?: string;
  pagesDomain?: string;
};

const args = parseArgs(process.argv.slice(2));
const resolved = await resolveInputs(args);
const result = await scaffoldReaderSite(resolved.targetDir, {
  bookRoot: resolved.bookRoot,
  packageName: resolved.packageName,
  coreDependency: resolved.coreDependency,
  pagesDomain: resolved.pagesDomain,
});

output.write(
  [
    `Narrarium reader scaffolded at ${result.targetRoot}`,
    `Book root default: ${result.bookRoot}`,
    `Core dependency: ${result.coreDependency}`,
    "",
    "Next steps:",
    `- cd ${result.targetRoot}`,
    "- npm install",
    "- copy .env.example to .env if you want a local override",
    "- npm run dev",
  ].join("\n"),
);

async function resolveInputs(args: ParsedArgs) {
  if (args.targetDir) {
    return {
      targetDir: args.targetDir,
      bookRoot: args.bookRoot ?? "..",
      packageName: args.packageName,
      coreDependency: args.coreDependency,
      pagesDomain: args.pagesDomain,
    };
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error("Missing target directory. Use narrarium-reader-init <target-dir> [--book-root <path>] [--package-name <name>] [--pages-domain <domain>].");
  }

  const rl = createInterface({ input, output });
  try {
    const targetDir = (await rl.question("Reader folder [reader]: ")) || "reader";
    const bookRoot = (await rl.question("Book root relative to reader [. . becomes ..] [..]: ")) || "..";
    const packageName = (await rl.question("Package name (optional): ")) || undefined;
    const coreDependency = (await rl.question("Core dependency [published latest compatible]: ")) || undefined;
    const pagesDomain = (await rl.question("GitHub Pages custom domain (optional): ")) || undefined;
    return { targetDir, bookRoot, packageName, coreDependency, pagesDomain };
  } finally {
    rl.close();
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("-")) {
      if (!parsed.targetDir) parsed.targetDir = token;
      continue;
    }

    switch (token) {
      case "--book-root":
        parsed.bookRoot = argv[++index];
        break;
      case "--package-name":
        parsed.packageName = argv[++index];
        break;
      case "--core-dependency":
        parsed.coreDependency = argv[++index];
        break;
      case "--pages-domain":
        parsed.pagesDomain = argv[++index];
        break;
      default:
        break;
    }
  }

  return parsed;
}

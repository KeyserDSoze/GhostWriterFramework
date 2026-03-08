#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  createChapter,
  createCharacterProfile,
  createParagraph,
  initializeBookRepo,
  syncChapterEvaluation,
  syncChapterResume,
  syncTotalResume,
} from "@ghostwriter/core";

type ParsedArgs = {
  targetDir?: string;
  title?: string;
  author?: string;
  language?: string;
  sample?: boolean;
  withReader?: boolean;
  readerDir?: string;
};

const args = parseArgs(process.argv.slice(2));
const resolved = await resolveInputs(args);
const targetPath = path.resolve(process.cwd(), resolved.targetDir);

await initializeBookRepo(targetPath, {
  title: resolved.title,
  author: resolved.author || undefined,
  language: resolved.language,
  createSkills: true,
});

let readerPath = "";

if (resolved.withReader) {
  const readerDir = path.join(targetPath, resolved.readerDir);
  const readerBookRoot = path.relative(readerDir, targetPath) || ".";
  readerPath = await runReaderScaffold(readerDir, readerBookRoot, `${slugifyForPackage(resolved.title)}-reader`);
}

if (resolved.sample) {
  await createCharacterProfile(targetPath, {
    name: "Lyra Vale",
    roleTier: "main",
    storyRole: "protagonist",
    speakingStyle: "Measured, observant, and precise. She rarely wastes words and often hides emotion behind controlled language.",
    backgroundSummary: "Raised around trade routes and political intrigue, Lyra learned early how to read rooms, hide motives, and survive by listening harder than everyone else.",
    functionInBook: "Primary viewpoint anchor for the opening movement and the reader's first sustained window into the world.",
    age: 29,
    occupation: "Broker of information",
    origin: "Gray Harbor",
    firstImpression: "Competent, composed, and hard to read.",
    traits: ["observant", "guarded", "adaptable"],
    desires: ["protect her leverage", "learn the truth behind the missing archive"],
    fears: ["becoming predictable", "failing the few people she trusts"],
    relationships: ["Has unfinished history with the Night Syndicate.", "Treats alliances as temporary until proven otherwise."],
    arc: "Moves from strategic distance toward costly emotional commitment.",
    internalConflict: "She wants intimacy but trusts control more than honesty.",
    externalConflict: "Several factions want the same information she is trying to bury and decode.",
  });

  await createChapter(targetPath, {
    number: 1,
    title: "The Arrival",
    frontmatter: {
      summary: "Lyra returns to Gray Harbor and realizes the city is already waiting for her.",
      pov: ["character:lyra-vale"],
    },
  });

  await createParagraph(targetPath, {
    chapter: "chapter:001-the-arrival",
    number: 1,
    title: "At The Gate",
    frontmatter: {
      summary: "Lyra arrives at the city gate and notices the altered guard routine.",
      viewpoint: "character:lyra-vale",
    },
    body: [
      "Gray Harbor had changed its posture.",
      "",
      "The walls were the same color as memory, but the men on the gate no longer looked bored. They watched the road like they expected a confession to come walking out of the fog.",
      "",
      "Lyra slowed before the archway and let the city study her first.",
    ].join("\n"),
  });

  await syncChapterResume(targetPath, "chapter:001-the-arrival");
  await syncChapterEvaluation(targetPath, "chapter:001-the-arrival");
  await syncTotalResume(targetPath);
}

output.write(
  [
    `GhostWriter book created at ${targetPath}`,
    "",
    "Next steps:",
    `- Open the repo in OpenCode and enable the local MCP server`,
    `- Run \`npm run build\` in GhostWriterFramework if you changed the framework`,
    `- Use \`init_book_repo\` only for new repos; this repo is already initialized`,
    `- Point the reader to this repo with GHOSTWRITER_BOOK_ROOT=${targetPath}`,
    ...(readerPath ? [`- Reader scaffold created at ${readerPath}`] : []),
  ].join("\n"),
);

async function resolveInputs(args: ParsedArgs) {
  if (args.targetDir && args.title && args.language) {
    return {
      targetDir: args.targetDir,
      title: args.title,
      author: args.author ?? "",
      language: args.language,
      sample: Boolean(args.sample),
      withReader: Boolean(args.withReader),
      readerDir: args.readerDir ?? "reader",
    };
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error("Missing required arguments. Use create-ghostwriter-book <dir> --title <title> --language <lang> [--author <name>] [--sample] [--with-reader] [--reader-dir <name>].");
  }

  const rl = createInterface({ input, output });
  try {
    const targetDir = (args.targetDir ?? (await rl.question("Target folder: "))) || "my-book";
    const title = args.title ?? (await rl.question("Book title: "));
    const author = args.author ?? (await rl.question("Author (optional): "));
    const language = args.language ?? ((await rl.question("Language [en]: ")) || "en");
    const sampleAnswer = await rl.question("Create sample content? [y/N]: ");
    const readerAnswer = await rl.question("Scaffold Astro reader too? [y/N]: ");
    const wantsReader = /^y(es)?$/i.test(readerAnswer.trim()) || Boolean(args.withReader);
    const readerDir = wantsReader
      ? (await rl.question("Reader folder [reader]: ")) || args.readerDir || "reader"
      : args.readerDir ?? "reader";
    return {
      targetDir,
      title,
      author,
      language,
      sample: /^y(es)?$/i.test(sampleAnswer.trim()) || Boolean(args.sample),
      withReader: wantsReader,
      readerDir,
    };
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
      case "--title":
        parsed.title = argv[++index];
        break;
      case "--author":
        parsed.author = argv[++index];
        break;
      case "--language":
      case "--lang":
        parsed.language = argv[++index];
        break;
      case "--sample":
        parsed.sample = true;
        break;
      case "--with-reader":
        parsed.withReader = true;
        break;
      case "--reader-dir":
        parsed.readerDir = argv[++index];
        break;
      default:
        break;
    }
  }

  return parsed;
}

function slugifyForPackage(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "ghostwriter-book";
}

async function runReaderScaffold(targetDir: string, bookRoot: string, packageName: string): Promise<string> {
  const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const require = createRequire(import.meta.url);
  const readerCliPath = resolveReaderCliPath(require, packageRoot);
  const coreDependency = resolveCoreDependency(targetDir, packageRoot);
  const result = spawnSync(
    process.execPath,
    [readerCliPath, targetDir, "--book-root", bookRoot, "--package-name", packageName, "--core-dependency", coreDependency],
    {
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Reader scaffold failed.");
  }

  return path.resolve(targetDir);
}

function resolveReaderCliPath(require: NodeRequire, packageRoot: string): string {
  try {
    const scaffoldPath = require.resolve("@ghostwriter/astro-reader/scaffold");
    return path.resolve(path.dirname(scaffoldPath), "cli.js");
  } catch {
    return path.resolve(packageRoot, "../astro-reader/cli-dist/cli.js");
  }
}

function resolveCoreDependency(targetDir: string, packageRoot: string): string {
  const localCorePath = path.resolve(packageRoot, "../core");
  if (existsSync(path.join(localCorePath, "package.json"))) {
    const relative = path.relative(targetDir, localCorePath).split(path.sep).join("/");
    return `file:${relative.startsWith(".") ? relative : `./${relative}`}`;
  }

  return "^0.1.0";
}

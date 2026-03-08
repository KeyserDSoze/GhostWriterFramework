#!/usr/bin/env node
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { scaffoldReaderSite } from "./scaffold.js";
const args = parseArgs(process.argv.slice(2));
const resolved = await resolveInputs(args);
const result = await scaffoldReaderSite(resolved.targetDir, {
    bookRoot: resolved.bookRoot,
    packageName: resolved.packageName,
    coreDependency: resolved.coreDependency,
});
output.write([
    `GhostWriter reader scaffolded at ${result.targetRoot}`,
    `Book root default: ${result.bookRoot}`,
    `Core dependency: ${result.coreDependency}`,
    "",
    "Next steps:",
    `- cd ${result.targetRoot}`,
    "- npm install",
    "- copy .env.example to .env if you want a local override",
    "- npm run dev",
].join("\n"));
async function resolveInputs(args) {
    if (args.targetDir) {
        return {
            targetDir: args.targetDir,
            bookRoot: args.bookRoot ?? "..",
            packageName: args.packageName,
            coreDependency: args.coreDependency,
        };
    }
    if (!input.isTTY || !output.isTTY) {
        throw new Error("Missing target directory. Use ghostwriter-reader-init <target-dir> [--book-root <path>] [--package-name <name>].");
    }
    const rl = createInterface({ input, output });
    try {
        const targetDir = (await rl.question("Reader folder [reader]: ")) || "reader";
        const bookRoot = (await rl.question("Book root relative to reader [. . becomes ..] [..]: ")) || "..";
        const packageName = (await rl.question("Package name (optional): ")) || undefined;
        const coreDependency = (await rl.question("Core dependency [published latest compatible]: ")) || undefined;
        return { targetDir, bookRoot, packageName, coreDependency };
    }
    finally {
        rl.close();
    }
}
function parseArgs(argv) {
    const parsed = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith("-")) {
            if (!parsed.targetDir)
                parsed.targetDir = token;
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
            default:
                break;
        }
    }
    return parsed;
}
//# sourceMappingURL=cli.js.map
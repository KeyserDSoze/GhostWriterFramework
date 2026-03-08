import { cp, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ScaffoldOptions = {
  bookRoot?: string;
  packageName?: string;
  coreDependency?: string;
};

export async function scaffoldReaderSite(targetDir: string, options: ScaffoldOptions = {}) {
  const targetRoot = path.resolve(targetDir);
  const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const bookRoot = options.bookRoot ?? "..";
  const packageName = options.packageName ?? inferPackageName(targetRoot);
  const coreDependency = options.coreDependency ?? `^${await readCurrentPackageVersion(packageRoot)}`;

  await mkdir(path.join(targetRoot, "src", "layouts"), { recursive: true });
  await mkdir(path.join(targetRoot, "src", "lib"), { recursive: true });
  await mkdir(path.join(targetRoot, "src", "pages"), { recursive: true });
  await mkdir(path.join(targetRoot, "src", "components"), { recursive: true });

  await Promise.all([
    copyFile(path.join(packageRoot, "astro.config.mjs"), path.join(targetRoot, "astro.config.mjs")),
    copyFile(path.join(packageRoot, "tsconfig.json"), path.join(targetRoot, "tsconfig.json")),
    cp(path.join(packageRoot, "src", "components"), path.join(targetRoot, "src", "components"), { recursive: true }),
    cp(path.join(packageRoot, "src", "lib"), path.join(targetRoot, "src", "lib"), { recursive: true }),
    cp(path.join(packageRoot, "src", "layouts"), path.join(targetRoot, "src", "layouts"), { recursive: true }),
    cp(path.join(packageRoot, "src", "pages"), path.join(targetRoot, "src", "pages"), { recursive: true }),
  ]);

  await writeFile(
    path.join(targetRoot, "package.json"),
    JSON.stringify(
      {
        name: packageName,
        private: true,
        type: "module",
        scripts: {
          dev: "astro dev",
          build: "astro build",
          preview: "astro preview",
        },
        dependencies: {
          "@ghostwriter/core": coreDependency,
          astro: "^5.14.1",
          marked: "^16.3.0",
        },
        devDependencies: {
          "@types/node": "^24.6.0",
          typescript: "^5.9.3",
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  await writeFile(
    path.join(targetRoot, "src", "lib", "book-config.ts"),
    `export const defaultBookRoot = ${JSON.stringify(toPosix(bookRoot))};\n`,
    "utf8",
  );

  await writeFile(path.join(targetRoot, ".env.example"), `GHOSTWRITER_BOOK_ROOT=${toPosix(bookRoot)}\n`, "utf8");
  await writeFile(path.join(targetRoot, ".gitignore"), "node_modules/\ndist/\n.astro/\n.env\n", "utf8");
  await writeFile(
    path.join(targetRoot, "README.md"),
    buildReaderReadme(bookRoot),
    "utf8",
  );

  return {
    targetRoot,
    packageName,
    coreDependency,
    bookRoot,
  };
}

function buildReaderReadme(bookRoot: string): string {
  return `# GhostWriter Reader Site

This site was scaffolded from \`@ghostwriter/astro-reader\`.

## Configure

Set the book root in a local environment file:

\`\`\`bash
GHOSTWRITER_BOOK_ROOT=${toPosix(bookRoot)}
\`\`\`

## Run

\`\`\`bash
npm install
npm run dev
\`\`\`

## Build

\`\`\`bash
npm run build
\`\`\`
`;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function inferPackageName(targetRoot: string): string {
  const base = path.basename(targetRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "ghostwriter-reader-site";
  return base;
}

async function readCurrentPackageVersion(packageRoot: string): Promise<string> {
  const raw = await readFile(path.join(packageRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.1.0";
}

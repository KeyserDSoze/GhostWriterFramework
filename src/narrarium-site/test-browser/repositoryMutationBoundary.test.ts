import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("production code cannot import repository test seed helpers", () => {
  const root = resolve(process.cwd(), "src");
  for (const file of sourceFiles(root)) {
    expect(readFileSync(file, "utf8"), file).not.toContain("localRepositorySeed");
  }
});

test("only repository boundary modules open the primary local repository database", () => {
  const root = resolve(process.cwd(), "src");
  const allowed = new Set(["repository/localRepository.ts", "repository/repositoryMaintenance.ts", "repository/localRewriteOperationStore.ts"]);
  for (const file of sourceFiles(root)) {
    const relative = file.slice(root.length + 1);
    if (readFileSync(file, "utf8").includes("narrarium-local-repositories")) expect(allowed.has(relative), relative).toBe(true);
  }
});

test("local repository mutation exports require operation scope and raw exports stay removed", () => {
  const source = readFileSync(resolve(process.cwd(), "src/repository/localRepository.ts"), "utf8");
  expect(source).not.toContain("export async function putQuarantinedLocalRepository");
  expect(source).not.toContain("export async function removeLocalFileEntry");
  expect(source).not.toContain("export async function discardUnpushedLocalCommits");
  expect(source).not.toContain("export async function writeLocalBinary(");
  expect(source).toMatch(/export async function addLocalRepoLog\([^)]*scope: RepositoryOperationScope/);
  expect(source).toMatch(/export async function putCleanLocalFile\([\s\S]*?scope: RepositoryOperationScope/);
  expect(source).toMatch(/export async function writeLocalText\([^)]*scope: RepositoryOperationScope/);
  expect(source).toMatch(/export async function deleteLocalFile\([^)]*scope: RepositoryOperationScope/);
  expect(source).toMatch(/export async function deleteLocalRecoverySnapshot\([^)]*scope: RepositoryOperationScope/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitRepository } from "../dist/testing.mjs";

test("a repository that already says core.symlinks twice is still told once (Git for Windows writes it itself, and a clone adds another)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-gitconfig-"));
  try {
    const repository = new GitRepository(root);
    await repository.init();
    await appendFile(path.join(root, ".git", "config"), "[core]\n\tsymlinks = false\n[core]\n\tsymlinks = false\n");
    const before = execFileSync("git", ["config", "--local", "--get-all", "core.symlinks"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/);
    assert.ok(before.length >= 2, `the configuration holds several values: ${before.join(",")}`);
    await repository.init();
    const after = execFileSync("git", ["config", "--local", "--get-all", "core.symlinks"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/);
    assert.deepEqual(after, ["false"]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

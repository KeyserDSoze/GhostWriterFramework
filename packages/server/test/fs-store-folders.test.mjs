import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const posix = process.platform !== "win32";
const testing = new URL("../dist/testing.mjs", import.meta.url).href;
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));

/**
 * `mkdir` with `recursive` says which folder it made first. A commit used to compare that answer with its own spelling of the same path,
 * and on Windows the two were not the same string (Node answers `\\?\C:\...`, with the long-path prefix): the comparison never came
 * true and the commit never ended (every test that wrote a file into a new folder hung for the whole two minutes). The answer is
 * replaced here by each way a system may spell it, in a process of its own so that a commit that does not end is a failure and not a
 * stuck test run.
 */
const SPELLINGS = {
  "with the long-path prefix of Windows": "(first) => (first === undefined ? first : '\\\\\\\\?\\\\' + first)",
  "in another case": "(first) => first?.toUpperCase()",
  "with every separator doubled": "(first) => first?.replace(/[\\\\/]/g, (separator) => separator + separator)",
  "as a folder of another place": "() => '/somewhere/else/entirely'",
  "as nothing": "() => undefined",
  "as an empty string": "() => ''",
};

function commitWithSpelling(root, spelling) {
  const source = `
    import fsp from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { FileBookStore } from ${JSON.stringify(testing)};
    const spell = ${spelling};
    const mkdir = fsp.mkdir;
    fsp.mkdir = async (target, options) => spell(await mkdir(target, options));
    const open = fsp.open;
    const flushed = [];
    fsp.open = async (file, ...rest) => {
      const handle = await open(file, ...rest);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        flushed.push(String(file));
        return sync();
      };
      return handle;
    };
    syncBuiltinESMExports();
    const store = new FileBookStore(${JSON.stringify(root)});
    await store.commit([
      { path: "a/b/c.md", content: "deep\\n" },
      { path: "a/b/d.md", content: "same folder\\n" },
      { path: "a/e/f.md", content: "sibling\\n" },
      { path: "g/h.md", content: "elsewhere\\n" },
    ], "write");
    process.stdout.write("DONE " + JSON.stringify(flushed) + "\\n");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

for (const [name, spelling] of Object.entries(SPELLINGS)) {
  test(`R6: a commit that makes new folders ends, and flushes them all, when mkdir names the first one ${name}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-folders-"));
    try {
      const outcome = await commitWithSpelling(root, spelling);
      assert.equal(outcome.signal, null, `the commit did not end (it was stopped): ${outcome.stdout}${outcome.stderr}`);
      assert.match(outcome.stdout, /^DONE /m, `${outcome.stdout}${outcome.stderr}`);
      for (const [relative, text] of [["a/b/c.md", "deep\n"], ["a/b/d.md", "same folder\n"], ["a/e/f.md", "sibling\n"], ["g/h.md", "elsewhere\n"]]) {
        assert.equal(await readFile(path.join(root, ...relative.split("/")), "utf8"), text, relative);
      }
      if (!posix) return;
      // Every folder that gained an entry is flushed: the ones that were made, and the one that held the first of them (the root).
      const flushed = JSON.parse(/^DONE (.*)$/m.exec(outcome.stdout)[1]);
      for (const folder of [path.join(root, "a", "b"), path.join(root, "a", "e"), path.join(root, "a"), path.join(root, "g"), root]) {
        assert.ok(flushed.includes(folder), `${path.relative(root, folder) || "the root"} was flushed: ${flushed.join(", ")}`);
      }
    } finally {
      await remove(root);
    }
  });
}

test("R6: a commit into folders that exist flushes those folders and nothing above them", { skip: !posix && "Windows cannot flush a folder" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-folders-existing-"));
  try {
    await mkdir(path.join(root, "a", "b"), { recursive: true });
    await mkdir(path.join(root, "a", "e"), { recursive: true });
    await mkdir(path.join(root, "g"), { recursive: true });
    const outcome = await commitWithSpelling(root, "(first) => first");
    assert.match(outcome.stdout, /^DONE /m, `${outcome.stdout}${outcome.stderr}`);
    const flushed = JSON.parse(/^DONE (.*)$/m.exec(outcome.stdout)[1]);
    for (const folder of [path.join(root, "a", "b"), path.join(root, "a", "e"), path.join(root, "g")]) {
      assert.ok(flushed.includes(folder), `${path.relative(root, folder)}: ${flushed.join(", ")}`);
    }
    for (const folder of [path.join(root, "a"), root, path.dirname(root)]) {
      assert.ok(!flushed.includes(folder), `${path.relative(root, folder) || "the root"} gained no entry, so it is not flushed: ${flushed.join(", ")}`);
    }
  } finally {
    await remove(root);
  }
});

test("R6: what mkdir says on this system, for the record (a Windows run once reported it in a spelling its caller did not expect)", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-folders-record-"));
  try {
    const target = path.join(root, "x", "y");
    const first = await mkdir(target, { recursive: true });
    t.diagnostic(JSON.stringify({ platform: process.platform, node: process.version, tmpdir: os.tmpdir(), root, asked: target, first, same: first === path.join(root, "x") }));
    assert.ok(first === undefined || typeof first === "string");
  } finally {
    await remove(root);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileBookStore } from "../dist/testing.mjs";

const posix = process.platform !== "win32";
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));

/**
 * Watch what a piece of code asks the file system for: every `open` (and what is `sync`ed on the handle it returns) and every `rename`,
 * in order. The built-in module's bindings are replaced for the time of `run`, and put back.
 */
async function recording(run) {
  const events = [];
  const open = fsp.open;
  const rename = fsp.rename;
  fsp.open = async (file, ...rest) => {
    const handle = await open(file, ...rest);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      events.push({ type: "sync", file: String(file) });
      return sync();
    };
    events.push({ type: "open", file: String(file), flags: rest[0] });
    return handle;
  };
  fsp.rename = async (from, to) => {
    events.push({ type: "rename", from: String(from), to: String(to) });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    fsp.open = open;
    fsp.rename = rename;
    syncBuiltinESMExports();
  }
  return events;
}

const syncsOf = (events, file) => events.flatMap((event, index) => (event.type === "sync" && event.file === file ? [index] : []));
const indexOfRename = (events, to) => events.findIndex((event) => event.type === "rename" && event.to === to);

test("R6: a committed file is flushed to disk before it is put in place, and its folder after (a power cut cannot leave the commit half-done)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-durable-"));
  try {
    const store = new FileBookStore(root);
    const events = await recording(() => store.commit([{ path: "chapters/001/scene.md", content: "The harbor was cold.\n" }, { path: "book.md", content: "---\ntitle: T\n---\n" }], "write"));
    for (const relative of ["chapters/001/scene.md", "book.md"]) {
      const target = path.join(root, ...relative.split("/"));
      const renamed = indexOfRename(events, target);
      assert.ok(renamed >= 0, `${relative} is put in place by a rename`);
      const temporary = events[renamed].from;
      assert.equal(path.dirname(temporary), path.dirname(target), "through a temporary file next to it");
      assert.ok(syncsOf(events, temporary).some((index) => index < renamed), `${relative}: the temporary file was flushed before the rename`);
      if (posix) assert.ok(syncsOf(events, path.dirname(target)).some((index) => index > renamed), `${relative}: its folder was flushed after the rename`);
    }
    assert.equal(await readFile(path.join(root, "chapters", "001", "scene.md"), "utf8"), "The harbor was cold.\n");
  } finally {
    await remove(root);
  }
});

test("R6: the folders a commit created, and the folders where it deleted files, are flushed too", async (t) => {
  if (!posix) return t.skip("Windows cannot flush a folder");
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-durable-dirs-"));
  try {
    const store = new FileBookStore(root);
    const events = await recording(() => store.commit([{ path: "a/b/c/deep.md", content: "x\n" }], "deep"));
    const renamed = indexOfRename(events, path.join(root, "a", "b", "c", "deep.md"));
    for (const folder of [path.join(root, "a", "b", "c"), path.join(root, "a", "b"), path.join(root, "a"), root]) {
      assert.ok(syncsOf(events, folder).some((index) => index > -1), `${path.relative(root, folder) || "the root"} was flushed (it holds a new entry)`);
    }
    assert.ok(syncsOf(events, path.join(root, "a", "b", "c")).some((index) => index > renamed));

    const removal = await recording(() => store.commit([{ path: "a/b/c/deep.md", content: null }], "remove"));
    assert.ok(syncsOf(removal, path.join(root, "a", "b", "c")).length >= 1, "the folder of a deleted file is flushed");
    await assert.rejects(() => stat(path.join(root, "a", "b", "c", "deep.md")), { code: "ENOENT" });
  } finally {
    await remove(root);
  }
});

test("R6: a big commit flushes each folder once, not once per file", async (t) => {
  if (!posix) return t.skip("Windows cannot flush a folder");
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-durable-many-"));
  try {
    const store = new FileBookStore(root);
    const changes = Array.from({ length: 120 }, (_, index) => ({ path: `chapters/${String(index % 4).padStart(3, "0")}/scene-${index}.md`, content: `scene ${index}\n` }));
    const events = await recording(() => store.commit(changes, "many"));
    for (let chapter = 0; chapter < 4; chapter += 1) {
      const folder = path.join(root, "chapters", String(chapter).padStart(3, "0"));
      assert.ok(syncsOf(events, folder).length >= 1 && syncsOf(events, folder).length <= 2, `${path.basename(folder)}: ${syncsOf(events, folder).length} flushes`);
    }
    const fileSyncs = events.filter((event) => event.type === "sync" && /\.tmp$/.test(event.file));
    assert.equal(fileSyncs.length, 120, "every file is flushed");
  } finally {
    await remove(root);
  }
});

test("R6: when a commit fails, the files it put back are flushed as well, and nothing of it is left", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-durable-undo-"));
  try {
    const store = new FileBookStore(root, {
      afterWrite: async () => {
        throw new Error("git said no");
      },
    });
    const plain = new FileBookStore(root);
    await plain.commit([{ path: "notes.md", content: "original\n" }], "first");
    const events = await recording(async () => {
      await assert.rejects(() => store.commit([{ path: "notes.md", content: "changed\n" }, { path: "new/file.md", content: "new\n" }], "second"), /git said no/);
    });
    assert.equal(await readFile(path.join(root, "notes.md"), "utf8"), "original\n", "put back");
    await assert.rejects(() => stat(path.join(root, "new", "file.md")), { code: "ENOENT" });
    const renamed = events.filter((event) => event.type === "rename" && event.to === path.join(root, "notes.md"));
    assert.equal(renamed.length, 2, "written, then put back");
    for (const rename of renamed) assert.ok(events.some((event, index) => event.type === "sync" && event.file === rename.from && index < events.indexOf(rename)), "each through a flushed temporary file");
  } finally {
    await remove(root);
  }
});

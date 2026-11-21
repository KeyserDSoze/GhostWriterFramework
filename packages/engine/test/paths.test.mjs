import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeBookPath, isSafeBookPath, planFileSync, syncBookStores } from "../dist/index.js";
import { MemoryBookStore } from "../dist/testing/index.js";

const SAFE = [
  "book.md",
  "chapters/001-the-harbor/chapter.md",
  "chapters/001-the-harbor/001-arrival.md",
  "characters/ada.md",
  "autopilot/state.json",
  ".github/workflows/deploy.yml",
  "notes/città/ünï.md",
  "research/wikipedia/Lighthouse.md",
  ".gitignore",
  ".gitkeep",
  "my.git.notes.md",
];

const UNSAFE = [
  ["empty", ""],
  ["parent", "../outside.md"],
  ["nested parent", "chapters/../../outside.md"],
  ["absolute", "/etc/passwd"],
  ["drive letter", "C:/Users/x.md"],
  ["drive letter with backslash", "C:\\Users\\x.md"],
  ["current directory segment", "chapters/./a.md"],
  ["empty segment", "chapters//a.md"],
  ["git folder", ".git/config"],
  ["git folder, upper case", ".GIT/config"],
  ["git folder, mixed case, nested", "chapters/.Git/hooks/pre-commit"],
  ["git folder with trailing dot", ".git./config"],
  ["git folder with trailing space", ".git /config"],
  ["git 8.3 short name", "GIT~1/config"],
  ["git 8.3 short name, lower case", "git~1/config"],
  ["git alternate data stream", ".git::$INDEX_ALLOCATION/config"],
  ["git folder with a zero-width non-joiner", ".g\u200cit/config"],
  ["git folder with a zero-width joiner", ".gi\u200dt/config"],
  ["git folder with a soft hyphen", ".g\u00adit/config"],
  ["git folder with a full-width dot", "\uff0egit/config"],
  ["git folder with a small full stop", "\ufe52git/config"],
  ["trailing space in a segment", "chapters/a.md "],
  ["leading space in a segment", "chapters/ a.md"],
  ["trailing dot in a segment", "chapters/a.md."],
  ["only dots", "chapters/..."],
  ["colon", "notes/a:b.md"],
  ["wildcard", "notes/a*b.md"],
  ["question mark", "notes/a?b.md"],
  ["pipe", "notes/a|b.md"],
  ["quote", 'notes/a"b.md'],
  ["angle bracket", "notes/a<b.md"],
  ["NUL", "notes/a\u0000b.md"],
  ["line break", "notes/a\nb.md"],
  ["Windows device name", "notes/CON.md"],
  ["Windows device name, nested and lower case", "chapters/aux.txt"],
  ["Windows device name with a number", "notes/COM1"],
  ["Windows device name, LPT9", "notes/lpt9.md"],
  ["too long", `${"a".repeat(1025)}.md`],
  ["segment too long", `notes/${"a".repeat(256)}.md`],
];

test("assertSafeBookPath accepts ordinary book paths and returns them unchanged", () => {
  for (const path of SAFE) assert.equal(assertSafeBookPath(path), path, path);
  for (const path of SAFE) assert.equal(isSafeBookPath(path), true, path);
});

test("assertSafeBookPath refuses traversal, absolute paths and every spelling of .git", () => {
  for (const [name, path] of UNSAFE) {
    assert.throws(() => assertSafeBookPath(path), /Unsafe book path/, name);
    assert.equal(isSafeBookPath(path), false, name);
  }
});

test("assertSafeBookPath normalizes backslashes, isSafeBookPath insists on the canonical spelling", () => {
  assert.equal(assertSafeBookPath("chapters\\001-a\\chapter.md"), "chapters/001-a/chapter.md");
  assert.equal(isSafeBookPath("chapters\\001-a\\chapter.md"), false);
  assert.throws(() => assertSafeBookPath("chapters\\..\\x.md"), /Unsafe book path/);
  assert.throws(() => assertSafeBookPath(".git\\config"), /Unsafe book path/);
});

test("a manifest from another host cannot plan unsafe paths", () => {
  const unsafe = ["../evil.md", "/etc/cron.d/x.md", ".git/hooks/pre-commit.json", ".GIT/config.json", "C:/x.md", "a\\b.md", "notes/CON.md"];
  const remote = new Map([...unsafe.map((path) => [path, "1"]), ["good.md", "2"]]);
  const plan = planFileSync(new Map(), remote, new Map());
  assert.deepEqual(plan.download, [{ path: "good.md", hash: "2" }]);
  assert.deepEqual(plan.upload, []);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual([...plan.rejected].sort(), [...unsafe].sort());
});

test("binary assets are ignored silently, not reported as rejected", () => {
  const plan = planFileSync(new Map([["cover.png", "1"], ["../x.png", "1"]]), new Map(), new Map());
  assert.deepEqual(plan.rejected, []);
  assert.deepEqual(plan.upload, []);
});

test("syncBookStores never writes an unsafe remote path and reports it", async () => {
  const local = new MemoryBookStore({ "book.md": "mine" });
  const remote = new MemoryBookStore({ "../evil.md": "x", ".git/hooks/pre-commit.json": "{}", "good.md": "ok" });
  const result = await syncBookStores({ local, remote, base: new Map() });
  assert.deepEqual(result.downloaded, ["good.md"]);
  assert.deepEqual(result.uploaded, ["book.md"]);
  assert.deepEqual([...result.rejected].sort(), ["../evil.md", ".git/hooks/pre-commit.json"]);
  assert.deepEqual([...local.files.keys()].sort(), ["book.md", "good.md"]);
  assert.equal(result.base.has("../evil.md"), false, "an unsafe path is not remembered as synced");
});

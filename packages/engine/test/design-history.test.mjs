import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// Phase 4 of #108: the versions of the Synopsis and the Bible, kept in the book, compared with the files as they are, and restored only as a proposal that says what changes.

const { AutopilotSession, designRestore, designSnapshotChange, isDesignFile, parseAutopilotState, readDesignSnapshot, serializeOutlineChapter } = engine;

const STATE = "autopilot/state.json";
const clock = () => new Date("2026-11-28T08:00:00.000Z");
const stateOf = (store) => parseAutopilotState(store.files.get(STATE));

async function run(store, ai, start) {
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  await session.start(start);
  await session.waitForIdle();
  return { session, state: stateOf(store) };
}

const FILES = [
  { path: "outline/book.md", content: "---\ntype: outline\n---\n\nThe idea.\n", hash: "h-book" },
  { path: "outline/_brief.md", content: "---\ntype: outline-brief\n---\n\nThe plot.\n", hash: "h-brief" },
  { path: "outline/chapters/001.md", content: "---\nnumber: 1\n---\n\nOne.\n", hash: "h-1" },
  { path: "outline/chapters/002.md", content: "---\nnumber: 2\n---\n\nTwo.\n", hash: "h-2" },
  { path: "outline/changes.yml", content: "series: []\n", hash: "h-journal" },
  { path: "bible/world.md", content: "---\nrules:\n  - Glass breaks.\n---\n", hash: "h-world" },
  { path: "characters/mira.md", content: "# Mira\n", hash: "h-mira" },
];

test("a version keeps the Synopsis and the Bible, never the journal or the canon, and says when and why", () => {
  assert.deepEqual(FILES.filter((file) => isDesignFile(file.path)).map((file) => file.path), ["outline/book.md", "outline/_brief.md", "outline/chapters/001.md", "outline/chapters/002.md", "bible/world.md"]);
  const change = designSnapshotChange(FILES, { at: "2026-11-28T08:00:00.000Z", reason: "approved", run: "2026-11-27T10:00:00.000Z" });
  assert.equal(change.path, "history/design/2026-11-28T08-00-00-000Z-approved.json");
  assert.equal(change.expectedHash, null);
  const snapshot = readDesignSnapshot(change.content);
  assert.deepEqual(Object.keys(snapshot.files), ["bible/world.md", "outline/_brief.md", "outline/book.md", "outline/chapters/001.md", "outline/chapters/002.md"]);
  assert.deepEqual({ at: snapshot.at, reason: snapshot.reason, run: snapshot.run }, { at: "2026-11-28T08:00:00.000Z", reason: "approved", run: "2026-11-27T10:00:00.000Z" });
  assert.equal(designSnapshotChange([FILES[6]], { at: "2026-11-28T08:00:00.000Z", reason: "request" }), null, "nothing of the Synopsis or the Bible: no version");
  for (const odd of [null, "", "{", "[]", JSON.stringify({ type: "design-snapshot", version: 2, at: "2026-11-28T08:00:00.000Z", files: {} }), JSON.stringify({ type: "note" })]) assert.equal(readDesignSnapshot(odd), null, String(odd));
  const read = readDesignSnapshot(JSON.stringify({ type: "design-snapshot", version: 1, at: "2026-11-28T08:00:00.000Z", reason: "whatever", files: { "outline/chapters/001.md": "One.", "secrets/x.md": "no", "outline/chapters/002.md": 3 } }));
  assert.deepEqual(read, { at: "2026-11-28T08:00:00.000Z", reason: "request", files: { "outline/chapters/001.md": "One." } });
});

test("restoring a version says what comes back, what goes and what changes, file by file, and its changes expect every file as it was read", () => {
  const snapshot = readDesignSnapshot(designSnapshotChange(FILES, { at: "2026-11-28T08:00:00.000Z", reason: "request" }).content);
  const now = [
    { ...FILES[0] },
    { path: "outline/chapters/001.md", content: "---\nnumber: 1\n---\n\nOne, rewritten.\n", hash: "h-1b" },
    { path: "outline/chapters/003.md", content: "---\nnumber: 3\n---\n\nThree.\n", hash: "h-3" },
    { ...FILES[4] },
    { path: "bible/world.md", content: "---\r\nrules:\r\n  - Glass breaks.\r\n---\r\n", hash: "h-world" },
  ];
  const { items, changes } = designRestore(snapshot, now);
  assert.deepEqual(items.map((item) => [item.path, item.kind]), [["outline/_brief.md", "added"], ["outline/chapters/001.md", "changed"], ["outline/chapters/002.md", "added"], ["outline/chapters/003.md", "removed"]]);
  assert.deepEqual(changes, [
    { path: "outline/_brief.md", content: FILES[1].content, expectedHash: null },
    { path: "outline/chapters/001.md", content: FILES[2].content, expectedHash: "h-1b" },
    { path: "outline/chapters/002.md", content: FILES[3].content, expectedHash: null },
    { path: "outline/chapters/003.md", content: null, expectedHash: "h-3" },
  ]);
  assert.equal(items[1].before, now[1].content);
  assert.equal(items[1].after, FILES[2].content);
  assert.deepEqual(designRestore(snapshot, FILES).items, [], "the files as the version has them: nothing to restore");
});

test("applying the proposals of Review and complete keeps the Synopsis and the Bible as they were in a version of their own, in the same commit", async () => {
  const files = seedBookFiles({ chapters: 0, title: "The Glass Harbor" });
  files["outline/chapters/001.md"] = serializeOutlineChapter({ number: 1, title: "One", body: "Mira finds the crack.", origin: "author" });
  files["bible/world.md"] = "---\ntype: bible\nid: bible:world\nrules:\n  - Glass breaks.\n---\n";
  const store = new MemoryBookStore(files);
  const { session, state } = await run(store, createFakeAutopilotAi(), { design: { mode: "complete" }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  const before = store.files.get("outline/chapters/001.md");
  const commits = store.commits?.length;
  const result = await session.applyDesignProposals({ run: state.design.startedAt, apply: ["f1-goal"] });
  assert.match(result.version, /^history\/design\/2026-11-28T08-00-00-000Z-proposals\.json$/);
  const snapshot = readDesignSnapshot(store.files.get(result.version));
  assert.equal(snapshot.reason, "proposals");
  assert.equal(snapshot.run, state.design.startedAt);
  assert.equal(snapshot.files["outline/chapters/001.md"], before);
  assert.equal(snapshot.files["bible/world.md"], files["bible/world.md"]);
  assert.notEqual(store.files.get("outline/chapters/001.md"), before, "the proposal is applied");
  if (commits !== undefined) assert.equal(store.commits.length, commits + 1, "one commit");
  const restored = designRestore(snapshot, [...store.files].map(([path, content]) => ({ path, content })));
  assert.deepEqual(restored.items.map((item) => [item.path, item.kind]), [["outline/chapters/001.md", "changed"]], "restoring it takes back what was applied");
});

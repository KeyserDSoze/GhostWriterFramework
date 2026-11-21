import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { doctorBook, validateBook } from "narrarium";
import { AutopilotSession, askDirector } from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

async function writeBook(store) {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-autopilot-book-"));
  for (const [relative, content] of store.files) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

test("the files written by the autopilot and the director form a valid Narrarium book", async () => {
  const store = new MemoryBookStore(seedBookFiles({ language: "it" }));
  const ai = createFakeAutopilotAi();
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start({ brief: { idea: "Un porto di vetro", targetChapters: 2, scenesPerChapter: 2 }, options: { maxReaders: 2, pauseAfterPlan: false } });
  await session.waitForIdle();
  assert.equal((await session.snapshot()).state.status, "completed");
  await askDirector({ store, ai, target: { kind: "paragraph", chapter: "001-chapter-title-1", paragraph: "001-scene-1-title" }, save: true });

  const root = await writeBook(store);
  try {
    const validation = await validateBook(root);
    assert.deepEqual(validation.errors, [], "schemas and identities are valid");
    const doctor = await doctorBook(root);
    assert.deepEqual(doctor.issues.filter((issue) => issue.severity === "error"), [], "doctor finds no errors");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

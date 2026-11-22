import test from "node:test";
import assert from "node:assert/strict";
import { frozenChanges, loadBookSnapshot } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { fakeAi, startOf } from "./hold.mjs";

// The engine's frozen chapters (E4b) through the routes a server has today, without a line of the server changed: the question about a change
// is a question like the others (`GET …/autopilot`), its count is in the summary of the book (`GET /api/v1/books`), and an answer that names a
// choice by its id, or by its label as the web app's buttons send it, goes through `POST …/autopilot/answer` as the server forwards it.

const SCENE = "chapters/001-chapter-title-1/001-scene-1-title.md";

/** A book of one chapter that the autopilot wrote (and froze), and the author's edit of its scene, saved through the server. */
async function changedBook(client) {
  await seededBook(client, "b");
  await client.startAutopilot("b", startOf(1));
  assert.equal((await finished(client, "b")).state.status, "completed");
  const [file] = await client.readFiles("b", [SCENE]);
  await client.commitFiles("b", [{ path: SCENE, content: `${file.content.trimEnd()}\n\nThe author's own new line.\n`, expectedHash: file.hash }], "the author edits a frozen chapter");
  await client.startAutopilot("b");
  return finished(client, "b");
}

/** The book as the server keeps it, read through the client: what the engine sees of its frozen chapters. */
async function frozenOf(client) {
  const store = new MemoryBookStore();
  const { files } = await client.manifest("b");
  for (const file of await client.readFiles("b", files.map((entry) => entry.path).filter((path) => path.startsWith("chapters/")))) store.write(file.path, file.content);
  return frozenChanges(await loadBookSnapshot(store));
}

for (const [name, answer] of [["the id of a choice", { answer: "mark-reviewed" }], ["the label a button sends", { answer: "Mark as reviewed" }], ["accept", { answer: "", accept: true }]]) {
  test(`E4b: a frozen chapter the author changed is asked about, counted in the book's summary, and answered through the answer route with ${name}`, async () => {
    await withServer(async (_server, client) => {
      const asked = await changedBook(client);
      assert.equal(asked.state.status, "waiting-author");
      const question = asked.state.question;
      assert.equal(question.kind, "frozen-change");
      assert.deepEqual(question.choices.map((choice) => choice.id), ["review-and-update", "review-only", "mark-reviewed"]);
      assert.deepEqual(question.options, question.choices.map((choice) => choice.label));
      assert.equal(asked.summary.frozenChanges, 1);
      const book = (await client.listBooks()).find((entry) => entry.bookId === "b");
      assert.equal(book.autopilot.frozenChanges, 1, "the list of books says it, without the state");
      assert.equal((await frozenOf(client)).length, 1);

      const answered = await client.answer("b", { questionId: question.id, ...answer });
      assert.equal(answered.state.question, null);
      assert.equal(answered.summary.frozenChanges, undefined, "nothing waits any more");
      assert.deepEqual(await frozenOf(client), [], "frozen again, as it is now");
      await client.startAutopilot("b");
      const done = await finished(client, "b");
      assert.equal(done.state.status, "completed", done.state.lastError?.message);
      assert.equal(done.state.question, null, "not asked again");
    }, { ai: fakeAi(1) });
  });
}

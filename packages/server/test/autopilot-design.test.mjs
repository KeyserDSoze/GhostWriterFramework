import test from "node:test";
import assert from "node:assert/strict";
import { SERVER_FEATURE_AUTOPILOT_DESIGN, SERVER_FEATURE_AUTOPILOT_DESIGN_COMPLETE, parseAutopilotState, readOutlineChapter, serverSupportsDesign, serverSupportsDesignComplete } from "narrarium-engine";
import * as testing from "../dist/testing.mjs";
import { withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { rawApi } from "./api-helpers.mjs";

// The design run of the autopilot on the server (`StartOptions.design`): `POST …/autopilot/start` takes `design`, refuses what is not one, and the engine designs the
// book from its description and stops when the director approves the design; the server announces `autopilot-design`. The engine decides and designs: these tests
// are about what the route accepts and answers.

const OPTIONS = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

test("#108: `info.features` announces `autopilot-design`, and the refusals of a design are 400 and 409", async () => {
  await withServer(async (server) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_DESIGN));
    assert.equal(serverSupportsDesign(info), true);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
  });
  for (const [code, status] of [["invalid_request", 400], ["design_written", 409], ["design_no_description", 409]]) {
    const mapped = testing.errorStatus(new testing.AutopilotDesignError(code, `Message of ${code}.`));
    assert.deepEqual([mapped.status, mapped.code], [status, code]);
  }
});

test("#108: a design is refused for what is no design and for a book without a description, and a book with a description is designed and waits for the author", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 0 });
    const api = await rawApi(server);
    for (const design of ["yes", { chapters: 0 }, { pages: 3 }, { review: { campaignMaxRounds: 1 } }]) {
      const answer = await api("POST", "/api/v1/books/b/autopilot/start", { design, options: OPTIONS });
      assert.deepEqual([answer.status, answer.json?.code], [400, "invalid_request"], JSON.stringify(design));
    }
    const bare = await api("POST", "/api/v1/books/b/autopilot/start", { design: { chapters: 3 }, options: OPTIONS });
    assert.deepEqual([bare.status, bare.json?.code], [409, "design_no_description"]);
    assert.equal((await client.autopilot("b")).state, null, "nothing started");

    await client.startAutopilot("b", { brief: { idea: "A harbor town built on glass hides a lie that the tide will tell." }, design: { chapters: 3, review: { maxRounds: 2 } }, options: OPTIONS });
    const done = await finished(client, "b");
    assert.equal(done.state.status, "paused", done.state.lastError?.message);
    assert.equal(done.state.design.outcome, "target");
    assert.deepEqual(done.state.design.review, { maxRounds: 2 });
    assert.equal(done.summary.design.active, false);
    assert.equal(done.summary.design.chapters, 3);
    assert.deepEqual(done.activities.map((activity) => activity.task), ["concept", "plan", "plan-review"], "the design and its review, nothing written");
    const files = await client.readFiles("b", ["outline/chapters/001.md", "outline/chapters/003.md", "bible/themes.md", "autopilot/state.json"]);
    const [first, third] = await Promise.all(files.slice(0, 2).map((file, index) => readOutlineChapter(file.path, index === 0 ? 1 : 3, file.content)));
    assert.equal(first.entry.design.goal, "Goal of chapter 1.");
    assert.equal(third.entry.intact, true);
    assert.match(files[2].content, /themes:/);
    assert.equal(parseAutopilotState(files[3].content).plan.approved, true);

  });
});

test("#125: «Review and complete» on the server: the feature is announced, a start reviews the author's chapters and stops, the route applies the chosen proposals in one commit, and its refusals are 400 and 409", async () => {
  for (const [code, status] of [["design_no_chapters", 409], ["no_proposals", 409], ["stale", 409]]) {
    const mapped = testing.errorStatus(new testing.AutopilotDesignError(code, `Message of ${code}.`));
    assert.deepEqual([mapped.status, mapped.code], [status, code]);
  }
  await withServer(async (server, client) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_DESIGN_COMPLETE));
    assert.equal(serverSupportsDesignComplete(info), true);
    await seededBook(client, "b", { chapters: 2 });
    const before = await client.readFiles("b", ["outline/chapters/001.md", "outline/chapters/002.md"]);
    const api = await rawApi(server);
    const wrong = await api("POST", "/api/v1/books/b/autopilot/start", { design: { mode: "complete", chapters: 4 }, options: OPTIONS });
    assert.deepEqual([wrong.status, wrong.json?.code], [400, "invalid_request"]);

    await client.startAutopilot("b", { design: { mode: "complete" }, options: OPTIONS });
    const done = await finished(client, "b");
    assert.equal(done.state.status, "paused", done.state.lastError?.message);
    assert.equal(done.state.design.mode, "complete");
    assert.deepEqual(done.activities.map((activity) => activity.task), ["design-complete", "design-complete-review"], "no concept, no plan");
    assert.equal(done.summary.design.mode, "complete");
    assert.equal(done.summary.design.proposals.chapters, 2);
    const unchanged = await client.readFiles("b", ["outline/chapters/001.md", "outline/chapters/002.md"]);
    assert.deepEqual(unchanged.map((file) => file.content), before.map((file) => file.content), "nothing of the author's is written before the author applies");

    for (const body of [{ run: done.state.design.startedAt }, { run: done.state.design.startedAt, apply: "f1-goal" }, { run: done.state.design.startedAt, apply: [], extra: 1 }]) {
      const answer = await api("POST", "/api/v1/books/b/autopilot/design/proposals", body);
      assert.deepEqual([answer.status, answer.json?.code], [400, "invalid_request"], JSON.stringify(body));
    }
    const stale = await api("POST", "/api/v1/books/b/autopilot/design/proposals", { run: "2020-01-01T00:00:00.000Z", apply: [] });
    assert.deepEqual([stale.status, stale.json?.code], [409, "stale"]);
    const result = await client.applyDesignProposals("b", { run: done.state.design.startedAt, apply: ["f1-goal", "f2-ending"] });
    assert.deepEqual({ applied: result.applied, chapters: result.chapters }, { applied: 2, chapters: [1, 2] });
    const files = await client.readFiles("b", ["outline/chapters/001.md", "outline/chapters/002.md", "outline/changes.yml"]);
    const [first, second] = await Promise.all(files.slice(0, 2).map((file, index) => readOutlineChapter(file.path, index + 1, file.content)));
    assert.equal(first.entry.design.goal, "Proposed goal of chapter 1.");
    assert.equal(first.entry.body, "Event 1 happens and the story turns.");
    assert.equal(first.entry.origin, "author");
    assert.equal(second.entry.design.ending, "Proposed ending of chapter 2.");
    assert.match(files[2].content, /by: autopilot/);
    const again = await api("POST", "/api/v1/books/b/autopilot/design/proposals", { run: done.state.design.startedAt, apply: [] });
    assert.deepEqual([again.status, again.json?.code], [409, "no_proposals"]);
  });
});

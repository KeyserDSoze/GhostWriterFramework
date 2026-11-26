import test from "node:test";
import assert from "node:assert/strict";
import { SERVER_FEATURE_AUTOPILOT_DESIGN, parseAutopilotState, readOutlineChapter, serverSupportsDesign } from "narrarium-engine";
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

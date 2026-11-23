import test from "node:test";
import assert from "node:assert/strict";
import { SERVER_FEATURE_AUTOPILOT_OUTLINE_BRIEF, serverHasOutlineBrief } from "narrarium-engine";
import { withServer } from "./helpers.mjs";
import { seededBook } from "./fake-provider.mjs";

// A server takes the length of a book from its Scaletta, so it announces `autopilot-outline-brief`: the engine's client starts and configures
// the autopilot of such a server, and refuses one that does not announce it (see the engine's tests).

test("the server announces autopilot-outline-brief in its info, and the engine's client starts and configures a book through it", async () => {
  await withServer(async (server, client) => {
    const info = await client.info();
    assert.equal(SERVER_FEATURE_AUTOPILOT_OUTLINE_BRIEF, "autopilot-outline-brief");
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_OUTLINE_BRIEF), JSON.stringify(info.features));
    assert.equal(serverHasOutlineBrief(info), true);
    const bookId = await seededBook(client, "b");
    const configured = await client.configureAutopilot(bookId, { brief: { idea: "A harbor of glass." } });
    assert.equal(configured.state.brief.idea, "A harbor of glass.");
    const started = await client.startAutopilot(bookId, { options: { readers: false, readersOnPlan: false, pauseAfterPlan: true, specialists: false } });
    assert.ok(started.state, "the start is answered with the snapshot");
  });
});

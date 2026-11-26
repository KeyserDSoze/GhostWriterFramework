import test from "node:test";
import assert from "node:assert/strict";
import { withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { FAST, startOf } from "./hold.mjs";

// The budgets of the Costs page (spec point 5) reach a book on the personal server as the money cap of its autopilot: the browser that starts the run sends it in the options of
// `start`, and the engine's own cap pauses the run before the step that would pass it, with the reason the site shows (`limitReached`). Nothing of this is new on the server: these
// tests say it keeps being true. With the engine's fake AI every call costs 0.001 or 0.002 USD.

test("a cap in the options of `start` pauses the run before its next step, with the numbers of the stop, and a start with a higher cap goes on to the end", async () => {
  await withServer(async (_server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    await client.startAutopilot("b", startOf(2, { options: { ...FAST, budgetLimit: 0.006 } }));
    const stopped = await finished(client, "b");
    assert.equal(stopped.state.status, "paused", stopped.state.lastError?.message);
    assert.equal(stopped.state.options.budgetLimit, 0.006, "the cap is the options' own: the configuration shows it");
    assert.equal(stopped.state.limitReached.kind, "money");
    assert.equal(stopped.state.limitReached.limit, 0.006);
    assert.equal(stopped.state.limitReached.currency, "USD");
    assert.ok(stopped.state.stats.cost >= 0.006, `stopped at what it spent: ${stopped.state.stats.cost}`);
    assert.ok(stopped.state.stats.cost < 0.012, `before the next step, not a whole book past it: ${stopped.state.stats.cost}`);
    const snapshot = await client.autopilot("b");
    assert.equal(snapshot.summary.limitReached?.kind, "money", "the summary the browser follows says it too");
    assert.equal(snapshot.summary.limitReached?.limit, 0.006);

    // The cap that is left of the budgets once they are raised: a start gives the engine the new cap, and the stop is taken away.
    await client.startAutopilot("b", { options: { budgetLimit: 1 } });
    const done = await finished(client, "b");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    assert.equal(done.state.options.budgetLimit, 1);
    assert.equal(done.state.limitReached, undefined);
    assert.ok(done.state.stats.cost > stopped.state.stats.cost);
  });
});

test("a cap that is already reached stops a resumed run before its first step: the cap of a book is the cost over all its runs and never resets", async () => {
  await withServer(async (_server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    await client.startAutopilot("b", startOf(2, { options: { ...FAST, budgetLimit: 0.006 } }));
    const first = await finished(client, "b");
    assert.equal(first.state.status, "paused");
    const cost = first.state.stats.cost;
    // What the browser computes at a start when the budgets leave nothing: the cost the engine counts for the book, which is the cap.
    await client.startAutopilot("b", { options: { budgetLimit: cost } });
    const again = await finished(client, "b");
    assert.equal(again.state.status, "paused");
    assert.equal(again.state.limitReached.kind, "money");
    assert.equal(again.state.stats.cost, cost, "no step was started: nothing more was spent");
  });
});

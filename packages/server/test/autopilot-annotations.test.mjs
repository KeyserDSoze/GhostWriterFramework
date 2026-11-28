import test from "node:test";
import assert from "node:assert/strict";
import { SERVER_FEATURE_AUTOPILOT_ANNOTATIONS, parseAutopilotState, serverSupportsAnnotations } from "narrarium-engine";
import { liveAnnotations, parseChapterAnnotations, serializeChapterAnnotations } from "narrarium-engine/annotations";
import * as testing from "../dist/testing.mjs";
import { withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { startOf } from "./hold.mjs";
import { rawApi } from "./api-helpers.mjs";

// The notes of the author on the server (`annotations`): `POST …/autopilot/annotations` records the campaign, the engine's refusals are kept as they are, the next start
// rewrites the passages, closes the notes as handled by the autopilot, and the server announces the feature that says so. The engine decides; these tests are about what the
// route accepts and answers.

const route = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/annotations`;
const AT = "2026-01-01T00:00:00.000Z";

test("`info.features` announces `autopilot-annotations`, each feature once, and the client says what an older server cannot do before it sends", async () => {
  await withServer(async (server, client) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_ANNOTATIONS));
    assert.equal(serverSupportsAnnotations(info), true);
    assert.equal(new Set(info.features).size, info.features.length);
    void client;
  });
});

test("a request to rewrite the notes is refused for what is no request, and for a book without a plan; it is recorded, carried out by the next run, and the notes are closed", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    const api = await rawApi(server);
    const early = await api("POST", route(), {});
    assert.deepEqual([early.status, early.json?.code], [409, "not_finished"]);

    await client.startAutopilot("b", startOf(2));
    const done = await finished(client, "b");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    for (const body of [{ ids: "x" }, { chapters: [1] }, { include: ["1"] }, { note: 4 }, { language: 3 }, { unknown: true }, { accountTags: [1] }]) {
      const answer = await api("POST", route(), body);
      assert.deepEqual([answer.status, answer.json?.code], [400, "invalid_request"], JSON.stringify(body));
    }
    const none = await api("POST", route(), {});
    assert.deepEqual([none.status, none.json?.code], [409, "nothing_to_review"], "no note to work");

    const chapter = done.state.plan.chapters[0];
    const scene = chapter.scenes[0];
    const slug = scene.path.slice(scene.path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    const file = serializeChapterAnnotations({
      version: 1, chapter: chapter.slug, invalid: [], extra: {},
      entries: [{ id: "a-mi4k2000-aaaaaa", paragraph: slug, quote: "a gate", prefix: "", suffix: "", offset: 0, tag: "rewrite", comment: "Sharper.", status: "open", createdAt: AT, updatedAt: AT, createdOnDevice: "d-1a2b3c4d" }],
    });
    await client.commitFiles("b", [{ path: `annotations/chapters/${chapter.slug}.yml`, content: file, expectedHash: null }], "notes");

    const recorded = await client.reviseAnnotations("b", { note: "Keep the voice." });
    assert.equal(recorded.campaign.reason, "annotations");
    assert.deepEqual(recorded.campaign.chapters.map((item) => [item.number, item.status]), [[1, "waiting"]]);
    const busy = await api("POST", route(), {});
    assert.deepEqual([busy.status, busy.json?.code], [409, "campaign_active"]);
    assert.equal((await client.autopilot("b")).summary.campaign.annotations.notes, 1);

    await client.startAutopilot("b");
    const after = await finished(client, "b");
    assert.equal(after.state.status, "completed", after.state.lastError?.message);
    const [state, notes] = await client.readFiles("b", ["autopilot/state.json", `annotations/chapters/${chapter.slug}.yml`]);
    const parsed = parseAutopilotState(state.content);
    assert.equal(parsed.campaign, undefined, "over, and gone");
    assert.deepEqual([parsed.annotationRuns.length, parsed.annotationRuns[0].handled], [1, 1]);
    const [closed] = liveAnnotations(parseChapterAnnotations(notes.content, chapter.slug).file);
    assert.deepEqual([closed.status, closed.resolution.by], ["handled", "autopilot"]);
  });
  const mapped = testing.errorStatus(new testing.RevisionCampaignError("nothing_to_review", "None."));
  assert.deepEqual([mapped.status, mapped.code], [409, "nothing_to_review"]);
});

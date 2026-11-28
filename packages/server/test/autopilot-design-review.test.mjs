import test from "node:test";
import assert from "node:assert/strict";
import { SERVER_FEATURE_AUTOPILOT_DESIGN_REVIEW, asksDesignReview, serverSupportsDesignReview } from "narrarium-engine";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import * as testing from "../dist/testing.mjs";
import { withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { rawApi } from "./api-helpers.mjs";

// The reviews of a design on the server (#108, phase 3): `POST …/autopilot/start` takes a `design` with a `workflow` (alternative pitches, the review of every chapter, the analysis of the
// structure, the rubric) or a review on request (`reviewOnly`); `POST …/autopilot/design/pitch` is the author's choice among the pitches and `POST …/autopilot/design/finding` her
// decision about a finding; the server announces `autopilot-design-review`. The engine decides: these tests are about what the routes accept and answer.

const OPTIONS = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const WORKFLOW = { rubric: true, chapterReview: true, coherence: true, alternatives: 2, pitchChoice: "author" };
const FINDING = { severity: "major", kind: "timeline", chapters: [2, 3], requires: [3], text: "The ferry runs on a closed day.", proposal: "Move it a day." };

const withReviews = (run) => withServer(run, { ai: createFakeAutopilotAi({ coherence: () => ({ findings: [FINDING], summary: "One thing." }) }) });

test("#108: `info.features` announces `autopilot-design-review`, and the refusals of a choice or a decision are 400 and 409", async () => {
  await withServer(async (server) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.equal(SERVER_FEATURE_AUTOPILOT_DESIGN_REVIEW, "autopilot-design-review");
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_DESIGN_REVIEW));
    assert.equal(serverSupportsDesignReview(info), true);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
  });
  for (const [code, status] of [["unknown_pitch", 400], ["unknown_finding", 400], ["no_pitches", 409], ["pitch_locked", 409], ["design_active", 409], ["design_no_chapters", 409], ["no_findings", 409], ["not_fixable", 409]]) {
    const mapped = testing.errorStatus(new testing.AutopilotDesignError(code, `Message of ${code}.`));
    assert.deepEqual([mapped.status, mapped.code], [status, code]);
  }
});

test("#108: a design with a workflow is validated by the engine, and what asks for the reviews is told so", async () => {
  assert.equal(asksDesignReview({ chapters: 8 }), false);
  assert.equal(asksDesignReview({ workflow: { alternatives: 3, pitchChoice: "author" } }), true);
  assert.equal(asksDesignReview({ reviewOnly: true }), true);
  assert.equal(asksDesignReview({ workflow: { rubric: false, alternatives: 0 } }), false, "what takes it all back is sent anywhere");
  assert.equal(asksDesignReview({ workflow: null }), false);
  assert.equal(asksDesignReview(false), false);
  assert.equal(asksDesignReview("yes"), false);
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 0 });
    const api = await rawApi(server);
    for (const design of [{ workflow: true }, { workflow: { alternatives: 1 } }, { workflow: { pitchChoice: "reader" } }, { workflow: { rubrics: true } }, { reviewOnly: "yes" }, { reviewOnly: true, chapters: 3 }]) {
      const answer = await api("POST", "/api/v1/books/b/autopilot/start", { design, options: OPTIONS });
      assert.deepEqual([answer.status, answer.json?.code], [400, "invalid_request"], JSON.stringify(design));
    }
    assert.equal((await client.autopilot("b")).state, null, "nothing started");
  });
});

test("#108: the author is asked to choose a pitch, chooses one over the route, and the autopilot designs the book from it with the reviews of the design", async () => {
  await withReviews(async (server, client) => {
    await seededBook(client, "b", { chapters: 0 });
    const api = await rawApi(server);
    // Nothing to choose from yet.
    const none = await api("POST", "/api/v1/books/b/autopilot/design/pitch", { id: "p1" });
    assert.deepEqual([none.status, none.json?.code], [409, "no_pitches"]);

    await client.startAutopilot("b", { brief: { idea: IDEA }, design: { chapters: 4, workflow: WORKFLOW }, options: OPTIONS });
    const asked = await finished(client, "b");
    assert.equal(asked.state.status, "waiting-author", asked.state.lastError?.message);
    assert.equal(asked.state.message, "Choose the pitch the book is designed from.");
    assert.equal(asked.state.design.alternatives.pitches.length, 2);
    assert.equal(asked.state.design.alternatives.selected, undefined);
    assert.deepEqual(asked.activities.map((activity) => activity.task), ["design-pitches", "design-pitch-review"]);

    // Refusals: a body that is not one, a pitch there is not.
    for (const body of [{}, { id: "" }, { id: 3 }, { id: "p1", reason: 3 }, { id: "p1", why: "x" }, { id: "p".repeat(30) }]) {
      const refused = await api("POST", "/api/v1/books/b/autopilot/design/pitch", body);
      assert.deepEqual([refused.status, refused.json?.code], [400, "invalid_request"], JSON.stringify(body));
    }
    const unknown = await api("POST", "/api/v1/books/b/autopilot/design/pitch", { id: "p9" });
    assert.deepEqual([unknown.status, unknown.json?.code], [400, "unknown_pitch"]);

    const chosen = await client.chooseDesignPitch("b", { id: "p1", reason: "It is the one I had in mind." });
    assert.deepEqual(chosen.state.design.alternatives.selected, { id: "p1", by: "author", reason: "It is the one I had in mind.", at: chosen.state.design.alternatives.selected.at });
    assert.equal(chosen.running, false, "nothing is started");

    await client.startAutopilot("b", { design: { chapters: 4, workflow: WORKFLOW }, options: OPTIONS });
    const done = await finished(client, "b");
    assert.equal(done.state.status, "paused", done.state.lastError?.message);
    assert.equal(done.state.design.outcome, "target");
    assert.deepEqual(done.activities.map((activity) => activity.task), ["design-pitches", "design-pitch-review", "concept", "plan", "design-chapter-review", "design-coherence", "plan-review"]);
    assert.equal(done.state.design.alternatives.selected.by, "author");
    assert.equal(Object.keys(done.state.design.reviewed).length, 4);
    assert.equal(done.state.design.coherence.findings.length, 1);
    assert.ok(done.state.design.rubric.design.history.length >= 1);
    assert.equal(done.summary.design.chapters, 4);
    // The book is designed from a pitch now: another cannot be chosen.
    const late = await api("POST", "/api/v1/books/b/autopilot/design/pitch", { id: "p2" });
    assert.deepEqual([late.status, late.json?.code], [409, "pitch_locked"]);
  });
});

test("#108: the author decides about a finding over the route and the decision holds, and a review on request is made over the route", async () => {
  await withReviews(async (server, client) => {
    await seededBook(client, "b", { chapters: 0 });
    const api = await rawApi(server);
    const early = await api("POST", "/api/v1/books/b/autopilot/design/finding", { id: "a-00000001", action: "fix" });
    assert.deepEqual([early.status, early.json?.code], [409, "no_findings"]);

    await client.startAutopilot("b", { brief: { idea: IDEA }, design: { chapters: 4, workflow: { rubric: true, chapterReview: true, coherence: true } }, options: OPTIONS });
    const designed = await finished(client, "b");
    assert.equal(designed.state.status, "paused", designed.state.lastError?.message);
    const [finding] = designed.state.design.coherence.findings;
    assert.equal(finding.status, "open");
    assert.equal(finding.owner, "autopilot");

    for (const body of [{}, { id: finding.id }, { id: finding.id, action: "delete" }, { id: finding.id, action: "fix", extra: 1 }, { id: finding.id, action: "fix", reason: 5 }, { id: 5, action: "fix" }]) {
      const refused = await api("POST", "/api/v1/books/b/autopilot/design/finding", body);
      assert.deepEqual([refused.status, refused.json?.code], [400, "invalid_request"], JSON.stringify(body));
    }
    const unknown = await api("POST", "/api/v1/books/b/autopilot/design/finding", { id: "a-99999999", action: "mine" });
    assert.deepEqual([unknown.status, unknown.json?.code], [400, "unknown_finding"]);

    const taken = await client.decideDesignFinding("b", { id: finding.id, action: "mine", reason: "I will do it." });
    assert.equal(taken.state.design.coherence.findings[0].status, "mine");
    assert.deepEqual(taken.state.design.coherence.findings[0].decision, { by: "author", reason: "I will do it.", at: taken.state.design.coherence.findings[0].decision.at });
    const asked = await client.decideDesignFinding("b", { id: finding.id, action: "fix" });
    assert.equal(asked.state.design.coherence.findings[0].status, "fixing");
    assert.equal(asked.running, false, "nothing is started");

    // A review on request: the chapters asked for are judged again, nothing is designed, and the run stops.
    const before = (await client.autopilot("b")).activities.length;
    await client.startAutopilot("b", { design: { reviewOnly: { chapters: [2] } } });
    const reviewed = await finished(client, "b");
    assert.equal(reviewed.state.status, "paused", reviewed.state.lastError?.message);
    assert.deepEqual(reviewed.activities.slice(before).map((activity) => activity.task), ["design-chapter-review"]);
    assert.match(reviewed.state.message, /^Review of the design of chapter 2 done/);
    assert.equal(reviewed.state.design.outcome, "target", "the design is as it was");
    assert.equal(reviewed.state.design.coherence.findings[0].status, "fixing", "and so is the decision");
    // The whole design, on request, finds the finding again: it is the same, with the decision the author took.
    await client.startAutopilot("b", { design: { reviewOnly: true } });
    const whole = await finished(client, "b");
    assert.equal(whole.state.design.coherence.findings.length, 1);
    assert.equal(whole.state.design.coherence.findings[0].id, finding.id);
    assert.equal(whole.state.design.coherence.findings[0].status, "fixing");
    // A review is refused for a book with no chapters.
    await seededBook(client, "empty", { chapters: 0 });
    const empty = await api("POST", "/api/v1/books/empty/autopilot/start", { design: { reviewOnly: true } });
    assert.deepEqual([empty.status, empty.json?.code], [409, "design_no_chapters"]);
  });
});

test("#108: the routes need the run scope", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 0 });
    const readOnly = await rawApi(server, ["read"]);
    for (const [route, body] of [["pitch", { id: "p1" }], ["finding", { id: "a-00000001", action: "mine" }]]) {
      const answer = await readOnly("POST", `/api/v1/books/b/autopilot/design/${route}`, body);
      assert.equal(answer.status, 403, route);
    }
  });
});

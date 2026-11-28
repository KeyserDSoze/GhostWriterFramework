import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// A design with reviews goes only to a personal server that announces `autopilot-design-review`: an older one refuses a design with a key it does not know, and the engine's client
// says why, before anything is sent. The author's choice of a pitch and her decisions about the findings have their routes, with the same guard.

const serverWith = (features) => {
  const log = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    log.push({ method: init.method ?? "GET", path: url.pathname, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (url.pathname === "/api/v1/info") return Response.json({ name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.26", engineVersion: "0.1.31", serverId: "s", label: "Test", git: true, features, publicKey: "k", fingerprint: "f", supervised: false });
    return Response.json({ bookId: "b", state: null, summary: null, activities: [], live: null, running: false, host: "server" });
  };
  return { log, client: new engine.NarrariumServerClient({ baseUrl: "http://127.0.0.1:24242", token: "nrs_me", fetch }) };
};

const OLD = ["autopilot", "autopilot-outline-brief", "autopilot-design"];
const CURRENT = [...OLD, "autopilot-design-review"];

test("the feature is named, and an odd answer says no", () => {
  assert.equal(engine.SERVER_FEATURE_AUTOPILOT_DESIGN_REVIEW, "autopilot-design-review");
  assert.equal(engine.serverSupportsDesignReview({ features: CURRENT }), true);
  for (const odd of [null, undefined, {}, { features: "autopilot-design-review" }, ["autopilot-design"], { features: OLD }]) assert.equal(engine.serverSupportsDesignReview(odd), false, JSON.stringify(odd));
});

test("what asks for the reviews of a design is told from what a plain design is, and what takes them back goes anywhere", () => {
  const asks = engine.asksDesignReview;
  for (const plain of [undefined, null, true, false, "yes", [], {}, { chapters: 8 }, { chapters: 8, review: { maxRounds: 3 } }, { workflow: null }, { workflow: {} }, { workflow: { rubric: false, alternatives: 0, pitchChoice: "director" } }]) assert.equal(asks(plain), false, JSON.stringify(plain));
  for (const reviews of [{ workflow: { rubric: true } }, { workflow: { chapterReview: true } }, { workflow: { coherence: true } }, { workflow: { alternatives: 3 } }, { workflow: { pitchChoice: "author" } }, { reviewOnly: true }, { reviewOnly: {} }, { reviewOnly: { chapters: [2] } }]) assert.equal(asks(reviews), true, JSON.stringify(reviews));
});

test("a design with reviews is refused before anything is sent to a server that does not announce them, and goes to one that does; a plain design goes to both", async () => {
  const old = serverWith(OLD);
  for (const design of [{ chapters: 8, workflow: { rubric: true } }, { reviewOnly: true }, { workflow: { alternatives: 3, pitchChoice: "author" } }]) {
    const error = await old.client.startAutopilot("b", { design }).then(() => null, (failure) => failure);
    assert.equal(error?.code, "feature_unavailable", JSON.stringify(design));
    assert.equal(error.status, 501);
    assert.match(error.message, /does not have the reviews of a design \(it does not announce the feature autopilot-design-review\)/);
  }
  assert.deepEqual(old.log.map((request) => request.path), ["/api/v1/info", "/api/v1/info", "/api/v1/info"], "nothing is sent but the question of the features");
  await old.client.startAutopilot("b", { design: { chapters: 8, review: { maxRounds: 4 } } });
  assert.equal(old.log.at(-1).path, "/api/v1/books/b/autopilot/start", "a plain design is as it was");
  await old.client.startAutopilot("b", { design: { chapters: 8, workflow: null } });
  assert.deepEqual(old.log.at(-1).body, { design: { chapters: 8, workflow: null } }, "taking the workflow back is safe anywhere");
  const current = serverWith(CURRENT);
  const design = { chapters: 8, workflow: { rubric: true, chapterReview: true, coherence: true, alternatives: 3, pitchChoice: "author" } };
  await current.client.startAutopilot("b", { design });
  assert.deepEqual(current.log.at(-1).body, { design });
  await current.client.startAutopilot("b", { design: { reviewOnly: { chapters: [4] } } });
  assert.deepEqual(current.log.at(-1).body, { design: { reviewOnly: { chapters: [4] } } });
});

test("the choice of a pitch and the decision about a finding go to their routes, and are refused before anything is sent to a server without the reviews", async () => {
  const old = serverWith(OLD);
  for (const call of [() => old.client.chooseDesignPitch("b", { id: "p1" }), () => old.client.decideDesignFinding("b", { id: "a-00000001", action: "fix" })]) {
    const error = await call().then(() => null, (failure) => failure);
    assert.equal(error?.code, "feature_unavailable");
    assert.equal(error.status, 501);
  }
  assert.deepEqual(old.log.map((request) => request.path), ["/api/v1/info", "/api/v1/info"]);
  const current = serverWith(CURRENT);
  await current.client.chooseDesignPitch("b", { id: "p2", reason: "It is the bold one." });
  assert.deepEqual([current.log.at(-1).method, current.log.at(-1).path, current.log.at(-1).body], ["POST", "/api/v1/books/b/autopilot/design/pitch", { id: "p2", reason: "It is the bold one." }]);
  await current.client.decideDesignFinding("b", { id: "a-00000001", action: "mine" });
  assert.deepEqual([current.log.at(-1).method, current.log.at(-1).path, current.log.at(-1).body], ["POST", "/api/v1/books/b/autopilot/design/finding", { id: "a-00000001", action: "mine" }]);
});

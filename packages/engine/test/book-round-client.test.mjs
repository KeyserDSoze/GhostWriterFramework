import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// The book-level round of a review (#113) and the personal server: when it may be sent the round, the route that carries the author's decision, and the refusals before anything is sent.

test("a personal server is sent the book-level round only if it announces it", async () => {
  const log = [];
  const makeClient = (features) => new engine.NarrariumServerClient({
    baseUrl: "http://127.0.0.1:24242",
    token: "nrs_me",
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/info") return Response.json({ serverId: "s", name: "Home", version: "0.1.22", protocol: 1, features });
      log.push({ method: init.method ?? "GET", path: url.pathname, body: init.body ? JSON.parse(init.body) : undefined });
      return Response.json(url.pathname.endsWith("/review") || url.pathname.endsWith("/corrections") ? { campaign: null, frozen: { mode: "ask", changes: [], pending: [], warnings: [] } } : { state: null });
    },
  });
  const known = [
    "autopilot",
    "autopilot-outline-brief",
    engine.SERVER_FEATURE_AUTOPILOT_OUTLINE_APPLY,
    engine.SERVER_FEATURE_AUTOPILOT_REVIEW_BOOK,
    engine.SERVER_FEATURE_AUTOPILOT_REVIEW_POLICY,
    engine.SERVER_FEATURE_AUTOPILOT_REVIEW_TARGETS,
  ];
  const all = [...known, engine.SERVER_FEATURE_AUTOPILOT_REVIEW_BOOK_ROUND];
  assert.equal(engine.SERVER_FEATURE_AUTOPILOT_REVIEW_BOOK_ROUND, "autopilot-review-book-round");
  assert.deepEqual(
    [engine.serverSupportsReviewBookRound({ features: all }), engine.serverSupportsReviewBookRound(all), engine.serverSupportsReviewBookRound({ features: known }), engine.serverSupportsReviewBookRound(null), engine.serverSupportsReviewBookRound({ features: "autopilot-review-book-round" })],
    [true, true, false, false, false],
  );
  assert.deepEqual(
    [engine.asksReviewBookRound({ bookRound: "apply" }), engine.asksReviewBookRound({ bookRound: "ask" }), engine.asksReviewBookRound({ bookRound: "off" }), engine.asksReviewBookRound({ bookRound: null }), engine.asksReviewBookRound({}), engine.asksReviewBookRound(undefined), engine.asksReviewBookRound({ bookRound: "later" })],
    [true, true, false, false, false, false, false],
    "a mode that turns it on asks; taking it back (`off`, null) is sent anywhere: an older server has nothing of it to take back",
  );

  const newer = makeClient(all);
  await newer.startAutopilot("my book", { options: { review: { targetScore: 8, bookRound: "ask" } } });
  await newer.configureAutopilot("my book", { options: { review: { bookRound: "apply" } } });
  await newer.reviewBook("my book", { targetScore: 8, bookRound: "ask" });
  await newer.decideBookCorrections("my book", { round: 2, action: "apply", chosen: [1, 3] });
  assert.deepEqual(log.map((entry) => [entry.method, entry.path]), [
    ["POST", "/api/v1/books/my%20book/autopilot/start"],
    ["POST", "/api/v1/books/my%20book/autopilot/configure"],
    ["POST", "/api/v1/books/my%20book/autopilot/review"],
    ["POST", "/api/v1/books/my%20book/autopilot/review/corrections"],
  ]);
  assert.deepEqual(log[0].body.options.review, { targetScore: 8, bookRound: "ask" });
  assert.deepEqual(log[3].body, { round: 2, action: "apply", chosen: [1, 3] });

  const older = makeClient(known);
  await older.startAutopilot("my book", { options: { review: { targetScore: 8, bookRound: "off" } } });
  await older.configureAutopilot("my book", { options: { review: { bookRound: null } } });
  await older.reviewBook("my book", { targetScore: 8, bookRound: "off" });
  const sent = log.length;
  const refusal = (error) => error.code === "feature_unavailable" && error.status === 501 && /autopilot-review-book-round/.test(error.message) && /update the server/i.test(error.message);
  await assert.rejects(older.startAutopilot("my book", { options: { review: { bookRound: "apply" } } }), refusal);
  await assert.rejects(older.configureAutopilot("my book", { options: { review: { bookRound: "ask" } } }), refusal);
  await assert.rejects(older.reviewBook("my book", { targetScore: 8, bookRound: "apply" }), refusal);
  await assert.rejects(older.decideBookCorrections("my book", { round: 1, action: "decline" }), refusal);
  assert.equal(log.length, sent, "nothing was sent to the server that does not know it");
});

test("the campaigns that carry the corrections of the book are those of a review, and a refusal has a code the client knows", () => {
  assert.equal(engine.CAMPAIGN_FEATURES["review-target"], engine.SERVER_FEATURE_AUTOPILOT_REVIEW_BOOK);
  assert.equal(engine.isRevisionCampaignErrorCode("no_proposal"), true);
  assert.equal(engine.isRevisionCampaignErrorCode("proposal"), false);
});

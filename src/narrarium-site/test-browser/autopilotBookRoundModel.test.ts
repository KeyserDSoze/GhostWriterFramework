import { describe, expect, it } from "vitest";
import { bookRoundOf, bookRoundSummary, bookUnderTarget, decisionOf, defaultChosen, lastBookRounds, overBookRounds, proposalOf } from "@/autopilot/bookRound";
import { judgedPlan, planOf } from "./helpers/autopilotFixtures";
import { POINTS, bookRound, correction, endedReview, reviewCampaign, roundRecord, stateWith } from "./helpers/autopilotBookRound";

const plan = planOf(judgedPlan());

describe("the corrections of the whole book, as the page reads them from the state", () => {
  it("reads the round in progress with each correction's chapter, its words and the points of the judgement it answers", () => {
    const view = bookRoundOf(stateWith({ plan, campaign: reviewCampaign(bookRound()) }));
    expect(view).toMatchObject({ round: 2, status: "proposed", score: 7.4, target: 9, chapters: 2, applied: 0, taken: false, summary: "Two chapters carry the weight of the ending." });
    expect(view?.rows.map((row) => [row.number, row.chapter, row.title, row.slug, row.held, row.status])).toEqual([[1, 3, "Title 3", "003-chapter-3", false, "waiting"], [2, 9, "Title 9", "009-chapter-9", false, "waiting"]]);
    expect(view?.rows[0].answers).toEqual([POINTS[0]]);
    expect(view?.rows[1].answers, "a correction may answer several points").toEqual([POINTS[0], POINTS[1]]);
  });

  it("is nothing for a state with no review in a book-level round, whatever else it holds", () => {
    expect(bookRoundOf(stateWith({ plan }))).toBeNull();
    expect(bookRoundOf(stateWith({ plan, campaign: reviewCampaign(undefined) }))).toBeNull();
    expect(bookRoundOf(stateWith({ plan, campaign: { ...reviewCampaign(bookRound()), reason: "outline-change", review: undefined } }))).toBeNull();
  });

  it("says a point that is not there as nothing (a judgement of an older engine has none), and keeps the chapter of a plan that lost it as a number", () => {
    const view = bookRoundOf(stateWith({ plan, campaign: reviewCampaign(bookRound({ verdict: { score: null, points: [] }, corrections: [correction(40, { cites: [1] })] })) }));
    expect(view?.score).toBeNull();
    expect(view?.rows[0]).toMatchObject({ chapter: 40, answers: [] });
    expect(view?.rows[0].title).toBeUndefined();
    expect(view?.rows[0].slug).toBeUndefined();
  });

  it("marks the corrections that ask a change of a chapter of the author's, and counts what is carried out", () => {
    const view = bookRoundOf(stateWith({ plan, campaign: reviewCampaign(bookRound({ status: "applying", corrections: [correction(3, { status: "applied" }), correction(4, { held: "author" }), correction(9, { status: "left-out", why: "gone" })] })) }));
    expect(view?.rows.map((row) => [row.held, row.status, row.why])).toEqual([[false, "applied", undefined], [true, "waiting", undefined], [false, "left-out", "gone"]]);
    expect(view?.applied).toBe(1);
    expect(view?.chapters).toBe(3);
  });

  it("has a proposal only while the corrections wait for the author", () => {
    expect(proposalOf(stateWith({ plan, campaign: reviewCampaign(bookRound()) }))?.rows).toHaveLength(2);
    for (const status of ["asking", "applying", "declined", "stopped"] as const) expect(proposalOf(stateWith({ plan, campaign: reviewCampaign(bookRound({ status })) })), status).toBeNull();
    expect(proposalOf(stateWith({ plan, campaign: reviewCampaign(bookRound({ corrections: [] })) })), "nothing to decide on").toBeNull();
  });

  it("ticks, before the author chooses, every correction but those of a chapter that is the author's", () => {
    const view = bookRoundOf(stateWith({ plan, campaign: reviewCampaign(bookRound({ corrections: [correction(3), correction(4, { held: "author" }), correction(9)] })) }));
    expect([...defaultChosen(view!.rows)]).toEqual([1, 3]);
  });

  it("makes the decision the author's choice stands for: those ticked are carried out, with none ticked the round is declined", () => {
    expect(decisionOf({ round: 2 }, new Set([3, 1]))).toEqual({ round: 2, action: "apply", chosen: [1, 3] });
    expect(decisionOf({ round: 2 }, new Set())).toEqual({ round: 2, action: "decline" });
  });

  it("reads what the director asked in the last review that ended, round by round, and in the rounds of the review in progress", () => {
    const record = { round: 1, ...roundRecord() };
    const second = { round: 3, ...roundRecord({ score: 7.6, corrections: [correction(9, { status: "applied" })] }) };
    const rounds = lastBookRounds(stateWith({ plan, reviews: [endedReview([{ round: 9, ...roundRecord() }], { outcome: "target" }), endedReview([record, second])] }));
    expect(rounds.map((round) => [round.round, round.score, round.rows.map((row) => [row.chapter, row.status, row.why])])).toEqual([[1, 7.4, [[3, "applied", undefined], [9, "left-out", "declined"]]], [3, 7.6, [[9, "applied", undefined]]]]);
    expect(lastBookRounds(stateWith({ plan }))).toEqual([]);
    expect(lastBookRounds(stateWith({ plan, reviews: [endedReview([])] }))).toEqual([]);

    const over = overBookRounds(stateWith({ plan, campaign: reviewCampaign(bookRound(), { history: [{ round: 1, chapters: [], lowest: 9, book: 7.4, below: 0, endedAt: "2026-11-21T10:30:00.000Z", bookRound: roundRecord() }, { round: 2, chapters: [3], lowest: 9, book: 7.5, below: 0, endedAt: "2026-11-21T10:40:00.000Z" }] }) }));
    expect(over.map((round) => round.round)).toEqual([1]);
  });

  it("says the book is under its target only for a vote that was given and is lower", () => {
    expect(bookUnderTarget(7.4, 9)).toEqual({ score: 7.4, target: 9 });
    expect(bookUnderTarget(9, 9)).toBeNull();
    expect(bookUnderTarget(undefined, 9)).toBeNull();
    expect(bookUnderTarget(null, 9)).toBeNull();
  });

  it("reads where a round stands from the summary the band has", () => {
    expect(bookRoundSummary(undefined)).toBeNull();
    expect(bookRoundSummary({ id: "c", reason: "review-target", total: 0, done: 0, current: null, waiting: [] })).toBeNull();
    expect(bookRoundSummary({ id: "c", reason: "review-target", total: 0, done: 0, current: null, waiting: [], review: { round: 2, roundsThisRun: 1, targetScore: 9, phase: "book", lowest: 9, book: 7.4, budgetLimit: 0, bookRound: { status: "applying", corrections: 3, applied: 1 } } })).toEqual({ status: "applying", corrections: 3, applied: 1 });
  });
});

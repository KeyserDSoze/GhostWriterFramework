import { reply, votingAi } from "./review-fakes.mjs";

// The fakes of the tests of the book-level round: a director who votes as a script says (see `votingAi`), whose judgement of the whole book has points a correction can cite, and
// who answers the request for the corrections of the book as `corrections` says.

/** The default corrections: one, for chapter `chapter`, citing the first point. */
export const oneCorrection = (chapter = 1) => ({
  summary: "The ending is not earned.",
  corrections: [{ chapterNumber: chapter, change: "Plant the setup of the ending in the first scene.", reason: "The ending pays off a promise that the book never made.", cites: [1] }],
});

/**
 * The fake AI: `chapters` and `books` as in `votingAi`; the judgement of the book has `concerns` and `nextSteps` (its points, numbered from 1 when cited); `corrections(call, user)`
 * answers the request for the corrections of the book (default: `oneCorrection(1)`); the revision of a chapter finds its scene 1 as the instruction names the chapter. `asked` keeps what was asked.
 */
export function bookRoundAi({
  chapters = {},
  books = [6],
  concerns = [{ severity: "major", issue: "The ending is not earned", suggestion: "Plant its setup earlier" }],
  nextSteps = ["Tighten the middle chapters"],
  corrections = () => oneCorrection(1),
} = {}) {
  const base = votingAi({ chapters, books });
  const asked = [];
  const revised = [];
  return {
    calls: base.calls,
    decided: base.decided,
    judged: base.judged,
    asked,
    revised,
    async complete(request) {
      if (request.label === "director:book") {
        base.calls.push(request);
        const score = books[Math.min(base.judged.length, books.length - 1)];
        base.judged.push({ score, user: request.user });
        return reply({ verdict: "approve", score, summary: "The book as a whole.", strengths: ["Atmosphere"], concerns, decisions: [], nextSteps, questionsForAuthor: [] });
      }
      if (request.label === "autopilot:book-corrections") {
        base.calls.push(request);
        asked.push({ user: request.user, system: request.system });
        return reply(corrections(asked.length, request.user));
      }
      if (request.json?.name === "revision_impact") {
        base.calls.push(request);
        const chapter = Number(/asks for changes to chapter (\d+)/.exec(request.user)?.[1] ?? "1");
        revised.push({ chapter, user: request.user });
        return reply({ summary: "Only the first scene changes.", targets: [{ chapterNumber: chapter, sceneNumber: 1, instruction: "Apply the correction." }] });
      }
      return base.complete(request);
    },
  };
}

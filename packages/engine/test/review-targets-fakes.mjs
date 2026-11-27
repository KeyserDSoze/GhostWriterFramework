import { reply, votingAi } from "./review-fakes.mjs";

/**
 * `votingAi` with readers who vote as a script says: `votes[slug]` is the list of the votes that reader gives, one for each time it reads a chapter (the last one repeated,
 * 7 when the reader has no list). `readings` keeps every reading in the order it was asked: the reader, its number, its vote, and the request's text.
 */
export function readingAi({ votes = {}, ...voting } = {}) {
  const base = votingAi(voting);
  const counts = {};
  const readings = [];
  return {
    calls: base.calls,
    decided: base.decided,
    judged: base.judged,
    readings,
    async complete(request) {
      const asked = /^reader-evaluation:(.+)$/.exec(request.label);
      if (asked && request.json?.name === "reader_evaluation") {
        base.calls.push(request);
        const slug = asked[1];
        const list = votes[slug] ?? [7];
        const count = counts[slug] ?? 0;
        counts[slug] = count + 1;
        const score = list[Math.min(count, list.length - 1)];
        readings.push({ slug, number: count + 1, score, user: request.user });
        return reply({
          generalImpression: "Engaging.",
          strengths: ["Atmosphere"],
          weaknesses: ["Pacing"],
          mostEffectiveMoment: "The confrontation.",
          mainProblem: `The middle drags for ${slug}.`,
          prioritySuggestion: "Tighten the middle.",
          score,
        });
      }
      return base.complete(request);
    },
  };
}

/** The labels of the calls a run made after `mark`, in order, with the readings (`reader-evaluation:<slug>`) and the other steps told apart. */
export const labelsAfter = (ai, mark = 0) => ai.calls.slice(mark).map((call) => call.label);

/** The readings after `mark`: each reader that read, in the order of the calls. */
export const readersAfter = (ai, mark = 0) => labelsAfter(ai, mark).filter((label) => label.startsWith("reader-evaluation:") && !label.endsWith("summary")).map((label) => label.slice("reader-evaluation:".length));

/** The calls that are not the readers' reading of a chapter nor the summary of what they said: the director, the specialists, the repairs, the closing. */
export const stepsAfter = (ai, mark = 0) => labelsAfter(ai, mark).map((label) => (label.startsWith("reader-evaluation:") ? "reader" : label === "reader-evaluation-summary" ? "summary" : label.replace(/:\d+(\.\d+)?$/, "")));

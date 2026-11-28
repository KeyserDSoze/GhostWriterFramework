import { createAutopilotState, type AutopilotDesign, type AutopilotState, type CoherenceFinding, type DesignCriterionScore, type DesignPitch, type DesignRubricSubject, DESIGN_CRITERIA } from "narrarium-engine";

export const AT = "2026-11-28T09:00:00.000Z";

/** The twelve criteria of a judge that scored them as given (a number for every criterion, in order), with a reason for the ones under 7. */
export function criteria(scores: ReadonlyArray<number | null>): DesignCriterionScore[] {
  return DESIGN_CRITERIA.map((criterion, index) => {
    const score = scores[index] ?? null;
    const weak = score !== null && score < 7;
    return { criterion, score, reason: weak ? `The ${criterion} is thin.` : `The ${criterion} holds.`, issues: weak ? [`${criterion} issue`] : [], proposals: weak ? [`Strengthen the ${criterion}`] : [] };
  });
}

const mean = (scores: ReadonlyArray<number | null>): number => {
  const scored = scores.filter((value): value is number => value !== null);
  return Math.round((scored.reduce((sum, value) => sum + value, 0) / scored.length) * 10) / 10;
};

/** A subject judged in the given reviews, oldest first: each is the twelve scores; the latest has its reasons. */
export function subject(reviews: ReadonlyArray<ReadonlyArray<number | null>>): DesignRubricSubject {
  return {
    latest: criteria(reviews[reviews.length - 1]),
    history: reviews.map((scores, index) => ({ round: index + 1, overall: mean(scores), scores: [...scores], at: AT })),
  };
}

export const FLAT = (value: number): number[] => DESIGN_CRITERIA.map(() => value);
export const WITH_WEAK = (value: number, weak: Record<number, number>): number[] => FLAT(value).map((score, index) => weak[index] ?? score);

export function pitch(id: string, title: string): DesignPitch {
  return { id, title, logline: `Logline of ${title}.`, premise: `Premise of ${title}.`, protagonist: `Protagonist of ${title}.`, stakes: `Stakes of ${title}.`, twist: `Twist of ${title}.`, tone: `Tone of ${title}.`, difference: `What makes ${title} different.` };
}

export function finding(partial: Partial<CoherenceFinding> & Pick<CoherenceFinding, "id" | "text">): CoherenceFinding {
  return { source: "ai", kind: "contradiction", severity: "major", chapters: [2], requires: [2], owner: "autopilot", status: "open", round: 1, seen: 1, ...partial };
}

export function stateOf(design: Partial<AutopilotDesign> = {}, patch: (state: AutopilotState) => void = () => undefined): AutopilotState {
  const state = createAutopilotState(new Date(AT), { idea: "A harbor town built on glass hides a lie that the tide will tell." });
  state.design = { startedAt: AT, chapters: 3, rounds: [], endedAt: AT, outcome: "target", ...design };
  patch(state);
  return state;
}

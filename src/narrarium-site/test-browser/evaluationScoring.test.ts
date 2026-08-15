import { describe, expect, it } from "vitest";
import { validateEvaluationScores } from "@/assistant/service";

describe("evaluation scoring schema", () => {
  const criteria = { pacing: "Pacing quality", voice: "Narrative voice" };

  it("accepts complete bounded scores", () => {
    expect(validateEvaluationScores({ criteria: { pacing: { score: 7, explanation: "Measured tension" }, voice: { score: 8, explanation: "Distinct diction" } } }, criteria)).toEqual({
      pacing: { score: 7, explanation: "Measured tension" },
      voice: { score: 8, explanation: "Distinct diction" },
    });
  });

  it("rejects missing, out-of-range, and unexpected score entries so routing can fall back", () => {
    expect(() => validateEvaluationScores({ criteria: { pacing: { score: 11, explanation: "Too high" }, voice: { score: 8, explanation: "Fine" } } }, criteria)).toThrow("invalid score");
    expect(() => validateEvaluationScores({ criteria: { pacing: { score: 7, explanation: "Fine" } } }, criteria)).toThrow("unexpected criteria");
    expect(() => validateEvaluationScores({ criteria: { pacing: { score: 7, explanation: "Fine" }, voice: { score: 8, explanation: "Fine" }, extra: { score: 1, explanation: "Extra" } } }, criteria)).toThrow("unexpected criteria");
  });
});

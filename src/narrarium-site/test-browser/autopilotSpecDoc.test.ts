import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTOPILOT_ERROR_KINDS } from "narrarium-engine";

const doc = readFileSync(resolve(process.cwd(), "../../docs/autopilot-spec.md"), "utf8");
const section = (title: string) => {
  const start = doc.indexOf(`\n## ${title}`);
  expect(start, `the doc has a section «${title}»`).toBeGreaterThan(-1);
  const next = doc.indexOf("\n## ", start + 4);
  return doc.slice(start, next === -1 ? undefined : next);
};

describe("the doc of the autopilot says what the page does with what the engine tells", () => {
  it.each([...AUTOPILOT_ERROR_KINDS])("names the kind of error `%s`: the doc lists every kind the engine tells, so a new one cannot be forgotten", (kind) => {
    expect(doc).toContain(`\`${kind}\``);
  });

  it("says how the failed step is found, the two details of a timeout and of a rate limit, and what a configuration error offers", () => {
    for (const word of ["lastError.activityId", "timeoutPhase", "timeoutMs", "retryAfterMs", "Access-Control-Expose-Headers", "#tools-only", "toolsOnlyReport"]) expect(doc, word).toContain(word);
  });

  it("says that a step which answers with a value shows how much has arrived, and nothing of the reply", () => {
    for (const word of ["task-progress", "The model is answering"]) expect(doc, word).toContain(word);
  });

  it("says that the verdict of a round and the beginning of the working time come from the engine, with a fallback", () => {
    for (const word of ["rounds[].verdict", "stats.workedMsSince"]) expect(doc, word).toContain(word);
  });

  it("explains «Tools only» and the thinking in the section of the AI router, where an author looks for them", () => {
    const router = section("AI router tasks");
    for (const word of ["Tools only", "aiToolsOnly", "Forced tool calls", "Default thinking", "Default", "Thinking parameter", "reasoningParameter", "suggestedReasoningParameter", "chat_template_kwargs.reasoning_strength"]) expect(router, word).toContain(word);
  });

  it("describes what the debug panel keeps of an attempt, and that it is metadata only", () => {
    const debug = section("What the debug panel keeps of an attempt");
    for (const word of ["metadata only", "onAttempt", "attemptBadges", "chat template"]) expect(debug, word).toContain(word);
  });
});

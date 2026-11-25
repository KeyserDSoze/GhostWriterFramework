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

  it("says how the Copilot rides over a passing error, and what it never repeats, in the section of the slow models", () => {
    const slow = section("Slow models");
    for (const word of ["quietRetryWait", "runCopilotAttempt", "retryAfterMs", "maxTotalDurationMs", "retryNotice", "timedOut", "never added to"]) expect(slow, word).toContain(word);
  });

  it("says how the app settles the conflicts with GitHub: where it is told, the window, what is held and sent, every refusal, and that it never resumes by itself", () => {
    const where = section("Where it runs");
    for (const word of [
      "GithubConflictsDialog",
      "GithubConflictsAction",
      "GithubConflictsWindow",
      "githubConflictsSettled",
      "githubConflictsOfError",
      "githubConflict: true",
      "lastSync.conflicts",
      "409 github_conflict",
      "assertGithubConflicts",
      "feature_unavailable",
      "fingerprint",
      "conflicts_changed",
      "choice_missing",
      "not_conflicted",
      "no_remote",
      "unrelated_histories",
      "invalid_github_path",
      "busy",
      "resolvable: false",
      "5000",
      "never started by itself",
      "githubConflicts",
    ]) expect(where, word).toContain(word);
    expect(where).not.toContain("comes with a version of the app after this one");
  });

  // Changed on purpose (engine 0.1.15): the reply of a structured step is shown as it streams; «answering» only says how much has arrived until then.
  it("says that a step which answers with a value shows its reply as it streams, how much has arrived until then, and that every host follows one rule", () => {
    for (const word of ["task-progress", "The model is answering", "shows the JSON of its reply as it streams", "applyLiveProgress", "callSeq"]) expect(doc, word).toContain(word);
  });

  it("says which candidate of the router the step asks now: the event, the rule that every host follows, the line, where it is, what an older host shows and the polite status", () => {
    const page = section("Where it runs");
    for (const word of ["call-attempt", "live.trying", "applyLiveAttempt", "AttemptNow", "Primary", "Fallback N", "Thinking: not sent", "attempt 2/3", "live-request", "seedLive", "stepSpendOf", "no placeholder and no error", "once for each fallback"]) expect(page, word).toContain(word);
  });

  it("says that the verdict of a round and the beginning of the working time come from the engine, with a fallback", () => {
    for (const word of ["rounds[].verdict", "stats.workedMsSince"]) expect(doc, word).toContain(word);
  });

  it("explains «Tools only» and the thinking in the section of the AI router, where an author looks for them", () => {
    const router = section("AI router tasks");
    for (const word of ["Tools only", "aiToolsOnly", "Forced tool calls", "Default thinking", "Default", "Thinking parameter", "reasoningParameter", "suggestedReasoningParameter", "chat_template_kwargs.reasoning_strength"]) expect(router, word).toContain(word);
  });

  it("says that the card of an OpenAI-compatible integration reads the models of its endpoint and checks the connection, and what an update never does, in the section of the AI router", () => {
    const router = section("AI router tasks");
    for (const word of ["fetchModelCatalog", "modelFieldsFromCatalogEntry", "probeEndpoint", "Read the models from the endpoint", "Check the connection", "/models/details", "/modalities", "never overwrites", "`false`"]) expect(router, word).toContain(word);
  });

  it("says that the error panel offers the same check, for which kinds, on which integration and where it leads", () => {
    const page = section("Where it runs");
    for (const word of ["probeEndpoint", "Check the connection", "`network`", "`timeout`", "`auth`", "`provider`", "errorDetail.integration", "#integration-", "offersConnectionCheck"]) expect(page, word).toContain(word);
  });

  it("explains the sizes and the preview of the start form: what they set, where each figure comes from, and what they never touch", () => {
    const page = section("Where it runs");
    expect(page).toContain("### The start form: sizes and the preview of the run");
    const form = page.slice(page.indexOf("### The start form"), page.indexOf("### The page of every book"));
    for (const word of [
      "AUTOPILOT_PRESETS", "autopilotPresetSkeleton", "outline/_brief.md", "readOutlineBrief", "writeOutlineBrief",
      "estimateAutopilotRun", "measuredSpeed", "TWO_CALL_TASKS", "estimateModelsFromConfig", "estimateProgressFromState", "estimateProgressFromChapters", "estimateContextFromState", "isThinDocument", "parseOutline", "ghostwriterPrompt", "directorPrompt", "evaluationStyleBlock",
      "tokensPerWord", "usage.outputTokens", "GET /api/v1/ai", "configFromServerStatus", "pickAiRuntimeConfig", "noModel", "smallWindow", "router-row-", "roundRange", "Intl.NumberFormat", "live region", "lang", "AutopilotTimeline",
    ]) expect(form, word).toContain(word);
  });

  it("explains what the rest will cost, at the end of the plan to approve: from the plan as it is, only what is left, once for a version, after the first paint, and which problems it says and how", () => {
    const page = section("Where it runs");
    expect(page).toContain("### The approval of the plan");
    const approval = page.slice(page.indexOf("### The approval of the plan"), page.indexOf("### The map of the chapters"));
    for (const word of [
      "PlanRestCost", "estimateRest", "restBrief", "restProblems", "REST_WARNING_CODES", "estimateProgressFromState", "estimateContextFromState", "plan.removedChapters", "effectiveTargetChapters", "runScenes",
      "useAfterFirstPaint", "state.version", "useRunEstimateSources", "GET /api/v1/ai", "Intl.NumberFormat", "Not known", "Not estimated", "noModelWhy", "live region", "router-row-", "#autopilot-estimate", "EstimateParts.tsx", "planReviewMode",
    ]) expect(approval, word).toContain(word);
    expect(approval).not.toContain("which is not in this engine yet");
    expect(page).toContain("is made by `estimateRest`");
  });

  it("describes what the debug panel keeps of an attempt, and that it is metadata only", () => {
    const debug = section("What the debug panel keeps of an attempt");
    for (const word of ["metadata only", "onAttempt", "attemptBadges", "chat template"]) expect(debug, word).toContain(word);
  });
});

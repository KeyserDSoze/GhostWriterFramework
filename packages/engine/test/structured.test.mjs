import test from "node:test";
import assert from "node:assert/strict";
import {
  AiProviderError,
  AiReplyRejectedError,
  cleanProse,
  isEmptyToolArguments,
  normalizeStructuredValue,
  parseJsonReply,
  parseStructuredText,
  requireStructuredFields,
  splitReasoningBlock,
  structuredFromReply,
  structuredReply,
} from "../dist/index.js";

const schema = { name: "director_review", description: "d", parameters: { type: "object", properties: { verdict: { type: "string" }, decisions: { type: "array" } }, required: ["verdict", "decisions"] } };
const answer = { verdict: "revise", decisions: [{ findingId: "S1-1", action: "accept" }] };

test("tool arguments: JSON strings, double encoding and single-key wrappers are normalized", () => {
  const required = ["verdict", "decisions"];
  assert.deepEqual(normalizeStructuredValue(JSON.stringify(answer), required), answer);
  assert.deepEqual(normalizeStructuredValue(JSON.stringify(JSON.stringify(answer)), required), answer);
  assert.deepEqual(normalizeStructuredValue({ arguments: answer }, required), answer);
  assert.deepEqual(normalizeStructuredValue({ result: JSON.stringify(answer) }, required), answer);
  const incomplete = { result: { verdict: "approve" } };
  assert.deepEqual(normalizeStructuredValue(incomplete, required), incomplete, "an inner object without every required key is not unwrapped");
  const complete = { ...answer, extra: { verdict: "x", decisions: [] } };
  assert.deepEqual(normalizeStructuredValue(complete, required), complete, "an outer object with the required keys is kept");
  assert.deepEqual(normalizeStructuredValue(normalizeStructuredValue({ arguments: answer }, required), required), answer, "idempotent");
});

test("structured replies reject {} and non-objects with a retryable error", () => {
  for (const value of [{}, "{}", [], "not json", 42, null]) {
    assert.throws(() => structuredReply(value, schema), (error) => error instanceof AiReplyRejectedError && error instanceof AiProviderError && error.retryable === true);
  }
  assert.deepEqual(structuredReply({ arguments: answer }, schema), answer);
  assert.deepEqual(structuredReply({ verdict: "revise", decisions: JSON.stringify(answer.decisions) }, schema), answer, "a list sent as a JSON string is decoded");
  assert.deepEqual(structuredReply({ verdict: "revise", decisions: "none" }, schema), { verdict: "revise", decisions: "none" }, "anything else is left for the task to judge");
  assert.equal(isEmptyToolArguments(" {} "), true);
  assert.equal(isEmptyToolArguments(""), true);
  assert.equal(isEmptyToolArguments("{\"a\":1}"), false);
});

test("required fields are named when missing or mistyped, without quoting the reply", () => {
  assert.throws(
    () => requireStructuredFields({ verdict: "approve", secret: "PRIVATE MANUSCRIPT TEXT" }, { verdict: "text", decisions: "list" }, "The review"),
    (error) => error instanceof AiReplyRejectedError && /"decisions" is missing/.test(error.message) && !error.message.includes("PRIVATE"),
  );
  assert.throws(() => requireStructuredFields({ findings: "none" }, { findings: "list" }), /"findings" is not a list/);
  assert.throws(() => requireStructuredFields({ verdict: "  " }, { verdict: "text" }), /"verdict" is missing/);
  assert.throws(() => requireStructuredFields({ score: "high" }, { score: "number" }), /"score" is not a number/);
  assert.deepEqual(requireStructuredFields({ score: "7", findings: [] }, { score: "number", findings: "list" }), { score: "7", findings: [] });
});

test("text replies: the echoed schema, reasoning blocks and fences never hide the answer", () => {
  const echoed = `Here is the schema: ${JSON.stringify(schema.parameters)}\n\nMy answer:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``;
  assert.deepEqual(parseStructuredText(echoed, schema), answer);
  assert.deepEqual(parseStructuredText(`<think>{"verdict": "draft"}</think>\n${JSON.stringify(answer)}`, schema), answer);
  const partial = parseStructuredText("Result: {\"verdict\":\"approve\"}", schema);
  assert.deepEqual(partial, { verdict: "approve" }, "an object with some of the fields is returned for the task to judge");
  assert.throws(() => parseStructuredText("I cannot answer that.", schema), (error) => error instanceof AiReplyRejectedError && /not valid JSON/.test(error.message) && /"verdict"/.test(error.message));
  assert.throws(() => parseStructuredText("{\"unrelated\": true}", schema), /expected fields/);
  assert.deepEqual(parseJsonReply("[1, 2]"), [1, 2], "without an acceptor any JSON value is returned, as before");
});

test("a leading reasoning block is never the reply, even when the limit cut it", () => {
  assert.deepEqual(splitReasoningBlock("<think>plan</think>\n\nThe scene."), { reply: "The scene.", reasoningCharacters: 4 });
  assert.deepEqual(splitReasoningBlock("<THINKING>still thinking when the limit"), { reply: "", reasoningCharacters: "still thinking when the limit".length });
  assert.deepEqual(splitReasoningBlock("Plain reply <think>quoted</think>"), { reply: "Plain reply <think>quoted</think>", reasoningCharacters: 0 });
  assert.equal(cleanProse("<think>unfinished reasoning"), "", "unterminated reasoning never becomes prose");
  assert.equal(cleanProse("<think>ok</think>\n# Scene 1\n\nShe ran."), "She ran.");
});

test("a reply's structured value comes from the tool call, else from the content", () => {
  assert.deepEqual(structuredFromReply({ toolArguments: JSON.stringify(answer), content: "", schema }), answer);
  assert.deepEqual(structuredFromReply({ toolArguments: "{}", content: `Sure! ${JSON.stringify(answer)}`, schema }), answer);
  assert.deepEqual(structuredFromReply({ toolArguments: "", content: JSON.stringify(answer), schema }), answer);
  assert.deepEqual(structuredFromReply({ toolArguments: `${JSON.stringify(answer)} trailing`, content: "", schema }), answer);
  assert.throws(() => structuredFromReply({ toolArguments: "{}", content: "", schema }), /empty arguments/);
  assert.throws(() => structuredFromReply({ toolArguments: "", content: "", schema }), /empty reply/);
  assert.throws(() => structuredFromReply({ toolArguments: "{\"verdict\": \"appr", content: "", schema }), AiReplyRejectedError);
});

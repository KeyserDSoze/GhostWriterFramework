import assert from "node:assert/strict";
import test from "node:test";
import { classifyGitHubCallback } from "../src/github/githubCallbackParams.ts";

const kind = (query) => classifyGitHubCallback(new URLSearchParams(query));

test("a code with the state the site made up is a sign-in to finish", () => {
  assert.equal(kind("code=abc&state=xyz"), "authorization");
  assert.equal(kind("code=abc&state=xyz&installation_id=1&setup_action=install"), "authorization");
});

test("coming back from installing the app, without a state, is not a failed sign-in", () => {
  assert.equal(kind("code=abc&installation_id=123&setup_action=install"), "installation-return");
  assert.equal(kind("installation_id=123&setup_action=update"), "installation-return");
  assert.equal(kind("setup_action=install"), "installation-return");
});

test("a refusal by GitHub wins over everything else", () => {
  assert.equal(kind("error=access_denied&state=xyz"), "refused");
  assert.equal(kind("error=access_denied&installation_id=1"), "refused");
});

test("anything else that lacks the code or the state is incomplete", () => {
  assert.equal(kind(""), "incomplete");
  assert.equal(kind("code=abc"), "incomplete");
  assert.equal(kind("state=xyz"), "incomplete");
  assert.equal(kind("state=xyz&installation_id=1"), "incomplete");
});

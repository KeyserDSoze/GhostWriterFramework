import test from "node:test";
import assert from "node:assert/strict";
import { NarrariumApiClient } from "../dist/index.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

test("NarrariumApiClient sends auth headers and loads git state", async () => {
  const requests = [];
  const client = new NarrariumApiClient({
    baseUrl: "https://narrarium.test",
    getHeaders: async () => ({
      Authorization: "Bearer token-123",
    }),
    fetch: async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      requests.push({
        url,
        method: init.method ?? "GET",
        authorization: new Headers(init.headers).get("authorization"),
      });

      if (url === "https://narrarium.test/api/narrarium/profiles/profile-1/git") {
        return jsonResponse({
          profileId: "profile-1",
          provider: "github",
          branch: "main",
          ref: "refs/heads/main",
          commitSha: "commit-1",
          loadedAt: "2026-03-14T00:00:00.000Z",
        });
      }

      throw new Error(`Unhandled URL ${url}`);
    },
  });

  const state = await client.getGitState("profile-1");

  assert.equal(state?.commitSha, "commit-1");
  assert.deepEqual(requests, [
    {
      url: "https://narrarium.test/api/narrarium/profiles/profile-1/git",
      method: "GET",
      authorization: "Bearer token-123",
    },
  ]);
});

test("NarrariumApiClient posts commit payloads to the API", async () => {
  const requests = [];
  const client = new NarrariumApiClient({
    baseUrl: "https://narrarium.test/",
    fetch: async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      requests.push({
        url,
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      });

      if (url === "https://narrarium.test/api/narrarium/profiles/profile-1/commit") {
        return jsonResponse({
          profileId: "profile-1",
          provider: "github",
          branch: "main",
          previousCommitSha: "commit-1",
          commitSha: "commit-2",
          pushedAt: "2026-03-14T00:01:00.000Z",
          changedPaths: ["context.md"],
          message: "Add context",
        });
      }

      throw new Error(`Unhandled URL ${url}`);
    },
  });

  const result = await client.commit("profile-1", {
    baseCommitSha: "commit-1",
    message: "Add context",
    changes: [
      {
        kind: "upsert",
        path: "context.md",
        rawMarkdown: "# Book Context\n\nStable frame.\n",
      },
    ],
  });

  assert.equal(result.commitSha, "commit-2");
  assert.deepEqual(requests, [
    {
      url: "https://narrarium.test/api/narrarium/profiles/profile-1/commit",
      method: "POST",
      body: {
        baseCommitSha: "commit-1",
        message: "Add context",
        changes: [
          {
            kind: "upsert",
            path: "context.md",
            rawMarkdown: "# Book Context\n\nStable frame.\n",
          },
        ],
      },
    },
  ]);
});

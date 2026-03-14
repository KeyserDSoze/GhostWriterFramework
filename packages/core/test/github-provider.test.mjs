import test from "node:test";
import assert from "node:assert/strict";
import {
  BookManager,
  GitHubRemoteProvider,
  createEmptyBookSnapshot,
} from "../dist/index.js";

function markdownToBase64(markdown) {
  return Buffer.from(markdown, "utf8").toString("base64");
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

test("GitHubRemoteProvider loads a Narrarium snapshot from repository markdown", async () => {
  const calls = [];
  const fetchMock = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ method: init.method ?? "GET", url });

    if (url.endsWith("/git/ref/heads%2Fmain")) {
      return jsonResponse({ ref: "refs/heads/main", object: { sha: "commit-1" } });
    }

    if (url.endsWith("/git/commits/commit-1")) {
      return jsonResponse({ sha: "commit-1", tree: { sha: "tree-1" } });
    }

    if (url.endsWith("/git/trees/tree-1?recursive=1")) {
      return jsonResponse({
        sha: "tree-1",
        truncated: false,
        tree: [
          { path: "book.md", type: "blob", mode: "100644", sha: "blob-book" },
          { path: "context.md", type: "blob", mode: "100644", sha: "blob-context" },
          { path: "characters/lyra-vale.md", type: "blob", mode: "100644", sha: "blob-character" },
          { path: "chapters/001-the-arrival/chapter.md", type: "blob", mode: "100644", sha: "blob-chapter" },
          { path: "chapters/001-the-arrival/001-at-the-gate.md", type: "blob", mode: "100644", sha: "blob-paragraph" },
        ],
      });
    }

    if (url.endsWith("/git/blobs/blob-book")) {
      return jsonResponse({
        sha: "blob-book",
        encoding: "base64",
        content: markdownToBase64(`---\ntype: book\nid: book\ntitle: Test Book\nlanguage: en\ncanon: draft\n---\n\n# Premise\n\nA harbor story.\n`),
      });
    }

    if (url.endsWith("/git/blobs/blob-context")) {
      return jsonResponse({
        sha: "blob-context",
        encoding: "base64",
        content: markdownToBase64(`# Book Context\n\nThe harbor is politically unstable.\n`),
      });
    }

    if (url.endsWith("/git/blobs/blob-character")) {
      return jsonResponse({
        sha: "blob-character",
        encoding: "base64",
        content: markdownToBase64(`---\ntype: character\nid: character:lyra-vale\nname: Lyra Vale\ncanon: draft\n---\n\n# Overview\n\nA careful broker.\n`),
      });
    }

    if (url.endsWith("/git/blobs/blob-chapter")) {
      return jsonResponse({
        sha: "blob-chapter",
        encoding: "base64",
        content: markdownToBase64(`---\ntype: chapter\nid: chapter:001-the-arrival\nnumber: 1\ntitle: The Arrival\ncanon: draft\npov: []\nstyle_refs: []\nprose_mode: []\ntags: []\n---\n\n# Purpose\n\nOpen with pressure.\n`),
      });
    }

    if (url.endsWith("/git/blobs/blob-paragraph")) {
      return jsonResponse({
        sha: "blob-paragraph",
        encoding: "base64",
        content: markdownToBase64(`---\ntype: paragraph\nid: paragraph:001-the-arrival:001-at-the-gate\nchapter: chapter:001-the-arrival\nnumber: 1\ntitle: At The Gate\ncanon: draft\ntags: []\n---\n\n# Scene\n\nThe harbor watches before it welcomes.\n`),
      });
    }

    throw new Error(`Unhandled fetch URL: ${url}`);
  };

  const manager = new BookManager({
    providers: [new GitHubRemoteProvider({ fetch: fetchMock })],
  });

  const profile = await manager.createGitHubProfile({
    name: "Remote Book",
    owner: "KeyserDSoze",
    repository: "GhostWriterFramework",
    branch: "main",
    token: "github-token",
  });

  const snapshot = await manager.loadBook(profile);

  assert.equal(snapshot.commitSha, "commit-1");
  assert.equal(snapshot.ref, "refs/heads/main");
  assert.equal(snapshot.book?.frontmatter.title, "Test Book");
  assert.equal(snapshot.context?.kind, "context");
  assert.equal(snapshot.characters.length, 1);
  assert.equal(snapshot.characters[0].frontmatter.name, "Lyra Vale");
  assert.equal(snapshot.chapters.length, 1);
  assert.equal(snapshot.chapters[0].paragraphs.length, 1);
  assert.equal(
    snapshot.paragraphsById["paragraph:001-the-arrival:001-at-the-gate"].path,
    "chapters/001-the-arrival/001-at-the-gate.md",
  );
  assert.deepEqual(
    calls.map((entry) => entry.url),
    [
      "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/ref/heads%2Fmain",
      "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/commits/commit-1",
      "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/trees/tree-1?recursive=1",
      "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/blobs/blob-book",
      "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/blobs/blob-context",
      "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/blobs/blob-character",
      "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/blobs/blob-chapter",
      "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/blobs/blob-paragraph",
    ],
  );
});

test("GitHubRemoteProvider creates tree, commit, and ref update for direct push", async () => {
  const requests = [];
  const fetchMock = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });

    if (method === "GET" && url.endsWith("/git/ref/heads%2Fmain")) {
      return jsonResponse({ ref: "refs/heads/main", object: { sha: "commit-1" } });
    }

    if (method === "GET" && url.endsWith("/git/commits/commit-1")) {
      return jsonResponse({ sha: "commit-1", tree: { sha: "tree-1" } });
    }

    if (method === "POST" && url.endsWith("/git/trees")) {
      return jsonResponse({ sha: "tree-2" });
    }

    if (method === "POST" && url.endsWith("/git/commits")) {
      return jsonResponse({ sha: "commit-2" });
    }

    if (method === "PATCH" && url.endsWith("/git/refs/heads%2Fmain")) {
      return jsonResponse({ ref: "refs/heads/main", object: { sha: "commit-2" } });
    }

    throw new Error(`Unhandled fetch request: ${method} ${url}`);
  };

  const provider = new GitHubRemoteProvider({ fetch: fetchMock });
  const profile = {
    id: "github-profile",
    name: "Remote Book",
    provider: "github",
    owner: "KeyserDSoze",
    repository: "GhostWriterFramework",
    branch: "main",
    token: "github-token",
    isDefault: true,
    createdAt: "2026-03-14T00:00:00.000Z",
    updatedAt: "2026-03-14T00:00:00.000Z",
  };
  const snapshot = createEmptyBookSnapshot({
    profileId: profile.id,
    provider: profile.provider,
    branch: profile.branch,
    commitSha: "commit-1",
    ref: "refs/heads/main",
    loadedAt: "2026-03-14T00:00:00.000Z",
  });
  const manager = new BookManager({ providers: [provider] });
  const workspace = manager.beginWorkspace(snapshot);
  workspace.upsertMarkdown("context.md", "# Book Context\n\nStable harbor rules.\n");
  workspace.deleteDocument("obsolete.md");

  const result = await provider.commitAndPush({
    profile,
    snapshot,
    workspace,
    request: {
      message: "Update shared context",
      authorName: "Narrarium",
      authorEmail: "narrarium@example.com",
    },
  });

  assert.equal(result.commitSha, "commit-2");
  assert.deepEqual(result.changedPaths, ["context.md", "obsolete.md"]);

  assert.deepEqual(requests.map((entry) => [entry.method, entry.url]), [
    ["GET", "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/ref/heads%2Fmain"],
    ["GET", "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/commits/commit-1"],
    ["POST", "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/trees"],
    ["POST", "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/commits"],
    ["PATCH", "https://api.github.com/repos/KeyserDSoze/GhostWriterFramework/git/refs/heads%2Fmain"],
  ]);

  assert.deepEqual(requests[2].body, {
    base_tree: "tree-1",
    tree: [
      {
        path: "context.md",
        mode: "100644",
        type: "blob",
        content: "# Book Context\n\nStable harbor rules.\n",
      },
      {
        path: "obsolete.md",
        mode: "100644",
        type: "blob",
        sha: null,
      },
    ],
  });
  assert.equal(requests[3].body.message, "Update shared context");
  assert.equal(requests[3].body.tree, "tree-2");
  assert.deepEqual(requests[3].body.parents, ["commit-1"]);
  assert.equal(requests[4].body.sha, "commit-2");
  assert.equal(requests[4].body.force, false);
});

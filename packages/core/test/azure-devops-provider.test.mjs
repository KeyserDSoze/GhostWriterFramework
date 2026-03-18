import test from "node:test";
import assert from "node:assert/strict";
import {
  AzureDevOpsRemoteProvider,
  BookManager,
  createEmptyBookSnapshot,
} from "../dist/index.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

test("AzureDevOpsRemoteProvider loads a Narrarium snapshot from repository markdown", async () => {
  const calls = [];
  const fetchMock = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ method: init.method ?? "GET", url });

    if (url.includes("/_apis/git/repositories/book-repo/refs?")) {
      return jsonResponse({
        count: 1,
        value: [
          {
            name: "refs/heads/main",
            objectId: "commit-az-1",
          },
        ],
      });
    }

    if (url.includes("/_apis/git/repositories/book-repo/items?") && url.includes("recursionLevel=Full")) {
      return jsonResponse({
        count: 4,
        value: [
          { path: "/book.md", gitObjectType: "blob", isFolder: false },
          { path: "/context.md", gitObjectType: "blob", isFolder: false },
          { path: "/chapters/001-the-arrival/chapter.md", gitObjectType: "blob", isFolder: false },
          { path: "/chapters/001-the-arrival/001-at-the-gate.md", gitObjectType: "blob", isFolder: false },
        ],
      });
    }

    if (url.includes("path=%2Fbook.md")) {
      return jsonResponse({
        path: "/book.md",
        content: `---\ntype: book\nid: book\ntitle: Azure Book\nlanguage: en\nauthor: Test Author\ngenre: fantasy\naudience: adult\ncanon: draft\n---\n\n# Premise\n\nA harbor mystery.\n`,
      });
    }

    if (url.includes("path=%2Fcontext.md")) {
      return jsonResponse({
        path: "/context.md",
        content: `# Book Context\n\nTrade routes control the harbor.\n`,
      });
    }

    if (url.includes("path=%2Fchapters%2F001-the-arrival%2Fchapter.md")) {
      return jsonResponse({
        path: "/chapters/001-the-arrival/chapter.md",
        content: `---\ntype: chapter\nid: chapter:001-the-arrival\nnumber: 1\ntitle: The Arrival\nsummary: Lyra returns to the harbor.\npov: []\nstyle_refs: []\nprose_mode: []\ntags: []\ncanon: draft\n---\n\n# Purpose\n\nOpen the story under pressure.\n`,
      });
    }

    if (url.includes("path=%2Fchapters%2F001-the-arrival%2F001-at-the-gate.md")) {
      return jsonResponse({
        path: "/chapters/001-the-arrival/001-at-the-gate.md",
        content: `---\ntype: paragraph\nid: paragraph:001-the-arrival:001-at-the-gate\nchapter: chapter:001-the-arrival\nnumber: 1\ntitle: At The Gate\nsummary: The harbor warns before it welcomes.\ntags: []\ncanon: draft\n---\n\n# Scene\n\nThe harbor watches before it welcomes.\n`,
      });
    }

    throw new Error(`Unhandled Azure DevOps fetch URL: ${url}`);
  };

  const manager = new BookManager({
    providers: [new AzureDevOpsRemoteProvider({ fetch: fetchMock })],
  });

  const profile = await manager.createAzureDevOpsProfile({
    name: "Azure Book",
    organization: "my-org",
    project: "my-project",
    repository: "book-repo",
    branch: "main",
    token: "azure-pat",
  });

  const snapshot = await manager.loadBook(profile);

  assert.equal(snapshot.commitSha, "commit-az-1");
  assert.equal(snapshot.ref, "refs/heads/main");
  assert.equal(snapshot.book?.frontmatter.title, "Azure Book");
  assert.equal(snapshot.context?.path, "context.md");
  assert.equal(snapshot.chapters.length, 1);
  assert.equal(snapshot.chapters[0].paragraphs.length, 1);
  assert.equal(snapshot.paragraphsById["paragraph:001-the-arrival:001-at-the-gate"].path, "chapters/001-the-arrival/001-at-the-gate.md");

  assert.deepEqual(
    calls.map((entry) => [entry.method, entry.url]),
    [
      ["GET", "https://dev.azure.com/my-org/my-project/_apis/git/repositories/book-repo/refs?filter=heads%2Fmain&api-version=7.1"],
      ["GET", "https://dev.azure.com/my-org/my-project/_apis/git/repositories/book-repo/items?scopePath=%2F&recursionLevel=Full&includeContentMetadata=true&versionDescriptor.version=commit-az-1&versionDescriptor.versionType=commit&api-version=7.1"],
      ["GET", "https://dev.azure.com/my-org/my-project/_apis/git/repositories/book-repo/items?path=%2Fbook.md&includeContent=true&%24format=json&versionDescriptor.version=commit-az-1&versionDescriptor.versionType=commit&api-version=7.1"],
      ["GET", "https://dev.azure.com/my-org/my-project/_apis/git/repositories/book-repo/items?path=%2Fcontext.md&includeContent=true&%24format=json&versionDescriptor.version=commit-az-1&versionDescriptor.versionType=commit&api-version=7.1"],
      ["GET", "https://dev.azure.com/my-org/my-project/_apis/git/repositories/book-repo/items?path=%2Fchapters%2F001-the-arrival%2Fchapter.md&includeContent=true&%24format=json&versionDescriptor.version=commit-az-1&versionDescriptor.versionType=commit&api-version=7.1"],
      ["GET", "https://dev.azure.com/my-org/my-project/_apis/git/repositories/book-repo/items?path=%2Fchapters%2F001-the-arrival%2F001-at-the-gate.md&includeContent=true&%24format=json&versionDescriptor.version=commit-az-1&versionDescriptor.versionType=commit&api-version=7.1"],
    ],
  );
});

test("AzureDevOpsRemoteProvider pushes workspace changes directly to the configured branch", async () => {
  const requests = [];
  const fetchMock = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });

    if (method === "GET" && url.includes("/_apis/git/repositories/book-repo/refs?")) {
      return jsonResponse({
        count: 1,
        value: [
          {
            name: "refs/heads/main",
            objectId: "commit-az-1",
          },
        ],
      });
    }

    if (method === "POST" && url.includes("/_apis/git/repositories/book-repo/pushes?")) {
      return jsonResponse({
        date: "2026-03-14T00:01:00.000Z",
        commits: [{ commitId: "commit-az-2" }],
        refUpdates: [
          {
            name: "refs/heads/main",
            oldObjectId: "commit-az-1",
            newObjectId: "commit-az-2",
          },
        ],
      });
    }

    throw new Error(`Unhandled Azure DevOps request: ${method} ${url}`);
  };

  const provider = new AzureDevOpsRemoteProvider({ fetch: fetchMock });
  const profile = {
    id: "azure-profile",
    name: "Azure Book",
    provider: "azure-devops",
    organization: "my-org",
    project: "my-project",
    repository: "book-repo",
    branch: "main",
    token: "azure-pat",
    isDefault: true,
    createdAt: "2026-03-14T00:00:00.000Z",
    updatedAt: "2026-03-14T00:00:00.000Z",
  };
  const snapshot = createEmptyBookSnapshot({
    profileId: profile.id,
    provider: profile.provider,
    branch: profile.branch,
    commitSha: "commit-az-1",
    ref: "refs/heads/main",
    loadedAt: "2026-03-14T00:00:00.000Z",
  });
  snapshot.documentsByPath["context.md"] = {
    kind: "context",
    path: "context.md",
    frontmatter: {},
    body: "# Book Context\n\nOld frame.",
  };

  const manager = new BookManager({ providers: [provider] });
  const workspace = manager.beginWorkspace(snapshot);
  workspace.upsertMarkdown("context.md", "# Book Context\n\nUpdated frame.\n");
  workspace.upsertMarkdown("characters/lyra-vale.md", "---\ntype: character\nid: character:lyra-vale\nname: Lyra Vale\ncanon: draft\n---\n\n# Overview\n\nA careful broker.\n");
  workspace.deleteDocument("obsolete.md");

  const result = await provider.commitAndPush({
    profile,
    snapshot,
    workspace,
    request: {
      message: "Update Azure book context",
      authorName: "Narrarium",
      authorEmail: "narrarium@example.com",
    },
  });

  assert.equal(result.commitSha, "commit-az-2");
  assert.deepEqual(result.changedPaths, ["characters/lyra-vale.md", "context.md", "obsolete.md"]);

  assert.deepEqual(
    requests.map((entry) => [entry.method, entry.url]),
    [
      ["GET", "https://dev.azure.com/my-org/my-project/_apis/git/repositories/book-repo/refs?filter=heads%2Fmain&api-version=7.1"],
      ["POST", "https://dev.azure.com/my-org/my-project/_apis/git/repositories/book-repo/pushes?api-version=7.1"],
    ],
  );

  assert.deepEqual(requests[1].body, {
    refUpdates: [
      {
        name: "refs/heads/main",
        oldObjectId: "commit-az-1",
      },
    ],
    commits: [
      {
        comment: "Update Azure book context",
        author: {
          name: "Narrarium",
          email: "narrarium@example.com",
          date: requests[1].body.commits[0].author.date,
        },
        committer: {
          name: "Narrarium",
          email: "narrarium@example.com",
          date: requests[1].body.commits[0].committer.date,
        },
        changes: [
          {
            changeType: "add",
            item: {
              path: "/characters/lyra-vale.md",
            },
            newContent: {
              content: "---\ntype: character\nid: character:lyra-vale\nname: Lyra Vale\ncanon: draft\n---\n\n# Overview\n\nA careful broker.\n",
              contentType: "rawtext",
            },
          },
          {
            changeType: "edit",
            item: {
              path: "/context.md",
            },
            newContent: {
              content: "# Book Context\n\nUpdated frame.\n",
              contentType: "rawtext",
            },
          },
          {
            changeType: "delete",
            item: {
              path: "/obsolete.md",
            },
          },
        ],
      },
    ],
  });
});

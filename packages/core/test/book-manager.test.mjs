import test from "node:test";
import assert from "node:assert/strict";
import {
  BookManager,
  LocalStorageBookProfileStore,
  createEmptyBookSnapshot,
} from "../dist/index.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("book manager persists profiles and delegates remote load and push", async () => {
  const storage = new MemoryStorage();
  const store = new LocalStorageBookProfileStore({
    storage,
    storageKey: "narrarium.test.profiles",
  });
  const providerCalls = [];
  const provider = {
    kind: "github",
    async loadBookSnapshot({ profile }) {
      providerCalls.push({ type: "load", profileId: profile.id });
      return createEmptyBookSnapshot({
        profileId: profile.id,
        provider: profile.provider,
        branch: profile.branch,
        ref: profile.ref ?? null,
        commitSha: "abc123",
        loadedAt: "2026-03-14T00:00:00.000Z",
      });
    },
    async commitAndPush({ profile, snapshot, workspace, request }) {
      providerCalls.push({
        type: "push",
        profileId: profile.id,
        changedPaths: workspace.listChangedPaths(),
        message: request.message,
      });
      return {
        profileId: profile.id,
        provider: snapshot.provider,
        branch: snapshot.branch,
        previousCommitSha: snapshot.commitSha,
        commitSha: "def456",
        pushedAt: "2026-03-14T00:01:00.000Z",
        changedPaths: workspace.listChangedPaths(),
        message: request.message,
      };
    },
  };

  const manager = new BookManager({
    profileStore: store,
    providers: [provider],
    now: () => new Date("2026-03-14T00:00:00.000Z"),
  });

  const profile = await manager.createGitHubProfile({
    name: "Primary Book",
    owner: "KeyserDSoze",
    repository: "GhostWriterFramework",
    branch: "main",
    token: "github-token",
  });

  assert.equal(profile.isDefault, true);
  assert.equal((await manager.getDefaultProfile())?.id, profile.id);
  assert.equal((await manager.listProfiles()).length, 1);

  const snapshot = await manager.loadBook(profile.id);
  const workspace = manager.beginWorkspace(snapshot);
  workspace.upsertMarkdown("context.md", "# Book Context\n\nStable frame.");

  const push = await manager.commitAndPush(profile.id, snapshot, workspace, {
    message: "Add shared book context",
  });

  assert.equal(push.commitSha, "def456");
  assert.deepEqual(push.changedPaths, ["context.md"]);
  assert.deepEqual(providerCalls, [
    { type: "load", profileId: profile.id },
    {
      type: "push",
      profileId: profile.id,
      changedPaths: ["context.md"],
      message: "Add shared book context",
    },
  ]);

  const persisted = await store.getProfile(profile.id);
  assert.equal(persisted?.repository, "GhostWriterFramework");
});

test("workspace offers high-level chapter, paragraph, and character mutations", () => {
  const snapshot = createEmptyBookSnapshot({
    profileId: "profile-1",
    provider: "github",
    branch: "main",
    commitSha: "abc123",
    loadedAt: "2026-03-14T00:00:00.000Z",
  });

  const chapterDocument = {
    kind: "chapter",
    path: "chapters/001-the-arrival/chapter.md",
    frontmatter: {
      type: "chapter",
      id: "chapter:001-the-arrival",
      number: 1,
      title: "The Arrival",
      pov: [],
      style_refs: [],
      prose_mode: [],
      tags: [],
      canon: "draft",
    },
    body: "# Purpose\n\nOpen the harbor under pressure.",
  };
  const paragraphDocument = {
    kind: "paragraph",
    path: "chapters/001-the-arrival/001-at-the-gate.md",
    frontmatter: {
      type: "paragraph",
      id: "paragraph:001-the-arrival:001-at-the-gate",
      chapter: "chapter:001-the-arrival",
      number: 1,
      title: "At The Gate",
      tags: [],
      canon: "draft",
    },
    body: "# Scene\n\nThe harbor watches before it welcomes.",
  };

  snapshot.documentsByPath[chapterDocument.path] = chapterDocument;
  snapshot.documentsByPath[paragraphDocument.path] = paragraphDocument;
  snapshot.chapters = [
    {
      slug: "001-the-arrival",
      chapter: chapterDocument,
      paragraphs: [paragraphDocument],
    },
  ];
  snapshot.chaptersBySlug["001-the-arrival"] = snapshot.chapters[0];
  snapshot.paragraphsById[paragraphDocument.frontmatter.id] = paragraphDocument;

  const workspace = new BookManager().beginWorkspace(snapshot);
  workspace.updateChapter("chapter:001-the-arrival", {
    frontmatter: {
      title: "The Arrival Revised",
    },
  });
  workspace.updateParagraph("paragraph:001-the-arrival:001-at-the-gate", {
    body: "# Scene\n\nThe harbor measures every returning face.",
  });
  workspace.upsertCharacter({
    slug: "lyra-vale",
    frontmatter: {
      type: "character",
      id: "character:lyra-vale",
      name: "Lyra Vale",
      canon: "draft",
      tags: [],
      refs: [],
      sources: [],
      historical: false,
      secret_refs: [],
      aliases: [],
      former_names: [],
      identity_shifts: [],
      role_tier: "supporting",
      story_role: "other",
      traits: [],
      mannerisms: [],
      desires: [],
      fears: [],
      relationships: [],
      factions: [],
      timeline_ages: {},
    },
    body: "# Overview\n\nA careful broker returns to the harbor.",
  });

  assert.deepEqual(workspace.listChangedPaths(), [
    "chapters/001-the-arrival/001-at-the-gate.md",
    "chapters/001-the-arrival/chapter.md",
    "characters/lyra-vale.md",
  ]);
  assert.equal(workspace.getChange("chapters/001-the-arrival/chapter.md")?.document.frontmatter.title, "The Arrival Revised");
  assert.equal(
    workspace.getChange("chapters/001-the-arrival/001-at-the-gate.md")?.document.body,
    "# Scene\n\nThe harbor measures every returning face.",
  );
  assert.equal(workspace.getChange("characters/lyra-vale.md")?.document.frontmatter.id, "character:lyra-vale");
});

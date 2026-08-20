import "fake-indexeddb/auto";
import { afterEach, expect, test } from "vitest";
import { getLocalFile as getLocalFileScoped, putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { putCleanLocalFile } from "./helpers/localRepositorySeed";
import { renameParagraphWithCompanions, reorderChaptersInBook, reorderParagraphsInChapter } from "@/github/githubClient";
import { buildParagraphScriptArtifact } from "@/narrarium/workspace";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";

const getLocalFile = (repoIdValue: string, path: string) => getLocalFileScoped(repoIdValue, path, captureRepositoryOperationScope());
import { useAuthStore } from "@/store/authStore";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

let repoId = "";

afterEach(async () => {
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

async function repository(files: Array<{ path: string; content: string }>) {
  const repo = await putLocalRepository({ bookId: "book", owner: "owner", repo: "repo", branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
  repoId = repo.id;
  for (const file of files) await putCleanLocalFile({ repoId, path: file.path, kind: "text", text: file.content, size: file.content.length });
  return repo;
}

const chapter = (slug: string, number: number) => ({ path: `chapters/${slug}/chapter.md`, content: `---\ntype: chapter\nid: chapter:${slug}\nnumber: ${number}\ntitle: Chapter ${number}\n---\n` });
const paragraph = (chapterSlug: string, slug: string, number: number) => ({ path: `chapters/${chapterSlug}/${slug}.md`, content: `---\ntype: paragraph\nid: paragraph:${chapterSlug}:${slug}\nchapter: chapter:${chapterSlug}\nnumber: ${number}\ntitle: Paragraph ${number}\n---\n` });

test("paragraph rename atomically moves its script and regenerates the canonical ledger", async () => {
  const oldSlug = "001-opening";
  const nextSlug = "001-renamed";
  const artifact = buildParagraphScriptArtifact({ chapterSlug: "001-one", number: 1, title: "Opening", paragraphSlug: oldSlug });
  await repository([chapter("001-one", 1), paragraph("001-one", oldSlug, 1), artifact]);

  const outcome = await renameParagraphWithCompanions("token", "owner", "repo", "main", "chapters/001-one", { number: "001", title: "Opening", path: `chapters/001-one/${oldSlug}.md`, scriptPath: artifact.path }, `chapters/001-one/${nextSlug}.md`, paragraph("001-one", nextSlug, 1).content, "Rename paragraph");

  expect(outcome.paragraph.scriptPath).toBe(`scripts/001-one/${nextSlug}.md`);
  expect(outcome.canonical?.changedPaths).toContain("state/script-ledger.md");
  expect((await getLocalFile(repoId, `scripts/001-one/${nextSlug}.md`))?.text).toContain(`paragraph:001-one:${nextSlug}`);
  expect((await getLocalFile(repoId, "state/script-ledger.md"))?.text).toContain(`scripts/001-one/${nextSlug}.md`);
  expect((await getLocalFile(repoId, "state/script-ledger.md"))?.text).not.toContain(artifact.path);
});

test("paragraph deletion removes its script and persists a ledger without the deleted scene", async () => {
  const first = buildParagraphScriptArtifact({ chapterSlug: "001-one", number: 1, title: "First", paragraphSlug: "001-first" });
  const second = buildParagraphScriptArtifact({ chapterSlug: "001-one", number: 2, title: "Second", paragraphSlug: "002-second" });
  await repository([chapter("001-one", 1), paragraph("001-one", "001-first", 1), paragraph("001-one", "002-second", 2), first, second]);

  const outcome = await reorderParagraphsInChapter("token", "owner", "repo", "main", "chapters/001-one", [
    { number: "001", title: "First", path: "chapters/001-one/001-first.md", scriptPath: first.path },
    { number: "002", title: "Second", path: "chapters/001-one/002-second.md", scriptPath: second.path },
  ], [{ number: "001", title: "First", path: "chapters/001-one/001-first.md", scriptPath: first.path }], "Delete paragraph");

  expect(outcome.canonical?.changedPaths).toEqual(expect.arrayContaining([second.path, "state/script-ledger.md"]));
  const ledger = (await getLocalFile(repoId, "state/script-ledger.md"))?.text ?? "";
  expect(ledger).toContain(first.path);
  expect(ledger).not.toContain(second.path);
});

test("chapter reorder moves chapter scripts and regenerates their chapter positions", async () => {
  const first = buildParagraphScriptArtifact({ chapterSlug: "001-one", number: 1, title: "First", paragraphSlug: "001-first" });
  const second = buildParagraphScriptArtifact({ chapterSlug: "002-two", number: 1, title: "Second", paragraphSlug: "001-second" });
  await repository([chapter("001-one", 1), chapter("002-two", 2), paragraph("001-one", "001-first", 1), paragraph("002-two", "001-second", 1), first, second]);

  const outcome = await reorderChaptersInBook("token", "owner", "repo", "main", [{ slug: "002-two" }, { slug: "001-one" }]);

  expect(outcome.canonical?.changedPaths).toContain("state/script-ledger.md");
  const ledger = (await getLocalFile(repoId, "state/script-ledger.md"))?.text ?? "";
  expect(ledger).toContain("scripts/001-two/001-second.md");
  expect(ledger).toContain("scripts/002-one/001-first.md");
  expect(ledger).not.toContain("scripts/001-one/001-first.md");
});

test("paragraph reorder works in a local repository without scripts", async () => {
  await repository([
    paragraph("001-one", "001-first", 1),
    paragraph("001-one", "002-second", 2),
  ]);

  const outcome = await reorderParagraphsInChapter("token", "owner", "repo", "main", "chapters/001-one", [
    { number: "001", title: "First", path: "chapters/001-one/001-first.md" },
    { number: "002", title: "Second", path: "chapters/001-one/002-second.md" },
  ], [
    { number: "002", title: "Second", path: "chapters/001-one/002-second.md" },
    { number: "001", title: "First", path: "chapters/001-one/001-first.md" },
  ]);

  expect(outcome.paragraphs.map((entry) => entry.path)).toEqual([
    "chapters/001-one/001-second.md",
    "chapters/001-one/002-first.md",
  ]);
  expect(await getLocalFile(repoId, "chapters/001-one/001-second.md")).not.toBeNull();
});

test("a malformed moved script aborts the complete structural transaction", async () => {
  const oldSlug = "001-opening";
  const malformed = { path: `scripts/001-one/${oldSlug}.md`, content: "---\ntype: script\ntitle: Missing required identity\n---\n\n@scene_goal{Open}" };
  await repository([chapter("001-one", 1), paragraph("001-one", oldSlug, 1), malformed]);

  await expect(renameParagraphWithCompanions("token", "owner", "repo", "main", "chapters/001-one", { number: "001", title: "Opening", path: `chapters/001-one/${oldSlug}.md`, scriptPath: malformed.path }, "chapters/001-one/001-renamed.md", paragraph("001-one", "001-renamed", 1).content, "Rename paragraph")).rejects.toMatchObject({ name: "ScriptLedgerValidationError" });

  expect((await getLocalFile(repoId, malformed.path))?.text).toBe(malformed.content);
  expect(await getLocalFile(repoId, "scripts/001-one/001-renamed.md")).toBeNull();
  expect(await getLocalFile(repoId, "state/script-ledger.md")).toBeNull();
});

test("paragraph deletion rejects a stale user-loaded revision without changing companions", async () => {
  const target = paragraph("001-one", "001-first", 1);
  const script = buildParagraphScriptArtifact({ chapterSlug: "001-one", number: 1, title: "First", paragraphSlug: "001-first" });
  await repository([chapter("001-one", 1), target, script]);

  await expect(reorderParagraphsInChapter("token", "owner", "repo", "main", "chapters/001-one", [
    { number: "001", title: "First", path: target.path, scriptPath: script.path },
  ], [], "Delete paragraph", { expectedRemoteHeadSha: "head", expectedParagraphHashes: { [target.path]: "stale" } })).rejects.toMatchObject({ kind: "conflict" });

  expect((await getLocalFile(repoId, target.path))?.text).toBe(target.content);
  expect(await getLocalFile(repoId, script.path)).not.toBeNull();
});

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { BRAINSTORMER_FILE, BookConflictError, defaultBrainstormer, parseBrainstormer } from "narrarium-engine";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import { loadBrainstormerProfile, renderBrainstormerFile, saveBrainstormerProfile } from "@/narrarium/brainstormer";
import { listUnpushedLocalCommits, putLocalRepository, removeLocalRepository, sha256Text } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import type { BookEntry } from "@/types/settings";
import { putCleanLocalFile } from "./helpers/localRepositorySeed";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const book: BookEntry = { id: "book-brainstormer", owner: "owner", repo: "brainstormer-page", name: "The Glass Harbor", tokenIndex: null, addedAt: "2026-11-21T00:00:00.000Z" };
let repoId = "";

async function workingCopy(files: Record<string, string> = {}): Promise<void> {
  const repo = await putLocalRepository({ bookId: book.id, owner: book.owner, repo: book.repo, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: "2026-11-21T00:00:00.000Z", cloneComplete: true }, captureRepositoryOperationScope());
  repoId = repo.id;
  for (const [path, text] of Object.entries(files)) await putCleanLocalFile({ repoId, path, kind: "text", text, size: new TextEncoder().encode(text).length });
}

const store = () => createBrowserBookStore(book, "main");
const read = async () => (await store().read(BRAINSTORMER_FILE))?.content ?? null;

afterEach(async () => {
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

function savedFile(patch: Partial<ReturnType<typeof defaultBrainstormer>> = {}): string {
  return renderBrainstormerFile({ ...defaultBrainstormer("en"), name: "Saved brainstormer", ...patch }, null);
}

// The Brainstormer of a book (`brainstormer.md`) is read and saved as the director is: one local commit, never over a change the author did not see.

describe("loading the Brainstormer", () => {
  it("returns the version of the file that was read: a hash, or null when it does not exist yet, and then the defaults in the language of the book", async () => {
    await workingCopy();
    const defaults = await loadBrainstormerProfile({ book, branch: "main", language: "it" });
    expect(defaults).toMatchObject({ exists: false, hash: null });
    expect(defaults.profile).toMatchObject({ language: "it", name: defaultBrainstormer("it").name });

    const text = savedFile();
    await store().commit([{ path: BRAINSTORMER_FILE, content: text, expectedHash: null }], "Add brainstormer");
    const loaded = await loadBrainstormerProfile({ book, branch: "main", language: "en" });
    expect(loaded).toMatchObject({ exists: true, hash: await sha256Text(text) });
    expect(loaded.profile.name).toBe("Saved brainstormer");
  });

  it("says what is wrong with a file it could not read as it is written, and does not hide it", async () => {
    await workingCopy({ [BRAINSTORMER_FILE]: "---\nname: Nora\nboldness: very\n---\n\nMethod.\n" });
    const { profile } = await loadBrainstormerProfile({ book, branch: "main", language: "en" });
    expect(profile.name).toBe("Nora");
    expect(profile.warnings?.join(" ")).toMatch(/brainstormer\.md: boldness/);
  });
});

describe("the file of the Brainstormer", () => {
  it("is the engine's serialisation, and the keys of the frontmatter an author added are kept", () => {
    const existing = "---\ntype: brainstormer\nid: brainstormer:main\nname: Old\nmood: stormy\n---\n\nOld method.\n";
    const content = renderBrainstormerFile({ ...defaultBrainstormer("en"), name: "Nora", body: "New method." }, existing);
    expect(content).toContain("name: Nora");
    expect(content).toContain("mood: stormy");
    expect(content.trimEnd().endsWith("New method.")).toBe(true);
    expect(parseBrainstormer(content).name).toBe("Nora");
  });
});

describe("saving the Brainstormer", () => {
  it("without an expected version replaces the version read at save time", async () => {
    await workingCopy({ [BRAINSTORMER_FILE]: savedFile() });
    await store().commit([{ path: BRAINSTORMER_FILE, content: savedFile({ name: "Changed elsewhere" }) }], "Concurrent edit");

    const result = await saveBrainstormerProfile({ book, branch: "main", profile: { ...defaultBrainstormer("en"), name: "My edit" } });
    expect(await read()).toContain("My edit");
    expect(result.hash).toBe(await sha256Text((await read()) ?? ""));
  });

  it("saves when the file is still the version the author edited, and returns the hash of what was written to expect next", async () => {
    await workingCopy({ [BRAINSTORMER_FILE]: savedFile() });
    const { hash } = await loadBrainstormerProfile({ book, branch: "main", language: "en" });

    const saved = await saveBrainstormerProfile({ book, branch: "main", profile: { ...defaultBrainstormer("en"), name: "My edit" }, expectedHash: hash });
    expect(await read()).toContain("My edit");
    expect(saved.hash).toBe(await sha256Text((await read()) ?? ""));
    await expect(saveBrainstormerProfile({ book, branch: "main", profile: { ...defaultBrainstormer("en"), name: "Second edit" }, expectedHash: saved.hash })).resolves.toBeDefined();
    expect(await read()).toContain("Second edit");
  });

  it("refuses to overwrite a change made after the author opened the page, and leaves that change alone", async () => {
    await workingCopy({ [BRAINSTORMER_FILE]: savedFile() });
    const { hash } = await loadBrainstormerProfile({ book, branch: "main", language: "en" });
    const concurrent = savedFile({ name: "Changed on another device" });
    await store().commit([{ path: BRAINSTORMER_FILE, content: concurrent }], "Concurrent edit");

    await expect(saveBrainstormerProfile({ book, branch: "main", profile: { ...defaultBrainstormer("en"), name: "My edit" }, expectedHash: hash })).rejects.toBeInstanceOf(BookConflictError);
    expect(await read()).toBe(concurrent);
  });

  it("refuses to create the file when someone created it after the page was opened, and to bring back one that was deleted", async () => {
    await workingCopy();
    const absent = await loadBrainstormerProfile({ book, branch: "main", language: "en" });
    expect(absent.hash).toBeNull();
    const concurrent = savedFile({ name: "Created elsewhere" });
    await store().commit([{ path: BRAINSTORMER_FILE, content: concurrent, expectedHash: null }], "Add brainstormer");
    await expect(saveBrainstormerProfile({ book, branch: "main", profile: { ...defaultBrainstormer("en"), name: "My edit" }, expectedHash: absent.hash })).rejects.toBeInstanceOf(BookConflictError);
    expect(await read()).toBe(concurrent);

    const { hash } = await loadBrainstormerProfile({ book, branch: "main", language: "en" });
    await store().commit([{ path: BRAINSTORMER_FILE, content: null }], "Remove brainstormer");
    await expect(saveBrainstormerProfile({ book, branch: "main", profile: { ...defaultBrainstormer("en"), name: "My edit" }, expectedHash: hash })).rejects.toBeInstanceOf(BookConflictError);
    expect(await read()).toBeNull();
  });

  it("creates the file when it still does not exist, and does not commit again when nothing changed", async () => {
    await workingCopy();
    const { hash } = await loadBrainstormerProfile({ book, branch: "main", language: "en" });
    await saveBrainstormerProfile({ book, branch: "main", profile: { ...defaultBrainstormer("en"), name: "First brainstormer" }, expectedHash: hash });
    expect(await read()).toContain("First brainstormer");

    const loaded = await loadBrainstormerProfile({ book, branch: "main", language: "en" });
    const before = (await listUnpushedLocalCommits(repoId)).length;
    const again = await saveBrainstormerProfile({ book, branch: "main", profile: loaded.profile, expectedHash: loaded.hash });
    expect(again.hash).toBe(loaded.hash);
    expect(await listUnpushedLocalCommits(repoId)).toHaveLength(before);
  });
});

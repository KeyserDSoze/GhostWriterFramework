import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { BookConflictError, DIRECTOR_FILE, defaultDirector } from "narrarium-engine";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import { loadDirectorProfile, renderDirectorFile, saveDirectorProfile } from "@/narrarium/director";
import { listUnpushedLocalCommits, putLocalRepository, removeLocalRepository, sha256Text } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import type { BookEntry } from "@/types/settings";
import { putCleanLocalFile } from "./helpers/localRepositorySeed";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const book: BookEntry = { id: "book-director", owner: "owner", repo: "director-page", name: "The Glass Harbor", tokenIndex: null, addedAt: "2026-11-21T00:00:00.000Z" };
let repoId = "";

async function workingCopy(files: Record<string, string> = {}): Promise<void> {
  const repo = await putLocalRepository({ bookId: book.id, owner: book.owner, repo: book.repo, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: "2026-11-21T00:00:00.000Z", cloneComplete: true }, captureRepositoryOperationScope());
  repoId = repo.id;
  for (const [path, text] of Object.entries(files)) await putCleanLocalFile({ repoId, path, kind: "text", text, size: new TextEncoder().encode(text).length });
}

const store = () => createBrowserBookStore(book, "main");
const read = async () => (await store().read(DIRECTOR_FILE))?.content ?? null;

afterEach(async () => {
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
});

function savedFile(patch: Partial<ReturnType<typeof defaultDirector>> = {}): string {
  return renderDirectorFile({ ...defaultDirector("en"), name: "Saved director", ...patch }, null);
}

describe("loading the director", () => {
  it("returns the version of the file that was read: a hash, or null when it does not exist yet", async () => {
    await workingCopy();
    await expect(loadDirectorProfile({ book, branch: "main", language: "en" })).resolves.toMatchObject({ exists: false, hash: null });

    const text = savedFile();
    await store().commit([{ path: DIRECTOR_FILE, content: text, expectedHash: null }], "Add director");
    const loaded = await loadDirectorProfile({ book, branch: "main", language: "en" });
    expect(loaded).toMatchObject({ exists: true, hash: await sha256Text(text) });
    expect(loaded.profile.name).toBe("Saved director");
  });
});

describe("saving the director", () => {
  it("without an expected version keeps the old behavior: the version read at save time is the one replaced", async () => {
    await workingCopy({ [DIRECTOR_FILE]: savedFile() });
    await store().commit([{ path: DIRECTOR_FILE, content: savedFile({ name: "Changed elsewhere" }) }], "Concurrent edit");

    const result = await saveDirectorProfile({ book, branch: "main", profile: { ...defaultDirector("en"), name: "My edit" } });
    expect((await read())).toContain("My edit");
    expect(result.hash).toBe(await sha256Text((await read()) ?? ""));
  });

  it("saves when the file is still the version the author edited, and returns the hash of what was written", async () => {
    await workingCopy({ [DIRECTOR_FILE]: savedFile() });
    const { hash } = await loadDirectorProfile({ book, branch: "main", language: "en" });

    const saved = await saveDirectorProfile({ book, branch: "main", profile: { ...defaultDirector("en"), name: "My edit" }, expectedHash: hash });
    expect(await read()).toContain("My edit");
    expect(saved.hash).toBe(await sha256Text((await read()) ?? ""));

    // The returned version is the one to expect for the next save.
    await expect(saveDirectorProfile({ book, branch: "main", profile: { ...defaultDirector("en"), name: "Second edit" }, expectedHash: saved.hash })).resolves.toBeDefined();
    expect(await read()).toContain("Second edit");
  });

  it("refuses to overwrite a change made after the author opened the page, and leaves that change alone", async () => {
    await workingCopy({ [DIRECTOR_FILE]: savedFile() });
    const { hash } = await loadDirectorProfile({ book, branch: "main", language: "en" });
    const concurrent = savedFile({ name: "Changed on another device" });
    await store().commit([{ path: DIRECTOR_FILE, content: concurrent }], "Concurrent edit");

    await expect(saveDirectorProfile({ book, branch: "main", profile: { ...defaultDirector("en"), name: "My edit" }, expectedHash: hash })).rejects.toBeInstanceOf(BookConflictError);
    expect(await read()).toBe(concurrent);
  });

  it("refuses to create the file when someone created it after the page was opened", async () => {
    await workingCopy();
    const { hash } = await loadDirectorProfile({ book, branch: "main", language: "en" });
    expect(hash).toBeNull();
    const concurrent = savedFile({ name: "Created elsewhere" });
    await store().commit([{ path: DIRECTOR_FILE, content: concurrent, expectedHash: null }], "Add director");

    await expect(saveDirectorProfile({ book, branch: "main", profile: { ...defaultDirector("en"), name: "My edit" }, expectedHash: hash })).rejects.toBeInstanceOf(BookConflictError);
    expect(await read()).toBe(concurrent);
  });

  it("refuses to bring back a file that was deleted after the page was opened", async () => {
    await workingCopy({ [DIRECTOR_FILE]: savedFile() });
    const { hash } = await loadDirectorProfile({ book, branch: "main", language: "en" });
    await store().commit([{ path: DIRECTOR_FILE, content: null }], "Remove director");

    await expect(saveDirectorProfile({ book, branch: "main", profile: { ...defaultDirector("en"), name: "My edit" }, expectedHash: hash })).rejects.toBeInstanceOf(BookConflictError);
    expect(await read()).toBeNull();
  });

  it("creates the file when it still does not exist", async () => {
    await workingCopy();
    const { hash } = await loadDirectorProfile({ book, branch: "main", language: "en" });
    await saveDirectorProfile({ book, branch: "main", profile: { ...defaultDirector("en"), name: "First director" }, expectedHash: hash });
    expect(await read()).toContain("First director");
  });

  it("does not commit again when nothing changed", async () => {
    const text = savedFile();
    await workingCopy({ [DIRECTOR_FILE]: text });
    const { profile, hash } = await loadDirectorProfile({ book, branch: "main", language: "en" });
    const saved = await saveDirectorProfile({ book, branch: "main", profile, expectedHash: hash });
    expect(saved.hash).toBe(hash);
    expect(await listUnpushedLocalCommits(repoId)).toHaveLength(0);
  });
});

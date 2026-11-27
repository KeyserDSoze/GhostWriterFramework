import { describe, expect, it } from "vitest";
import { planPagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";
import { loadBookTemplate, type BookTemplate } from "@/narrarium/bookTemplate";
import { decideReaderUpdate, deliveryOf, type ReaderUpdateInputs } from "@/readerUpdate/decision";
import { CustomizedWorkflowRefused, buildReaderUpdateCommit } from "@/readerUpdate/commit";
import { mergeReaderPackageJson, planReaderFolder, templateReaderVersion, type ReaderFolderPlan } from "@/readerUpdate/folderPlan";
import { outsideCheckCommand, outsideCheckUrls, runOutsideCheck } from "@/readerUpdate/outsideCheck";
import v1 from "./fixtures/pagesWorkflowV1.yml?raw";

const sha = async (text: string) => {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

let template: BookTemplate;
const readerPaths = () => Object.keys(template.files).filter((path) => path.startsWith("reader/"));
const fallbackPackageName = "the-glass-harbor-reader";

/** The working copy of a repository that already has exactly what the template has: what the template writes, with the name of the book's reader. */
async function upToDate(): Promise<Map<string, string>> {
  const existing = new Map<string, string>();
  for (const path of readerPaths()) existing.set(path, await sha(template.files[path].text.split(template.placeholders.readerPackage).join(fallbackPackageName)));
  return existing;
}

const planWith = (existing: Map<string, string>, extra: Partial<Parameters<typeof planReaderFolder>[0]> = {}) =>
  planReaderFolder({ template, existing, existingPackageJson: null, fallbackPackageName, hash: sha, ...extra });

describe("what an update of the reader/ folder changes", () => {
  it("adds every reader file of the template to a repository that has none, and writes nothing outside reader/", async () => {
    template = await loadBookTemplate();
    const plan = await planWith(new Map());
    expect(plan.present).toBe(false);
    expect(plan.writes.map((file) => file.path)).toEqual(readerPaths().sort());
    expect(plan.writes.every((file) => file.change === "added" && file.expectedHash === null)).toBe(true);
    expect(plan.deletes).toEqual([]);
    expect(plan.version).toBe(templateReaderVersion(template));
    expect(plan.version).toMatch(/^\d+\.\d+\.\d+$/);
  }, 60_000);

  it("finds nothing to do in a repository that has the reader the template has (the second run says current)", async () => {
    const plan = await planWith(await upToDate(), { existingPackageJson: mergeReaderPackageJson(null, template.files["reader/package.json"].text.split(template.placeholders.readerPackage).join(fallbackPackageName)) });
    expect(plan.writes).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.unchanged + plan.kept.length).toBe(readerPaths().length);
  });

  it("replaces a file that differs, adds one that is missing, and leaves the files of the author's own setup alone", async () => {
    const existing = await upToDate();
    existing.set("reader/src/lib/book.ts", await sha("an old version"));
    existing.delete("reader/src/lib/reader-passwords.ts");
    existing.set("reader/.env", await sha("NARRARIUM_BOOK_ROOT=../elsewhere\n"));
    existing.set("reader/src/lib/book-config.ts", await sha('export const defaultBookRoot = "../book";\n'));
    const plan = await planWith(existing, { existingPackageJson: mergeReaderPackageJson(null, template.files["reader/package.json"].text.split(template.placeholders.readerPackage).join(fallbackPackageName)) });
    expect(plan.writes.map((file) => [file.path, file.change])).toEqual([["reader/src/lib/book.ts", "replaced"], ["reader/src/lib/reader-passwords.ts", "added"]]);
    expect(plan.writes[0].expectedHash).toBe(await sha("an old version"));
    expect(plan.kept).toEqual(["reader/.env", "reader/.github/workflows/deploy-pages.yml", "reader/scripts/book-config.mjs", "reader/src/lib/book-config.ts"]);
  });

  it("deletes a file the reader no longer has only if it is listed as retired, is under reader/ and is not in the template", async () => {
    const existing = await upToDate();
    existing.set("reader/src/lib/old-thing.ts", "hash-old");
    existing.set("reader/src/lib/not-listed.ts", "hash-x");
    existing.set("chapters/001/chapter.md", "hash-chapter");
    const plan = await planWith(existing, { retired: ["reader/src/lib/old-thing.ts", "chapters/001/chapter.md", "reader/src/lib/book.ts", "reader/src/lib/gone-already.ts"] });
    expect(plan.deletes).toEqual([{ path: "reader/src/lib/old-thing.ts", expectedHash: "hash-old" }]);
  });

  it("keeps the name of the reader's package and the dependencies the author added, and brings the template's own up to date", () => {
    const templateText = JSON.stringify({ name: "__R__", private: true, scripts: { build: "astro build" }, dependencies: { narrarium: "^0.1.61", astro: "^7.2.6" } });
    const existing = JSON.stringify({ name: "jesus-reader", private: true, scripts: { build: "old", mine: "echo" }, dependencies: { narrarium: "^0.1.50", astro: "^5.0.0", leaflet: "^1.9.0" }, license: "MIT" });
    const merged = JSON.parse(mergeReaderPackageJson(existing, templateText));
    expect(merged).toEqual({ name: "jesus-reader", private: true, scripts: { build: "astro build", mine: "echo" }, dependencies: { narrarium: "^0.1.61", astro: "^7.2.6", leaflet: "^1.9.0" }, license: "MIT" });
    expect(mergeReaderPackageJson(JSON.stringify(merged, null, 2) + "\n", templateText)).toBe(`${JSON.stringify(merged, null, 2)}\n`);
    expect(JSON.parse(mergeReaderPackageJson("not json", templateText)).name).toBe("__R__");
    expect(mergeReaderPackageJson(null, templateText).endsWith("\n")).toBe(true);
  });
});

function folder(overrides: Partial<ReaderFolderPlan> = {}): ReaderFolderPlan {
  return { present: true, writes: [{ path: "reader/src/lib/book.ts", content: "new", change: "replaced", expectedHash: "h" }], deletes: [], unchanged: 3, kept: [], version: "0.1.61", ...overrides };
}
const current = planPagesWorkflowUpgrade(v1).text;
const base: ReaderUpdateInputs = { storage: "github", workingCopy: true, workflowText: v1, folder: folder(), branch: "main", online: true, credential: true, localChanges: false };

describe("whether the reader of a book needs updating", () => {
  it("says a book kept on this device has no published reader, and a branch without a working copy here cannot be checked", () => {
    expect(decideReaderUpdate({ ...base, storage: "local-only" })).toEqual({ kind: "local-only" });
    expect(decideReaderUpdate({ ...base, workingCopy: false })).toEqual({ kind: "no-working-copy" });
    expect(decideReaderUpdate({ ...base, workflowText: undefined })).toEqual({ kind: "unreadable" });
    expect(decideReaderUpdate({ ...base, folder: null })).toEqual({ kind: "unreadable" });
  });

  it("finds nothing to update when there is no reader at all, or when the workflow and the folder are the current ones", () => {
    expect(decideReaderUpdate({ ...base, workflowText: null, folder: folder({ present: false, writes: [] }) })).toEqual({ kind: "not-published" });
    expect(decideReaderUpdate({ ...base, workflowText: current, folder: folder({ writes: [] }), remote: { pagesOn: true, passwordsSet: false, workflowText: current } })).toEqual({ kind: "current", version: "0.1.61", remote: "checked" });
  });

  it("is current only when GitHub has the current workflow too: with the old one there it is «on this device», never «up to date»", () => {
    const local = { ...base, workflowText: current, folder: folder({ writes: [] }) };
    expect(decideReaderUpdate({ ...local, remote: { pagesOn: true, passwordsSet: true, workflowText: current } })).toEqual({ kind: "current", version: "0.1.61", remote: "checked" });
    expect(decideReaderUpdate(local)).toEqual({ kind: "current", version: "0.1.61", remote: "unchecked" });
    expect(decideReaderUpdate({ ...local, remote: { pagesOn: true, passwordsSet: true, workflowText: v1 } })).toMatchObject({ kind: "on-device", reason: "remote-differs", remoteWorkflow: "old", exposure: "password-old-reader" });
    expect(decideReaderUpdate({ ...local, remote: { pagesOn: true, passwordsSet: false, workflowText: v1 } })).toMatchObject({ kind: "on-device", exposure: "old-reader" });
    expect(decideReaderUpdate({ ...local, remote: { pagesOn: false, passwordsSet: true, workflowText: v1 } })).toMatchObject({ kind: "on-device", exposure: "not-published" });
    expect(decideReaderUpdate({ ...local, remote: { pagesOn: true, passwordsSet: true, workflowText: null } })).toMatchObject({ kind: "on-device", remoteWorkflow: "missing" });
  });

  it("is on this device when local commits touching the reader are not on GitHub, even when GitHub could not be read", () => {
    const local = { ...base, workflowText: current, folder: folder({ writes: [] }), unpublished: ["reader/src/lib/book.ts"] };
    expect(decideReaderUpdate(local)).toMatchObject({ kind: "on-device", reason: "local-commits", remoteWorkflow: "unknown", exposure: null, unpublished: ["reader/src/lib/book.ts"], delivery: "now" });
    expect(decideReaderUpdate({ ...local, remote: { pagesOn: true, passwordsSet: true, workflowText: current } })).toMatchObject({ kind: "on-device", reason: "local-commits", remoteWorkflow: "current" });
    expect(decideReaderUpdate({ ...local, credential: false })).toMatchObject({ kind: "on-device", delivery: "no-credential" });
    expect(decideReaderUpdate({ ...local, online: false })).toMatchObject({ kind: "on-device", delivery: "offline" });
  });

  it("offers an update when the workflow is old, when only the folder is old, and when the workflow is missing next to a reader", () => {
    expect(decideReaderUpdate(base)).toMatchObject({ kind: "update", workflowChanges: true, customized: false });
    expect(decideReaderUpdate({ ...base, workflowText: current })).toMatchObject({ kind: "update", workflowChanges: false });
    expect(decideReaderUpdate({ ...base, workflowText: null })).toMatchObject({ kind: "update", workflowChanges: true, workflow: { status: "missing" } });
  });

  it("says a book published with a password and an old reader exposes it, and a public or unpublished one does not", () => {
    const withPassword = v1.replace("          SITE_BASE:", "          NARRARIUM_READER_PASSWORD: ${{ secrets.BOOK_PASSWORD }}\n          SITE_BASE:");
    expect(decideReaderUpdate({ ...base, workflowText: withPassword })).toMatchObject({ exposure: "password-old-reader" });
    expect(decideReaderUpdate({ ...base, remote: { pagesOn: true, passwordsSet: true } })).toMatchObject({ exposure: "password-old-reader" });
    expect(decideReaderUpdate({ ...base, remote: { pagesOn: true, passwordsSet: false } })).toMatchObject({ exposure: "old-reader" });
    expect(decideReaderUpdate({ ...base, workflowText: withPassword, remote: { pagesOn: false, passwordsSet: true } })).toMatchObject({ exposure: "not-published" });
  });

  it("keeps the older single password as one slot: the workflow to commit still passes it", () => {
    const withPassword = v1.replace("          SITE_BASE:", "          NARRARIUM_READER_PASSWORD: ${{ secrets.BOOK_PASSWORD }}\n          SITE_BASE:");
    const decision = decideReaderUpdate({ ...base, workflowText: withPassword });
    expect(decision.kind === "update" && decision.workflow.text).toContain("NARRARIUM_READER_PASSWORD: ${{ secrets.BOOK_PASSWORD }}");
  });

  it("treats a workflow with edits as customized, never as safe, and shows the lines that differ", () => {
    const edited = `${current}\n  extra:\n    runs-on: ubuntu-latest\n`;
    const decision = decideReaderUpdate({ ...base, workflowText: edited });
    expect(decision).toMatchObject({ kind: "update", customized: true, workflow: { safe: false } });
    expect(decision.kind === "update" && decision.workflow.customizations.some((line) => line.startsWith("+ "))).toBe(true);
  });

  it("does not touch a reader that is kept elsewhere than reader/", () => {
    const elsewhere = planPagesWorkflowUpgrade(null, { readerDir: "site" }).text;
    expect(decideReaderUpdate({ ...base, workflowText: elsewhere })).toEqual({ kind: "elsewhere", readerDir: "site" });
  });

  it("says when the commit can be published at once and when it waits on this device", () => {
    expect(deliveryOf({ credential: true, online: true, localChanges: false })).toBe("now");
    expect(deliveryOf({ credential: true, online: false, localChanges: false })).toBe("offline");
    expect(deliveryOf({ credential: false, online: true, localChanges: false })).toBe("no-credential");
    expect(deliveryOf({ credential: true, online: true, localChanges: true })).toBe("local-changes");
    expect(deliveryOf({ credential: false, online: false, localChanges: true })).toBe("no-credential");
    expect(decideReaderUpdate({ ...base, online: false })).toMatchObject({ delivery: "offline" });
    expect(decideReaderUpdate({ ...base, branch: "draft" })).toMatchObject({ publishesFromBranch: false });
    expect(decideReaderUpdate(base)).toMatchObject({ publishesFromBranch: true });
  });
});

describe("the update when the author works on a branch that is not the publishing one", () => {
  const plan = (writes: number, workflowText: string | null): import("@/readerUpdate/publishingBranch").PublishingBranchRead => ({
    branch: "main", source: "github", headSha: "head-1", workflowText, workflowHash: null,
    folder: folder({ writes: Array.from({ length: writes }, (_, index) => ({ path: `reader/src/f${index}.ts`, content: "new", change: "replaced" as const, expectedHash: `h${index}` })) }),
  });
  const onFeature = { ...base, branch: "feature/x", publishingBranch: "main" } satisfies ReaderUpdateInputs;

  it("takes the publishing branch from the repository: the one it names is the one, whatever it is called", () => {
    expect(decideReaderUpdate({ ...base, branch: "main", publishingBranch: "trunk" })).toMatchObject({ publishesFromBranch: false });
    expect(decideReaderUpdate({ ...base, branch: "trunk", publishingBranch: "trunk" })).toMatchObject({ publishesFromBranch: true });
    expect(decideReaderUpdate({ ...base, branch: "master", publishingBranch: "master" })).toMatchObject({ publishesFromBranch: true });
    // Only when the repository has not been asked are main and master taken for it.
    expect(decideReaderUpdate({ ...base, branch: "master" })).toMatchObject({ publishesFromBranch: true });
  });

  it("plans the update on the publishing branch as well when it has an old reader, with the files of that branch's own state", () => {
    const decision = decideReaderUpdate({ ...onFeature, publishing: plan(2, v1) });
    expect(decision).toMatchObject({ kind: "update", currentNeeded: true, publishing: { branch: "main", state: "old" }, publishingTarget: { branch: "main", source: "github", headSha: "head-1", workflowChanges: true, delivery: "now" } });
    expect(decision.kind === "update" && decision.publishingTarget?.folder.writes).toHaveLength(2);
  });

  it("offers the update for the publishing branch alone when this branch is already updated, and says so", () => {
    const decision = decideReaderUpdate({ ...onFeature, workflowText: current, folder: folder({ writes: [] }), publishing: plan(1, v1) });
    expect(decision).toMatchObject({ kind: "update", currentNeeded: false, publishing: { state: "old" }, publishingTarget: { branch: "main" } });
  });

  it("says that only this branch is old when the publishing branch is current, and is not exposed", () => {
    const decision = decideReaderUpdate({ ...onFeature, remote: { pagesOn: true, passwordsSet: true }, publishing: plan(0, current) });
    expect(decision).toMatchObject({ kind: "update", currentNeeded: true, exposure: "branch-only", publishing: { state: "current" } });
    expect(decision.kind === "update" && decision.publishingTarget).toBeUndefined();
  });

  it("is current when both branches are, and keeps the two states for the cards", () => {
    const decision = decideReaderUpdate({ ...onFeature, workflowText: current, folder: folder({ writes: [] }), publishing: plan(0, current) });
    expect(decision).toMatchObject({ kind: "current", publishing: { branch: "main", state: "current" } });
  });

  it("claims nothing of the publishing branch when GitHub could not be asked, or did not answer, and keeps the exposure of the old reader", () => {
    expect(decideReaderUpdate({ ...onFeature, online: false })).toMatchObject({ kind: "update", currentNeeded: true, publishing: { branch: "main", state: "unknown" }, exposure: "old-reader", delivery: "offline" });
    expect(decideReaderUpdate({ ...onFeature, publishing: "unreadable" })).toMatchObject({ kind: "update", publishing: { state: "unreadable" } });
    expect(decideReaderUpdate({ ...onFeature, credential: false })).toMatchObject({ kind: "update", publishing: { state: "unknown" }, delivery: "no-credential" });
  });

  it("waits on this device for the publishing branch when GitHub cannot be reached now (not yet on main)", () => {
    const decision = decideReaderUpdate({ ...onFeature, credential: false, publishing: plan(1, v1) });
    expect(decision).toMatchObject({ kind: "update", publishingTarget: { delivery: "no-credential" } });
  });

  it("has no publishing side when the author works on the publishing branch itself", () => {
    const decision = decideReaderUpdate({ ...base, publishingBranch: "main" });
    expect(decision).toMatchObject({ kind: "update", currentNeeded: true, publishesFromBranch: true });
    expect(decision.kind === "update" && decision.publishing).toBeUndefined();
  });

  it("makes the same commit for both branches: the same files in the same order", () => {
    const decision = decideReaderUpdate({ ...onFeature, publishing: plan(2, v1) });
    if (decision.kind !== "update" || !decision.publishingTarget) throw new Error("expected both");
    const mine = buildReaderUpdateCommit(decision, { replaceEdits: false, workflowHash: "wf" });
    const theirs = buildReaderUpdateCommit(decision.publishingTarget, { replaceEdits: false, workflowHash: null, unchecked: true });
    expect(theirs.mutations.every((mutation) => !("expectedCurrentHash" in mutation))).toBe(true);
    expect(theirs.mutations.find((mutation) => mutation.path.endsWith("deploy-reader-pages.yml"))?.content).toBe(mine.mutations.find((mutation) => mutation.path.endsWith("deploy-reader-pages.yml"))?.content);
  });
});

describe("the commit of the update", () => {
  const update = () => {
    const decision = decideReaderUpdate({ ...base, folder: folder({ writes: [
      { path: "reader/src/lib/book.ts", content: "new", change: "replaced", expectedHash: "h1" },
      { path: "reader/src/lib/reader-passwords.ts", content: "added", change: "added", expectedHash: null },
    ], deletes: [{ path: "reader/src/old.ts", expectedHash: "h2" }] }) });
    if (decision.kind !== "update") throw new Error("expected an update");
    return decision;
  };

  it("is ONE commit: the workflow from the package first, then the reader's files, then the deletions, each checked against what the working copy had", () => {
    const commit = buildReaderUpdateCommit(update(), { replaceEdits: false, workflowHash: "wf-hash" });
    expect(commit.paths).toEqual([".github/workflows/deploy-reader-pages.yml", "reader/src/lib/book.ts", "reader/src/lib/reader-passwords.ts", "reader/src/old.ts"]);
    expect(commit.mutations).toEqual([
      { path: ".github/workflows/deploy-reader-pages.yml", content: planPagesWorkflowUpgrade(v1).text, expectedCurrentHash: "wf-hash" },
      { path: "reader/src/lib/book.ts", content: "new", expectedCurrentHash: "h1" },
      { path: "reader/src/lib/reader-passwords.ts", content: "added", expectedCurrentHash: null },
      { path: "reader/src/old.ts", content: null, expectedCurrentHash: "h2" },
    ]);
    expect(commit.message.split("\n")[0]).toBe("Update the reader to version 0.1.61");
    expect(commit.message).toContain("1 replaced, 1 added, 1 deleted");
    expect(commit.message).toContain("The book's own files are not touched.");
  });

  it("leaves the workflow out when it is already the current one", () => {
    const decision = decideReaderUpdate({ ...base, workflowText: current });
    if (decision.kind !== "update") throw new Error("expected an update");
    expect(buildReaderUpdateCommit(decision, { replaceEdits: false, workflowHash: "x" }).paths).toEqual(["reader/src/lib/book.ts"]);
  });

  it("refuses a customized workflow unless the owner said «replace my edits»", () => {
    const edited = `${current}\n  extra:\n    runs-on: ubuntu-latest\n`;
    const decision = decideReaderUpdate({ ...base, workflowText: edited });
    if (decision.kind !== "update") throw new Error("expected an update");
    expect(() => buildReaderUpdateCommit(decision, { replaceEdits: false, workflowHash: "x" })).toThrow(CustomizedWorkflowRefused);
    const commit = buildReaderUpdateCommit(decision, { replaceEdits: true, workflowHash: "x" });
    expect(commit.mutations[0]).toMatchObject({ path: ".github/workflows/deploy-reader-pages.yml", content: planPagesWorkflowUpgrade(edited).text });
    expect(commit.message).toContain("edits of the workflow were replaced");
  });
});

describe("the check from outside", () => {
  const urls = outsideCheckUrls("https://me.github.io/jesus", 1234);

  it("asks for the EPUB and for version.json of the published address, with a stamp, and gives the same two as a line for a terminal", () => {
    expect(urls).toEqual({ baseUrl: "https://me.github.io/jesus/", epub: "https://me.github.io/jesus/downloads/book.epub?check=1234", version: "https://me.github.io/jesus/version.json?check=1234" });
    expect(outsideCheckUrls("https://me.github.io/jesus/", 1).epub).toBe("https://me.github.io/jesus/downloads/book.epub?check=1");
    expect(outsideCheckCommand(urls)).toBe('curl -s -o /dev/null -w "%{http_code}\\n" "https://me.github.io/jesus/downloads/book.epub?check=1234" && curl -s "https://me.github.io/jesus/version.json?check=1234"');
  });

  const answer = (status: number, body?: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

  it("is protected only when the EPUB answers 404 AND version.json says protected", async () => {
    const fetcher = async (url: string) => (url.includes("book.epub") ? answer(404) : answer(200, { protected: true }));
    await expect(runOutsideCheck(urls, fetcher)).resolves.toEqual({ kind: "protected" });
  });

  it("says the EPUB is exposed when it is served, whatever version.json says", async () => {
    await expect(runOutsideCheck(urls, async () => answer(200, { protected: true }))).resolves.toEqual({ kind: "epub-exposed", status: 200 });
  });

  it("says the book is not protected when the EPUB is gone but version.json does not say so (or is gone too)", async () => {
    await expect(runOutsideCheck(urls, async (url) => (url.includes("book.epub") ? answer(404) : answer(200, { protected: false })))).resolves.toEqual({ kind: "not-protected", epub: "absent" });
    await expect(runOutsideCheck(urls, async () => answer(404))).resolves.toEqual({ kind: "not-protected", epub: "absent" });
  });

  it("gives up on a browser that cannot read the answer (CORS, a private site, no network) and on any status that proves nothing", async () => {
    await expect(runOutsideCheck(urls, async () => { throw new TypeError("Failed to fetch"); })).resolves.toEqual({ kind: "unreachable" });
    await expect(runOutsideCheck(urls, async () => answer(500))).resolves.toEqual({ kind: "unreachable" });
    await expect(runOutsideCheck(urls, async (url) => { if (url.includes("book.epub")) return answer(404); throw new TypeError("x"); })).resolves.toEqual({ kind: "unreachable" });
  });
});

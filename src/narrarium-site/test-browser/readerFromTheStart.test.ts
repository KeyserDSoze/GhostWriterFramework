import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAGES_WORKFLOW_PATH, commitFilesToBranch, createCompleteBookRepository, type BookRepositoryFile } from "@/github/bookRepository";
import { protectionFailureOf, protectionStep, retryProtectedReader, ReaderProtectionFailed } from "@/readerAccess/creation";
import { READER_PASSWORDS_VARIABLE, READER_WORKFLOW_PATH } from "@/readerAccess/contract";
import { READER_PASSWORDS_OVERRIDE, templateSupportsReaderPasswords, workflowSupportsReaderPasswords } from "@/readerAccess/capability";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { createFakeGitHub } from "./helpers/fakeGitHub";
import { createFakeReaderGitHub } from "./helpers/fakeReaderGitHub";
import type { Octokit } from "@octokit/rest";

vi.mock("@/readerAccess/sealedBox", () => ({ sealSecret: (value: string, key: string) => `sealed:${key.length}:${value.length}` }));

const PASSWORD = "Alpha-PASSWORD-canary-7731";
const WORKFLOW = `name: Deploy Reader To GitHub Pages\nenv:\n  PASSWORDS: \${{ vars.${READER_PASSWORDS_VARIABLE} }}\n`;
const files = (): BookRepositoryFile[] => [{ path: "README.md", content: "# The Glass Harbor\n" }, { path: "book.md", content: "---\ntype: book\n---\n" }, { path: PAGES_WORKFLOW_PATH, content: WORKFLOW }];
const save = vi.fn(async () => true);
const records = () => useSettingsStore.getState().settings.readerAccess?.["ada/book-glass-harbor"] ?? [];

function both() {
  const git = createFakeGitHub();
  const reader = createFakeReaderGitHub();
  const octokit = { rest: { ...git.octokit.rest, actions: reader.octokit.rest.actions }, request: reader.octokit.request } as unknown as Octokit;
  return { git, reader, octokit };
}

beforeEach(() => {
  save.mockClear();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
});

describe("what a workflow has to say before anything protective is offered", () => {
  it("is read from the workflow: one that names the variable of the passwords can honour them, one that does not cannot", () => {
    expect(READER_PASSWORDS_OVERRIDE).toBeNull();
    expect(workflowSupportsReaderPasswords(WORKFLOW)).toBe(true);
    expect(workflowSupportsReaderPasswords("name: Deploy\nenv:\n  P: ${{ secrets.NARRARIUM_READER_PASSWORD }}\n")).toBe(false);
    expect(workflowSupportsReaderPasswords(null)).toBe(false);
    expect(workflowSupportsReaderPasswords(undefined)).toBe(false);
  });

  it("can be forced for a release: off hides it whatever the workflow says, on offers it", () => {
    expect(workflowSupportsReaderPasswords(WORKFLOW, false)).toBe(false);
    expect(workflowSupportsReaderPasswords("old", true)).toBe(true);
  });

  it("is read from the template that new books are made from: the workflow file at the agreed path", () => {
    expect(templateSupportsReaderPasswords({ files: { [READER_WORKFLOW_PATH]: { text: WORKFLOW } } })).toBe(true);
    expect(templateSupportsReaderPasswords({ files: { [READER_WORKFLOW_PATH]: { text: "name: old\n" } } })).toBe(false);
    expect(templateSupportsReaderPasswords({ files: { "reader/.github/workflows/deploy-pages.yml": { text: WORKFLOW } } })).toBe(false);
    expect(templateSupportsReaderPasswords({ files: {} })).toBe(false);
  });

  it("answers for the template that ships with the site right now (a build with a reader that has no key slots offers nothing protective)", async () => {
    const { loadBookTemplate } = await import("@/narrarium/bookTemplate");
    expect(typeof templateSupportsReaderPasswords(await loadBookTemplate())).toBe("boolean");
  });
});

describe("the first password of a book made with a protected reader", () => {
  it("is kept, written as a secret and listed in the variable after the repository and Pages exist and BEFORE the workflow lands", async () => {
    const { git, reader, octokit } = both();
    const seen: { names: string[]; secrets: string[]; variable: string | null; records: string[] }[] = [];
    const step = protectionStep({ label: "First password", value: PASSWORD }, save);
    const result = await createCompleteBookRepository({
      token: "never-used", octokit, name: "book-glass-harbor", files: files(), pages: "enable", visibility: "private",
      beforeWorkflow: async (context) => {
        await step(context);
        seen.push({ names: git.names(), secrets: [...reader.secrets.keys()], variable: reader.variable.value, records: records().map((entry) => `${entry.secretName}:${entry.status}`) });
      },
    });

    expect(result).toMatchObject({ workflow: "done", pages: "enabled", beforeWorkflow: { status: "done" }, pendingWorkflow: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0].names).toContain("repos.createPagesSite");
    expect(seen[0].names.filter((name) => name === "git.createCommit")).toHaveLength(1);
    expect(seen[0].secrets).toEqual(["READER_PASSWORD_001"]);
    expect(seen[0].variable).toBe("READER_PASSWORD_001");
    expect(seen[0].records).toEqual(["READER_PASSWORD_001:active"]);
    expect(git.names().filter((name) => name === "git.createCommit")).toHaveLength(2);
    expect(git.filesAt("ada", "book-glass-harbor")!.has(PAGES_WORKFLOW_PATH)).toBe(true);
    expect(records()[0]).toMatchObject({ label: "First password", value: PASSWORD, secretName: "READER_PASSWORD_001", status: "active" });
    expect(reader.order()).toEqual(["createOrUpdateRepoSecret:READER_PASSWORD_001", "updateRepoVariable", "createRepoVariable"]);
    expect(JSON.stringify(reader.calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(git.calls)).not.toContain(PASSWORD);
  });

  it("keeps the workflow back when the secret cannot be written: nothing is published, the password is kept, and the repository has no workflow file", async () => {
    const { git, reader, octokit } = both();
    reader.fail("createOrUpdateRepoSecret", { status: 403, headers: { "x-accepted-github-permissions": "secrets=write" } });
    const progress: string[] = [];
    const result = await createCompleteBookRepository({ token: "never-used", octokit, name: "book-glass-harbor", files: files(), pages: "enable", beforeWorkflow: protectionStep({ label: "First password", value: PASSWORD }, save), onProgress: (step) => progress.push(step.step) });

    expect(result.workflow).toBe("held");
    expect(result.beforeWorkflow.status).toBe("failed");
    expect(result.pendingWorkflow.map((file) => file.path)).toEqual([PAGES_WORKFLOW_PATH]);
    expect(progress).toContain("protection");
    expect(git.names().filter((name) => name === "git.createCommit")).toHaveLength(1);
    expect(git.filesAt("ada", "book-glass-harbor")!.has(PAGES_WORKFLOW_PATH)).toBe(false);
    expect(reader.variable.value).toBeNull();
    expect(records().map((entry) => entry.status)).toEqual(["pending"]);
    const failure = protectionFailureOf((result.beforeWorkflow as { status: "failed"; error: unknown }).error);
    expect(failure).toEqual({ kind: "permission", status: 403, permissions: ["secrets"], fromHeader: true });
  });

  it("holds the workflow back when the variable cannot be written too, and when keeping the password fails", async () => {
    const first = both();
    first.reader.fail("createRepoVariable", { status: 403 });
    const held = await createCompleteBookRepository({ token: "x", octokit: first.octokit, name: "book-glass-harbor", files: files(), beforeWorkflow: protectionStep({ label: "p", value: PASSWORD }, save) });
    expect(held.workflow).toBe("held");
    expect(first.git.filesAt("ada", "book-glass-harbor")!.has(PAGES_WORKFLOW_PATH)).toBe(false);
    expect(first.reader.secrets.has("READER_PASSWORD_001")).toBe(true);

    const second = both();
    const broken = vi.fn(async () => { throw new Error("storage full"); });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    const heldAgain = await createCompleteBookRepository({ token: "x", octokit: second.octokit, name: "book-glass-harbor", files: files(), beforeWorkflow: protectionStep({ label: "p", value: PASSWORD }, broken) });
    expect(heldAgain.workflow).toBe("held");
    expect(second.reader.calls.filter((call) => call.method === "createOrUpdateRepoSecret")).toEqual([]);
  });

  it("is not run for a book with no workflow, and a public reader never runs it", async () => {
    const { git, reader, octokit } = both();
    const step = vi.fn(async () => undefined);
    const result = await createCompleteBookRepository({ token: "x", octokit, name: "book-glass-harbor", files: files().filter((file) => file.path !== PAGES_WORKFLOW_PATH), beforeWorkflow: step });
    expect(step).not.toHaveBeenCalled();
    expect(result.beforeWorkflow).toEqual({ status: "skipped" });
    const publicOne = both();
    const open = await createCompleteBookRepository({ token: "x", octokit: publicOne.octokit, name: "book-glass-harbor", files: files(), pages: "enable" });
    expect(open).toMatchObject({ workflow: "done", beforeWorkflow: { status: "skipped" } });
    expect(publicOne.reader.calls).toEqual([]);
    expect(git.names().length).toBeGreaterThan(0);
    expect(reader.calls).toEqual([]);
  });

  it("is finished by the retry: the same password is put in place, then the held workflow lands, and no second password is made", async () => {
    const { git, reader, octokit } = both();
    reader.fail("createOrUpdateRepoSecret", { status: 403 }, 1);
    let secretName: string | undefined;
    const result = await createCompleteBookRepository({ token: "x", octokit, name: "book-glass-harbor", files: files(), pages: "enable", beforeWorkflow: protectionStep({ label: "First password", value: PASSWORD }, save, (name) => { secretName = name; }) });
    expect(result.workflow).toBe("held");
    expect(secretName).toBe("READER_PASSWORD_001");

    const outcome = await retryProtectedReader({ octokit, owner: "ada", repo: "book-glass-harbor", branch: result.defaultBranch, password: { label: "First password", value: PASSWORD }, secretName, files: result.pendingWorkflow, save });

    expect(outcome).toEqual({ ok: true, secretName: "READER_PASSWORD_001" });
    expect(records().map((entry) => `${entry.secretName}:${entry.status}`)).toEqual(["READER_PASSWORD_001:active"]);
    expect(reader.variable.value).toBe("READER_PASSWORD_001");
    expect(git.filesAt("ada", "book-glass-harbor")!.has(PAGES_WORKFLOW_PATH)).toBe(true);
    // The secret was written before the workflow landed.
    expect(reader.order()[reader.order().length - 3]).toBe("createOrUpdateRepoSecret:READER_PASSWORD_001");
  });

  it("says which part stopped when the retry fails: the password on GitHub, or the workflow", async () => {
    const { git, reader, octokit } = both();
    reader.fail("createOrUpdateRepoSecret", { status: 403 });
    const result = await createCompleteBookRepository({ token: "x", octokit, name: "book-glass-harbor", files: files(), beforeWorkflow: protectionStep({ label: "p", value: PASSWORD }, save) });
    const stuck = await retryProtectedReader({ octokit, owner: "ada", repo: "book-glass-harbor", branch: "main", password: { label: "p", value: PASSWORD }, secretName: "READER_PASSWORD_001", files: result.pendingWorkflow, save });
    expect(stuck).toMatchObject({ ok: false, stage: "password", failure: { kind: "permission", permissions: ["secrets"] } });
    expect(git.filesAt("ada", "book-glass-harbor")!.has(PAGES_WORKFLOW_PATH)).toBe(false);

    reader.clearFailures();
    const refused = vi.spyOn(git.octokit.rest.git, "updateRef").mockRejectedValueOnce(Object.assign(new Error("refusing to allow an OAuth App to create or update workflow `.github/workflows/deploy-reader-pages.yml` without `workflow` scope"), { status: 404, response: { headers: {} } }));
    const noWorkflowPermission = await retryProtectedReader({ octokit, owner: "ada", repo: "book-glass-harbor", branch: "main", password: { label: "p", value: PASSWORD }, secretName: "READER_PASSWORD_001", files: result.pendingWorkflow, save });
    refused.mockRestore();
    expect(noWorkflowPermission).toMatchObject({ ok: false, stage: "workflow", failure: { kind: "permission", permissions: ["workflows"] } });
    expect(records()[0].status).toBe("active");
  });

  it("explains any failure of the step, and nothing of what was sent", () => {
    expect(protectionFailureOf(new Error("boom"))).toEqual({ kind: "other" });
    expect(protectionFailureOf(new ReaderProtectionFailed({ ok: false, done: [], failed: { step: "secret", failure: { kind: "network" } }, dispatched: false }))).toEqual({ kind: "network" });
    expect(new ReaderProtectionFailed({ ok: false, done: [], dispatched: false }).message).not.toContain(PASSWORD);
  });
});

describe("commitFilesToBranch", () => {
  it("adds one commit on top of the branch with the files, without force, and refuses a branch that moved", async () => {
    const git = createFakeGitHub();
    const created = await createCompleteBookRepository({ token: "x", octokit: git.octokit, name: "book-glass-harbor", files: files().filter((file) => file.path !== PAGES_WORKFLOW_PATH) });
    const before = git.count("git.createCommit");
    const { commitSha } = await commitFilesToBranch({ octokit: git.octokit, owner: "ada", repo: "book-glass-harbor", branch: created.defaultBranch, files: [{ path: PAGES_WORKFLOW_PATH, content: WORKFLOW }], message: "Add the GitHub Pages workflow" });
    expect(git.count("git.createCommit")).toBe(before + 1);
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(git.filesAt("ada", "book-glass-harbor")!.get(PAGES_WORKFLOW_PATH)).toBeTruthy();
    expect(git.filesAt("ada", "book-glass-harbor")!.has("README.md")).toBe(true);
    const update = git.calls.filter((call) => call.name === "git.updateRef").pop()!;
    expect(update.params).toMatchObject({ force: false });
  });
});

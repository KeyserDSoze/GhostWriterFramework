import { beforeEach, describe, expect, it } from "vitest";
import { addReaderPassword, disableReaderPages, enableReaderPages, removeReaderPassword, republishReader, resumeReaderPassword, type ReaderOperationDeps } from "@/readerAccess/operations";
import { ReaderFlowError } from "@/readerAccess/errors";
import { LEGACY_READER_SECRET } from "@/readerAccess/contract";
import type { ReaderPasswordRecord } from "@/types/settings";
import { FAKE_PUBLIC_KEY, createFakeReaderGitHub, type FakeReaderGitHub } from "./helpers/fakeReaderGitHub";

const PASSWORD = "Tr0ub4dor&3-plain-text-value";
const name = (number: number) => `READER_PASSWORD_${String(number).padStart(3, "0")}`;

let github: FakeReaderGitHub;
let stored: ReaderPasswordRecord[];
let kept: string[][];
let ids = 0;

function deps(): ReaderOperationDeps {
  return {
    octokit: github.octokit,
    repo: { owner: "me", repo: "book" },
    branch: "main",
    records: { get: () => stored, set: async (next) => { stored = next; kept.push(next.map((entry) => `${entry.secretName}:${entry.status}`)); } },
    seal: (value, key) => `sealed(${key}):${value.length}:${[...value].reverse().join("")}`,
    now: () => new Date("2026-11-25T10:00:00.000Z"),
    newId: () => `id-${++ids}`,
  };
}

beforeEach(() => { github = createFakeReaderGitHub(); stored = []; kept = []; ids = 0; });

describe("adding a password", () => {
  it("keeps it, writes the secret, lists it in the variable, then starts the workflow, in that order", async () => {
    const result = await addReaderPassword(deps(), { label: "Beta readers", value: PASSWORD });

    expect(result).toEqual({ ok: true, done: ["check", "save", "secret", "variable", "save", "dispatch"], dispatched: true, secretName: name(1) });
    // The package updates the variable first and creates it when GitHub says it is not there.
    expect(github.order()).toEqual([`createOrUpdateRepoSecret:${name(1)}`, "updateRepoVariable", "createRepoVariable", "createWorkflowDispatch"]);
    expect(kept).toEqual([[`${name(1)}:pending`], [`${name(1)}:active`]]);
    expect(stored).toEqual([{ id: "id-1", label: "Beta readers", value: PASSWORD, createdAt: "2026-11-25T10:00:00.000Z", secretName: name(1), status: "active" }]);
    expect(github.variable.value).toBe(name(1));
    expect(github.secrets.has(name(1))).toBe(true);
    expect(github.calls.find((call) => call.method === "createWorkflowDispatch")?.args).toMatchObject({ workflow_id: "deploy-reader-pages.yml", ref: "main" });
  });

  it("sends only the sealed value: the plain password is in no request to GitHub", async () => {
    await addReaderPassword(deps(), { label: "x", value: PASSWORD });
    const sent = JSON.stringify(github.calls);
    expect(sent).not.toContain(PASSWORD);
    expect(github.secrets.get(name(1))).toContain(`sealed(${FAKE_PUBLIC_KEY})`);
    expect(github.calls.find((call) => call.method === "createOrUpdateRepoSecret")?.args).toMatchObject({ key_id: "key-1" });
  });

  it("picks a name nothing holds: past the listed, the existing secrets and the kept ones", async () => {
    github.variable.value = name(1);
    github.secrets.set(name(2), "x");
    stored = [{ id: "k", label: "k", value: "kept-value", createdAt: "", secretName: name(3), status: "pending" }];
    const result = await addReaderPassword(deps(), { label: "x", value: PASSWORD });
    expect(result.secretName).toBe(name(4));
    expect(github.variable.value).toBe(`${name(1)},${name(4)}`);
  });

  it("never reuses a number: the new password goes one past the highest that is listed or has a secret", async () => {
    github.variable.value = `${name(1)},${name(3)}`;
    github.secrets.set(name(1), "x");
    github.secrets.set(name(3), "x");
    const result = await addReaderPassword(deps(), { label: "x", value: PASSWORD });
    expect(result.secretName).toBe(name(4));
    expect(github.variable.value).toBe(`${name(1)},${name(3)},${name(4)}`);
  });

  it("updates the variable that exists instead of creating it", async () => {
    github.variable.value = name(1);
    github.secrets.set(name(1), "x");
    await addReaderPassword(deps(), { label: "x", value: PASSWORD });
    expect(github.order()).toEqual([`createOrUpdateRepoSecret:${name(2)}`, "updateRepoVariable", "createWorkflowDispatch"]);
  });

  it("stops before keeping anything when it cannot tell what exists (no permission to read the secrets)", async () => {
    github.fail("listRepoSecrets", { status: 403 });
    const result = await addReaderPassword(deps(), { label: "x", value: PASSWORD });
    expect(result).toMatchObject({ ok: false, done: [], failed: { step: "check", failure: { kind: "permission", permissions: ["secrets"] } }, dispatched: false });
    expect(stored).toEqual([]);
    expect(github.order()).toEqual([]);
  });

  it("when the secret cannot be written: the password is kept as pending, nothing published changed, and a retry finishes it", async () => {
    github.fail("createOrUpdateRepoSecret", { status: 403, headers: { "x-accepted-github-permissions": "secrets=write" } }, 1);
    const failed = await addReaderPassword(deps(), { label: "x", value: PASSWORD });
    expect(failed).toMatchObject({ ok: false, done: ["check", "save"], failed: { step: "secret", failure: { kind: "permission", permissions: ["secrets"], fromHeader: true } }, dispatched: false, secretName: name(1) });
    expect(stored.map((entry) => entry.status)).toEqual(["pending"]);
    expect(github.variable.value).toBeNull();
    expect(github.runs).toHaveLength(0);

    const retried = await resumeReaderPassword(deps(), name(1));
    expect(retried).toMatchObject({ ok: true, dispatched: true });
    expect(stored.map((entry) => entry.status)).toEqual(["active"]);
    expect(github.variable.value).toBe(name(1));
    expect(stored).toHaveLength(1);
  });

  it("when the variable cannot be written: the secret is there but unlisted, so the published site is unchanged; a retry lists it", async () => {
    github.fail("createRepoVariable", { status: 403 }, 1);
    const failed = await addReaderPassword(deps(), { label: "x", value: PASSWORD });
    expect(failed).toMatchObject({ ok: false, failed: { step: "variable", failure: { kind: "permission", permissions: ["actions_variables"] } }, dispatched: false });
    expect(github.secrets.has(name(1))).toBe(true);
    expect(github.variable.value).toBeNull();
    expect(github.order()).not.toContain("createWorkflowDispatch");
    expect((await resumeReaderPassword(deps(), name(1))).ok).toBe(true);
    expect(github.variable.value).toBe(name(1));
  });

  it("when the workflow cannot be started: everything else is done and it says so; starting again publishes", async () => {
    github.fail("createWorkflowDispatch", { status: 422, message: "Workflow does not have 'workflow_dispatch' trigger" }, 1);
    const failed = await addReaderPassword(deps(), { label: "x", value: PASSWORD });
    expect(failed).toMatchObject({ ok: false, done: ["check", "save", "secret", "variable", "save"], failed: { step: "dispatch", failure: { kind: "no-dispatch" } }, dispatched: false });
    expect(stored.map((entry) => entry.status)).toEqual(["active"]);
    expect(github.variable.value).toBe(name(1));
    expect(await republishReader(deps())).toMatchObject({ ok: true, dispatched: true });
  });

  it("when keeping the password fails, nothing is sent to GitHub at all", async () => {
    const broken = deps();
    broken.records.set = async () => { throw new Error("storage full"); };
    const result = await addReaderPassword(broken, { label: "x", value: PASSWORD });
    expect(result).toMatchObject({ ok: false, failed: { step: "save", failure: { kind: "other" } } });
    expect(github.calls.filter((call) => call.method === "createOrUpdateRepoSecret")).toEqual([]);
  });

  it("never lets a password into a result or an error", async () => {
    github.fail("createOrUpdateRepoSecret", { status: 500, message: `boom ${PASSWORD}` });
    const result = await addReaderPassword(deps(), { label: "x", value: PASSWORD });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(new ReaderFlowError("secret-write", { kind: "other", status: 500 }).message).not.toContain(PASSWORD);
  });
});

describe("removing a password", () => {
  beforeEach(() => {
    github.variable.value = `${name(1)},${name(2)}`;
    github.secrets.set(name(1), "x");
    github.secrets.set(name(2), "x");
    stored = [1, 2].map((number) => ({ id: `r${number}`, label: `R${number}`, value: `value-${number}-xxxxxx`, createdAt: "", secretName: name(number), status: "active" as const }));
  });

  it("takes it off the variable first, then deletes the secret, forgets it, and starts the workflow", async () => {
    const result = await removeReaderPassword(deps(), name(1));
    expect(result).toEqual({ ok: true, done: ["save", "variable", "secret-delete", "forget", "dispatch"], dispatched: true, secretName: name(1) });
    expect(github.order()).toEqual(["updateRepoVariable", `deleteRepoSecret:${name(1)}`, "createWorkflowDispatch"]);
    expect(github.variable.value).toBe(name(2));
    expect(github.secrets.has(name(1))).toBe(false);
    expect(stored.map((entry) => entry.secretName)).toEqual([name(2)]);
    expect(kept[0]).toEqual([`${name(1)}:removing`, `${name(2)}:active`]);
  });

  it("deletes the variable when the last password goes (a variable with no value is not relied on)", async () => {
    await removeReaderPassword(deps(), name(1));
    await removeReaderPassword(deps(), name(2));
    expect(github.variable.value).toBeNull();
    expect(github.order().filter((call) => call.startsWith("deleteRepoVariable"))).toEqual(["deleteRepoVariable"]);
    expect(stored).toEqual([]);
  });

  it("when the secret cannot be deleted, the variable has already stopped listing it, the record stays as being removed, and a retry finishes", async () => {
    github.fail("deleteRepoSecret", { status: 403 }, 1);
    const failed = await removeReaderPassword(deps(), name(1));
    expect(failed).toMatchObject({ ok: false, failed: { step: "secret-delete", failure: { kind: "permission", permissions: ["secrets"] } }, dispatched: false });
    expect(github.variable.value).toBe(name(2));
    expect(stored.find((entry) => entry.secretName === name(1))?.status).toBe("removing");
    expect(github.runs).toHaveLength(0);
    expect((await removeReaderPassword(deps(), name(1))).ok).toBe(true);
    expect(github.secrets.has(name(1))).toBe(false);
    expect(stored.map((entry) => entry.secretName)).toEqual([name(2)]);
  });

  it("when the variable cannot be written, the secret is not deleted", async () => {
    github.fail("updateRepoVariable", { status: 403 }, 1);
    const failed = await removeReaderPassword(deps(), name(1));
    expect(failed).toMatchObject({ ok: false, failed: { step: "variable" } });
    expect(github.secrets.has(name(1))).toBe(true);
    expect(github.order()).not.toContain(`deleteRepoSecret:${name(1)}`);
  });

  it("removes a password that exists on GitHub with no value kept here", async () => {
    stored = [];
    const result = await removeReaderPassword(deps(), name(2));
    expect(result.ok).toBe(true);
    expect(github.variable.value).toBe(name(1));
    expect(github.secrets.has(name(2))).toBe(false);
  });

  it("takes a dangling name off the list, and finds a secret that is already gone fine", async () => {
    github.secrets.delete(name(2));
    expect((await removeReaderPassword(deps(), name(2))).ok).toBe(true);
    expect(github.variable.value).toBe(name(1));
  });

  it("removes the older single secret: there is no variable to change, and it is deleted before the workflow runs", async () => {
    github.secrets.set(LEGACY_READER_SECRET, "x");
    const result = await removeReaderPassword(deps(), LEGACY_READER_SECRET);
    expect(result).toMatchObject({ ok: true, done: ["secret-delete", "dispatch"] });
    expect(github.order()).toEqual([`deleteRepoSecret:${LEGACY_READER_SECRET}`, "createWorkflowDispatch"]);
    expect(github.variable.value).toBe(`${name(1)},${name(2)}`);
  });

  it("refuses a name that is not a reader secret, so that no other secret can be deleted from here", async () => {
    github.secrets.set("NPM_TOKEN", "x");
    const result = await removeReaderPassword(deps(), "NPM_TOKEN");
    expect(result.ok).toBe(false);
    expect(github.secrets.has("NPM_TOKEN")).toBe(true);
    expect(github.order()).toEqual([]);
  });
});

describe("Pages", () => {
  it("turns on for an existing book and publishes at once when the repository has the workflow", async () => {
    const result = await enableReaderPages(deps());
    expect(result).toMatchObject({ ok: true, done: ["pages", "dispatch"], dispatched: true });
    expect(github.pages.enabled).toBe(true);
    expect(github.order()).toEqual(["createPagesSite", "createWorkflowDispatch"]);
  });

  it("turns on without publishing when the repository has no workflow, and when Pages is already on", async () => {
    github.workflowPresent.value = false;
    expect(await enableReaderPages(deps())).toMatchObject({ ok: true, done: ["pages"], dispatched: false });
    expect((await enableReaderPages(deps())).ok).toBe(true);
  });

  it("says when the plan has no Pages, and does not start a workflow", async () => {
    github.pages.plan = true;
    const result = await enableReaderPages(deps());
    expect(result).toMatchObject({ ok: false, failed: { step: "pages", failure: { kind: "plan" } }, dispatched: false });
    expect(github.runs).toHaveLength(0);
  });

  describe("turned off", () => {
    beforeEach(() => {
      github.pages.enabled = true;
      github.variable.value = `${name(1)},${name(2)}`;
      github.secrets.set(name(1), "x");
      github.secrets.set(name(2), "x");
      github.secrets.set(LEGACY_READER_SECRET, "x");
      github.secrets.set("NPM_TOKEN", "x");
      stored = [{ id: "r1", label: "R1", value: "value-1-xxxxxx", createdAt: "", secretName: name(1), status: "active" }];
    });

    it("keeps the workflow, the secrets, the variable and the stored passwords by default", async () => {
      const result = await disableReaderPages(deps(), { deleteSecrets: false, forgetStored: false });
      expect(result).toMatchObject({ ok: true, done: ["pages"] });
      expect(github.pages.enabled).toBe(false);
      // The package pauses the workflow first, so that a push does not build a site that is not there.
      expect(github.order()).toEqual(["disableWorkflow", "deletePagesSite"]);
      expect(github.variable.value).toBe(`${name(1)},${name(2)}`);
      expect([...github.secrets.keys()].sort()).toEqual([LEGACY_READER_SECRET, "NPM_TOKEN", name(1), name(2)].sort());
      expect(stored).toHaveLength(1);
    });

    it("on request also deletes the variable first, then the password secrets (and no other secret), but still keeps the stored passwords", async () => {
      const result = await disableReaderPages(deps(), { deleteSecrets: true, forgetStored: false });
      expect(result.ok).toBe(true);
      expect(github.order().slice(0, 3)).toEqual(["disableWorkflow", "deletePagesSite", "deleteRepoVariable"]);
      expect(github.order().filter((call) => call.startsWith("deleteRepoSecret")).sort()).toEqual([`deleteRepoSecret:${LEGACY_READER_SECRET}`, `deleteRepoSecret:${name(1)}`, `deleteRepoSecret:${name(2)}`].sort());
      expect(github.variable.value).toBeNull();
      expect([...github.secrets.keys()]).toEqual(["NPM_TOKEN"]);
      expect(stored).toHaveLength(1);
    });

    it("forgets the stored passwords only when that was confirmed as well", async () => {
      await disableReaderPages(deps(), { deleteSecrets: true, forgetStored: true });
      expect(stored).toEqual([]);
      stored = [{ id: "r1", label: "R1", value: "value-1-xxxxxx", createdAt: "", secretName: name(1), status: "active" }];
      await disableReaderPages(deps(), { deleteSecrets: false, forgetStored: true });
      expect(stored).toHaveLength(1);
    });

    it("never starts the workflow", async () => {
      await disableReaderPages(deps(), { deleteSecrets: true, forgetStored: true });
      expect(github.order()).not.toContain("createWorkflowDispatch");
    });

    it("stops at once when Pages cannot be turned off, touching nothing else", async () => {
      github.fail("deletePagesSite", { status: 403 });
      const result = await disableReaderPages(deps(), { deleteSecrets: true, forgetStored: true });
      expect(result).toMatchObject({ ok: false, failed: { step: "pages", failure: { kind: "permission", permissions: ["pages"] } } });
      expect(github.variable.value).not.toBeNull();
      expect(stored).toHaveLength(1);
    });

    it("says where the cleanup stopped, and keeps the stored passwords then", async () => {
      github.fail("deleteRepoSecret", { status: 403 });
      const result = await disableReaderPages(deps(), { deleteSecrets: true, forgetStored: true });
      expect(result).toMatchObject({ ok: false, done: ["pages"], failed: { step: "secret-delete" } });
      expect(stored).toHaveLength(1);
    });
  });
});

describe("passwords prepared for a workflow that does not read them", () => {
  const prepared = (): ReaderOperationDeps => ({ ...deps(), dispatchOnChange: false });

  it("writes the secret and lists it in the variable, as for any other workflow, but starts nothing: an old workflow would only publish the same public reader", async () => {
    const result = await addReaderPassword(prepared(), { label: "Beta readers", value: PASSWORD });
    expect(result).toEqual({ ok: true, done: ["check", "save", "secret", "variable", "save"], dispatched: false, deferred: true, secretName: name(1) });
    expect(github.order()).toEqual([`createOrUpdateRepoSecret:${name(1)}`, "updateRepoVariable", "createRepoVariable"]);
    expect(github.secrets.has(name(1))).toBe(true);
    expect(github.variable.value).toBe(name(1));
    expect(stored).toEqual([expect.objectContaining({ secretName: name(1), status: "active" })]);
  });

  it("is harmless for a workflow that never names them: the old workflow of the reader package reads neither the variable nor any secret", async () => {
    const { default: v1 } = await import("./fixtures/pagesWorkflowV1.yml?raw");
    expect(v1).not.toMatch(/secrets\./);
    expect(v1).not.toMatch(/vars\./);
    expect(v1).not.toContain("READER_PASSWORD");
    // Only the workflow that names the list receives the secrets: «toJSON(secrets)» is in the current one, not in the old one.
    expect(v1).not.toContain("toJSON(secrets)");
  });

  it("removes a password the same way: nothing is started, and the published reader is left as it is", async () => {
    await addReaderPassword(prepared(), { label: "x", value: PASSWORD });
    github.calls.length = 0;
    const result = await removeReaderPassword(prepared(), name(1));
    expect(result).toMatchObject({ ok: true, dispatched: false, deferred: true });
    expect(github.calls.some((call) => call.method === "createWorkflowDispatch")).toBe(false);
    expect(github.secrets.has(name(1))).toBe(false);
  });

  it("starts the workflow for «Publish again» and for turning Pages on whatever the workflow reads: the person asked for exactly that", async () => {
    expect(await republishReader(prepared())).toMatchObject({ ok: true, dispatched: true });
    expect(github.calls.filter((call) => call.method === "createWorkflowDispatch")).toHaveLength(1);
  });

  it("starts the workflow for a change when the workflow reads the passwords (the default)", async () => {
    expect(await addReaderPassword({ ...deps(), dispatchOnChange: true }, { label: "x", value: PASSWORD })).toMatchObject({ dispatched: true });
  });
});

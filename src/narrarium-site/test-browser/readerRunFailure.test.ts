import { describe, expect, it } from "vitest";
import { readRunFailure } from "@/readerAccess/api";
import { actionsSettingsUrl, billingUrl, classifyRunFailure } from "@/readerAccess/runFailure";
import { createFakeReaderGitHub } from "./helpers/fakeReaderGitHub";

const job = (annotations: string[], steps = 0, id = 1) => ({ id, name: "build", conclusion: "failure", steps, annotations });
const read = (annotations: string[], steps = 0, unreadable = false) => ({ runId: 7, jobs: [job(annotations, steps)], annotationsUnreadable: unreadable });

describe("the cause of a failed publication, from the annotation of its job", () => {
  it("names the Actions budget, as the owner's book showed it (a job with no steps)", () => {
    expect(classifyRunFailure(read(["The job was not started because an Actions budget is preventing further use."]))).toEqual({
      runId: 7, cause: "budget", message: "The job was not started because an Actions budget is preventing further use.", neverStarted: true,
    });
  });

  it.each([
    "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings",
    "You have exceeded the usage limit of your plan",
    "Your account has no remaining minutes",
  ])("names billing for GitHub's other words for it: %s", (message) => {
    expect(classifyRunFailure(read([message])).cause).toBe("budget");
  });

  it("names disabled Actions and a missing permission", () => {
    expect(classifyRunFailure(read(["GitHub Actions is disabled for this repository."]))).toMatchObject({ cause: "actions-disabled", neverStarted: true });
    expect(classifyRunFailure(read(["Resource not accessible by integration"], 3))).toMatchObject({ cause: "permission", neverStarted: false });
  });

  it("shows GitHub's own message for any other failure, preferring it to the exit code line", () => {
    expect(classifyRunFailure(read(["Process completed with exit code 1.", "Error: the reader did not encrypt the book"], 4))).toMatchObject({ cause: "other", message: "Error: the reader did not encrypt the book", neverStarted: false });
    expect(classifyRunFailure(read(["Process completed with exit code 1."], 4))).toMatchObject({ cause: "other", message: "Process completed with exit code 1." });
  });

  it("says it could not read the reason when the annotations were unreadable or empty, and never guesses", () => {
    expect(classifyRunFailure(read([], 0, true))).toMatchObject({ cause: "unreadable", neverStarted: true });
    expect(classifyRunFailure(read([], 2, false))).toMatchObject({ cause: "unreadable" });
  });

  it("trims a long message", () => {
    const info = classifyRunFailure(read([`an Actions budget is preventing further use ${"x".repeat(900)}`]));
    expect(info.message!.length).toBe(300);
  });

  it("points at the billing of the account that owns the repository: a user's, or the organization's", () => {
    expect(billingUrl({ login: "keyser", type: "User" })).toBe("https://github.com/settings/billing");
    expect(billingUrl({ login: "acme corp", type: "Organization" })).toBe("https://github.com/organizations/acme%20corp/settings/billing");
    expect(actionsSettingsUrl("keyser", "jesus")).toBe("https://github.com/keyser/jesus/settings/actions");
  });
});

describe("reading a failed run", () => {
  it("lists the jobs that did not succeed and the annotations of each", async () => {
    const github = createFakeReaderGitHub();
    github.jobs.push({ id: 11, name: "build", conclusion: "failure", steps: [] }, { id: 12, name: "deploy", conclusion: "skipped", steps: [] });
    github.annotations[11] = [{ message: "The job was not started because an Actions budget is preventing further use." }];
    const result = await readRunFailure(github.octokit, { owner: "me", repo: "book" }, 5);
    expect(result).toEqual({ runId: 5, annotationsUnreadable: false, jobs: [{ id: 11, name: "build", conclusion: "failure", steps: 0, annotations: ["The job was not started because an Actions budget is preventing further use."] }] });
    expect(github.calls.map((call) => call.method)).toEqual(["listJobsForWorkflowRun", "listAnnotations"]);
  });

  it("reports the run even when the annotations cannot be read (no Checks permission)", async () => {
    const github = createFakeReaderGitHub();
    github.jobs.push({ id: 11, name: "build", conclusion: "failure", steps: [] });
    github.fail("listAnnotations", { status: 403 });
    const result = await readRunFailure(github.octokit, { owner: "me", repo: "book" }, 5);
    expect(result).toMatchObject({ annotationsUnreadable: true, jobs: [{ id: 11, annotations: [] }] });
    expect(classifyRunFailure(result).cause).toBe("unreadable");
  });
});

import { describe, expect, it } from "vitest";
import { ReaderFlowError, acceptedPermissions, classifyReaderFailure, permissionLabel, type ReaderStep } from "@/readerAccess/errors";

const failure = (status: number | undefined, headers: Record<string, string> = {}, message = "") => Object.assign(new Error(message), status === undefined ? {} : { status }, { response: { headers } });

describe("the permission GitHub says is missing", () => {
  it("is read from X-Accepted-GitHub-Permissions when it is sent", () => {
    expect(acceptedPermissions("secrets=write")).toEqual(["secrets"]);
    expect(acceptedPermissions("actions=write; contents=write")).toEqual(["actions", "contents"]);
    expect(acceptedPermissions("actions_variables=write, secrets=read")).toEqual(["actions_variables", "secrets"]);
    expect(acceptedPermissions("")).toEqual([]);
    expect(acceptedPermissions(undefined)).toEqual([]);
    expect(acceptedPermissions("<script>=write")).toEqual([]);
    expect(classifyReaderFailure(failure(403, { "x-accepted-github-permissions": "pages=write" }), "pages-enable")).toEqual({ kind: "permission", status: 403, permissions: ["pages"], fromHeader: true });
  });

  it("is what the call is documented to need when the header is not there, for every step", () => {
    const expected: Record<ReaderStep, string[]> = {
      repository: ["metadata"], "public-key": ["secrets"], "secret-write": ["secrets"], "secret-delete": ["secrets"], "secrets-list": ["secrets"],
      "variable-read": ["actions_variables"], "variable-write": ["actions_variables"], "variable-delete": ["actions_variables"], dispatch: ["actions"], runs: ["actions"],
      "workflow-read": ["contents"], "pages-read": ["pages"], "pages-enable": ["pages"], "pages-disable": ["pages"],
    };
    for (const [step, permissions] of Object.entries(expected) as Array<[ReaderStep, string[]]>) {
      expect(classifyReaderFailure(failure(403), step)).toEqual({ kind: "permission", status: 403, permissions, fromHeader: false });
    }
  });

  it("has a name in the screens where the owner grants it", () => {
    expect(permissionLabel("secrets")).toBe("Secrets");
    expect(permissionLabel("actions_variables")).toBe("Variables");
    expect(permissionLabel("actions")).toBe("Actions");
    expect(permissionLabel("pages")).toBe("Pages");
    expect(permissionLabel("contents")).toBe("Contents");
    expect(permissionLabel("workflows")).toBe("Workflows");
    expect(permissionLabel("something_new")).toBe("something_new");
  });
});

describe("the other ways a call fails", () => {
  it("a limit is not a missing permission", () => {
    expect(classifyReaderFailure(failure(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795000000" }), "secret-write")).toMatchObject({ kind: "rate-limit", resetAt: new Date(1795000000 * 1000).toISOString() });
    expect(classifyReaderFailure(failure(429), "dispatch")).toEqual({ kind: "rate-limit", status: 429 });
    expect(classifyReaderFailure(failure(403, {}, "You have exceeded a secondary rate limit"), "dispatch").kind).toBe("rate-limit");
  });

  it("single sign-on, a refused sign-in, and a missing thing", () => {
    expect(classifyReaderFailure(failure(403, { "x-github-sso": "required; url=https://github.com/orgs/x/sso" }), "secrets-list").kind).toBe("sso");
    expect(classifyReaderFailure(failure(401), "repository")).toEqual({ kind: "credential", status: 401 });
    expect(classifyReaderFailure(failure(404), "secret-write")).toEqual({ kind: "not-found", status: 404, permissions: ["secrets"] });
  });

  it("a workflow that cannot be started by hand, a plan without Pages, and a conflict", () => {
    expect(classifyReaderFailure(failure(422, {}, "Workflow does not have 'workflow_dispatch' trigger"), "dispatch")).toEqual({ kind: "no-dispatch", status: 422 });
    expect(classifyReaderFailure(failure(422, {}, "Your current plan does not support GitHub Pages for this repository."), "pages-enable")).toEqual({ kind: "plan", status: 422 });
    expect(classifyReaderFailure(failure(403, {}, "Pages is not available on your plan, upgrade"), "pages-enable")).toEqual({ kind: "plan", status: 403 });
    expect(classifyReaderFailure(failure(409), "pages-enable")).toEqual({ kind: "conflict", status: 409 });
    expect(classifyReaderFailure(failure(500), "dispatch")).toEqual({ kind: "other", status: 500 });
  });

  it("no answer at all is the network", () => {
    expect(classifyReaderFailure(new TypeError("Failed to fetch"), "secret-write")).toEqual({ kind: "network" });
    expect(classifyReaderFailure(failure(undefined, {}, "boom"), "secret-write")).toEqual({ kind: "other" });
    expect(classifyReaderFailure(undefined, "secret-write")).toEqual({ kind: "other" });
  });

  it("a failure keeps nothing of what GitHub said or what was sent", () => {
    const secretText = "hunter2-PASSWORD-VALUE";
    const error = new ReaderFlowError("secret-write", classifyReaderFailure(failure(403, { "x-accepted-github-permissions": "secrets=write" }, `request body ${secretText} was refused`), "secret-write"));
    expect(error.message).toBe("Reader access: secret-write failed (permission 403).");
    expect(JSON.stringify(error.failure)).not.toContain(secretText);
  });
});

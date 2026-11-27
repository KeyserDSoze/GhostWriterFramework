import { describe, expect, it } from "vitest";
import { classifyRepositoryError } from "@/repository/repositoryError";

// A push that carries a file of .github/workflows is refused by GitHub, with a 403, 404 or 422 that names the workflow, when the credential has no Workflows
// permission: it used to read as «conflict» or «permission unverified», which says nothing the person can act on.
describe("a refusal to change a workflow file", () => {
  const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });

  it.each([
    [404, "refusing to allow a GitHub App to create or update workflow `.github/workflows/deploy-reader-pages.yml` without `workflows` permission"],
    [403, "refusing to allow an OAuth App to create or update workflow `.github/workflows/deploy-reader-pages.yml` without `workflow` scope"],
    [422, "Resource not accessible: refusing to update workflow without the workflows permission"],
  ])("is told as a missing Workflows permission (%i)", (status, message) => {
    expect(classifyRepositoryError(refusal(status, message), "update").kind).toBe("workflow-permission");
  });

  it("does not take other refusals for it", () => {
    expect(classifyRepositoryError(refusal(404, "Not Found"), "update").kind).toBe("conflict");
    expect(classifyRepositoryError(refusal(403, "Resource not accessible by integration"), "update").kind).toBe("permission");
    expect(classifyRepositoryError(refusal(422, "Update is not a fast forward"), "update").kind).toBe("conflict");
    expect(classifyRepositoryError(refusal(401, "workflow permission"), "update").kind).toBe("credential-invalid");
  });
});

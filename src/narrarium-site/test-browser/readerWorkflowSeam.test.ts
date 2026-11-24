import { describe, expect, it } from "vitest";
import { inspectReaderWorkflow, updateReaderWorkflow } from "@/readerAccess/workflowSeam";

describe("the seam for the reader workflow's own package", () => {
  it("tells a missing workflow, one that reads the passwords, and one that does not, and claims nothing else about a file", () => {
    expect(inspectReaderWorkflow(null)).toBe("missing");
    expect(inspectReaderWorkflow("env:\n  P: ${{ vars.READER_PASSWORD_SECRETS }}\n")).toBe("current");
    expect(inspectReaderWorkflow("name: Deploy reader\nenv:\n  P: ${{ secrets.NARRARIUM_READER_PASSWORD }}\n")).toBe("outdated");
    expect(inspectReaderWorkflow("")).toBe("outdated");
  });

  it("has no updater until the package exports one, so that no workflow text is invented here", () => {
    expect(updateReaderWorkflow).toBeNull();
  });
});

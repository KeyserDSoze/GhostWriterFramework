import { describe, expect, it } from "vitest";
import { inspectReaderWorkflow, updateReaderWorkflow } from "@/readerAccess/workflowSeam";

describe("the seam for the reader workflow's own package", () => {
  it("tells a missing workflow, and claims nothing else about a file it cannot recognise", () => {
    expect(inspectReaderWorkflow(null)).toBe("missing");
    expect(inspectReaderWorkflow("name: Deploy reader\n")).toBe("unknown");
    expect(inspectReaderWorkflow("")).toBe("unknown");
  });

  it("has no updater until the package exports one, so that no workflow text is invented here", () => {
    expect(updateReaderWorkflow).toBeNull();
  });
});

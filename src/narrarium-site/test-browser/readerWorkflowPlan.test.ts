import { describe, expect, it } from "vitest";
import { planPagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";
import { inspectReaderWorkflow, planReaderWorkflow } from "@/readerAccess/workflowPlan";
import v1 from "./fixtures/pagesWorkflowV1.yml?raw";

const withLegacyPassword = v1.replace("          SITE_BASE:", "          NARRARIUM_READER_PASSWORD: ${{ secrets.BOOK_PASSWORD }}\n          SITE_BASE:");
const current = planPagesWorkflowUpgrade(v1).text;

describe("what the reader package says of a repository's workflow", () => {
  it("tells a missing workflow, the current one, the one written before the key slots and an edited one", () => {
    expect(inspectReaderWorkflow(null)).toBe("missing");
    expect(inspectReaderWorkflow(current)).toBe("current");
    expect(inspectReaderWorkflow(v1)).toBe("outdated");
    expect(inspectReaderWorkflow(`${current}\n  extra:\n    runs-on: ubuntu-latest\n`)).toBe("customized");
    expect(inspectReaderWorkflow(`${v1}\n  extra:\n    runs-on: ubuntu-latest\n`)).toBe("outdated");
  });

  it("is the package's own plan: the text to commit comes from it, never from this site", () => {
    const plan = planReaderWorkflow(v1);
    expect(plan.status).toBe("generated");
    expect(plan.safe).toBe(true);
    expect(plan.text).toBe(planPagesWorkflowUpgrade(v1).text);
    expect(plan.text).toContain("READER_PASSWORD_SECRETS");
  });

  it("keeps the older single password as one slot", () => {
    const plan = planReaderWorkflow(withLegacyPassword);
    expect(plan.status).toBe("generated");
    expect(plan.settings.legacyPasswordSecret).toBe("BOOK_PASSWORD");
    expect(plan.text).toContain("NARRARIUM_READER_PASSWORD: ${{ secrets.BOOK_PASSWORD }}");
  });
});

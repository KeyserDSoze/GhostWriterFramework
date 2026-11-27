import { describe, expect, it } from "vitest";
import { readerPublication, rowActivation, workflowPublishesPasswords, type PublicationEvidence } from "@/readerRun/publication";
import { LEGACY_READER_SECRET } from "@/readerAccess/contract";
import { planPagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";
import v1 from "./fixtures/pagesWorkflowV1.yml?raw";

const withPasswords = { secrets: ["READER_PASSWORD_001"], listed: ["READER_PASSWORD_001"] };
const evidence = (patch: Partial<PublicationEvidence> = {}): PublicationEvidence => ({ remote: withPasswords, builtReadsPasswords: true, publishing: false, outside: null, ...patch });

describe("whether the published reader asks for a password", () => {
  it("is protecting only when the workflow that built the published reader reads the passwords, or the outside check says so", () => {
    expect(readerPublication(evidence())).toBe("protecting");
    expect(readerPublication(evidence({ builtReadsPasswords: false }))).toBe("prepared");
    expect(readerPublication(evidence({ builtReadsPasswords: false, outside: { kind: "protected" } }))).toBe("protecting");
  });

  it("never says protecting against the outside check: a public answer wins over what the workflow says", () => {
    expect(readerPublication(evidence({ outside: { kind: "epub-exposed", status: 200 } }))).toBe("prepared");
    expect(readerPublication(evidence({ outside: { kind: "not-protected", epub: "absent" } }))).toBe("prepared");
    // The browser could not read the answer: it says nothing, and the workflow's evidence stands.
    expect(readerPublication(evidence({ outside: { kind: "unreachable" } }))).toBe("protecting");
  });

  it("claims nothing while a publication is going, nor when the evidence or GitHub could not be read, and is public without passwords", () => {
    expect(readerPublication(evidence({ publishing: true }))).toBe("publishing");
    expect(readerPublication(evidence({ builtReadsPasswords: null }))).toBe("unknown");
    expect(readerPublication(evidence({ remote: { secrets: null, listed: null } }))).toBe("unknown");
    expect(readerPublication(evidence({ remote: { secrets: [], listed: [] } }))).toBe("public");
    // A listed name with no secret behind it is no password.
    expect(readerPublication(evidence({ remote: { secrets: [], listed: ["READER_PASSWORD_001"] } }))).toBe("public");
    // The outside check can still show the passwords active while a later publication goes on.
    expect(readerPublication(evidence({ publishing: true, outside: { kind: "protected" } }))).toBe("protecting");
  });

  it("counts the older single secret as a password, as the older workflow reads it", () => {
    expect(readerPublication(evidence({ remote: { secrets: [LEGACY_READER_SECRET], listed: [] } }))).toBe("protecting");
    expect(readerPublication(evidence({ remote: { secrets: [LEGACY_READER_SECRET], listed: [] }, builtReadsPasswords: false }))).toBe("prepared");
  });
});

describe("whether a workflow reads the passwords", () => {
  it("does for the current workflow and for the older one that names the single secret, and does not for the first one or none", () => {
    expect(workflowPublishesPasswords(planPagesWorkflowUpgrade(v1).text)).toBe(true);
    expect(workflowPublishesPasswords(v1.replace("          SITE_BASE:", "          NARRARIUM_READER_PASSWORD: ${{ secrets.BOOK_PASSWORD }}\n          SITE_BASE:"))).toBe(true);
    expect(workflowPublishesPasswords(v1)).toBe(false);
    expect(workflowPublishesPasswords(null)).toBe(false);
    expect(workflowPublishesPasswords(undefined)).toBe(false);
  });
});

describe("what a password in place is called", () => {
  it("is «in use» only when the reader protects, being published while it goes, and prepared otherwise", () => {
    const row = { state: "active" as const };
    expect(rowActivation(row, "protecting")).toBe("active");
    expect(rowActivation(row, "publishing")).toBe("publishing");
    for (const state of ["prepared", "unknown", "public"] as const) expect(rowActivation(row, state)).toBe("prepared");
    for (const state of ["pending", "removing", "out-of-sync", "unknown-value", "legacy", "dangling"] as const) expect(rowActivation({ state }, "protecting")).toBeNull();
  });
});

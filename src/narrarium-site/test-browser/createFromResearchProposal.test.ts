import { describe, expect, it } from "vitest";
import { parseEntityFromResearchResponse } from "@/research/createFromResearch";
import { buildCanonEntityDocument } from "@/narrarium/canon";
import { isGitHubFileNotFoundError } from "@/github/githubClient";
import { RepositoryError } from "@/repository/repositoryError";

describe("create-from-research proposals", () => {
  it("builds a complete reviewable proposal with deduplicated source citations", () => {
    const proposal = parseEntityFromResearchResponse("character", JSON.stringify({ name: "Ada", role_tier: "primary", story_role: "investigator", function_in_book: "Uncovers the fraud", body: "# Ada\n\nA precise investigator." }), "Sources: https://example.test/archive and https://example.test/archive");
    expect(proposal.label).toBe("Ada");
    expect(proposal.body).toContain("precise investigator");
    expect(proposal.extraFrontmatter.sources).toEqual(["https://example.test/archive"]);
    expect("path" in proposal).toBe(false);
    const document = buildCanonEntityDocument({ kind: "character", label: proposal.label, body: proposal.body, extraFrontmatter: proposal.extraFrontmatter });
    expect(document.path).toBe("characters/ada.md");
    expect(document.content).toContain("type: character");
    expect(document.content).toContain("https://example.test/archive");
    expect(document.content).toContain("A precise investigator.");
  });

  it("rejects incomplete model proposals", () => {
    expect(() => parseEntityFromResearchResponse("item", '{"name":"Compass"}', "Research")).toThrow("non-empty body");
  });

  it("preserves secret stakes and distinguishes a missing file from read failures", () => {
    const proposal = parseEntityFromResearchResponse("secret", JSON.stringify({ title: "The Ledger", stakes: "The crown falls", body: "# The Ledger\n\nHidden accounts." }), "Research");
    expect(proposal.extraFrontmatter.stakes).toBe("The crown falls");
    expect(isGitHubFileNotFoundError(new RepositoryError("missing", "not-found", "read", 404))).toBe(true);
    expect(isGitHubFileNotFoundError(new Error("GitHub content load secrets/ledger.md: 503"))).toBe(false);
    expect(isGitHubFileNotFoundError(new Error("network unavailable"))).toBe(false);
  });
});

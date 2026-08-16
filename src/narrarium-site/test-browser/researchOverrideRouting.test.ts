import { describe, expect, it, vi } from "vitest";

const completeTextRouted = vi.hoisted(() => vi.fn());
vi.mock("@/assistant/router", () => ({ completeTextRouted }));

import { generateEntityFromResearchProposal } from "@/research/createFromResearch";
import { regenerateEntity } from "@/research/regenerateEntity";

const preferred = { integrationId: "selected", model: "private-deployment" };
const common = {
  settings: { aiIntegrations: [] },
  book: { id: "book", name: "Book" },
  language: "en",
  overrideIntegrationId: preferred.integrationId,
  overrideModelName: preferred.model,
};

describe("research model overrides", () => {
  it("routes create-from-research overrides through common execution limits", async () => {
    completeTextRouted.mockResolvedValueOnce(JSON.stringify({ name: "Ada", body: "# Ada\n\nBody." }));
    await generateEntityFromResearchProposal({ ...common, branch: "main", token: "token", researchMarkdown: "Research", entityKind: "character" } as never);
    expect(completeTextRouted).toHaveBeenCalledWith(expect.anything(), expect.anything(), "create-from-research", expect.objectContaining({ preferred }));
  });

  it("routes regenerate overrides through common execution limits", async () => {
    completeTextRouted.mockResolvedValueOnce(JSON.stringify({ frontmatterPatches: {}, body: "# Ada\n\nRewritten." }));
    await regenerateEntity({ ...common, currentContent: "# Ada", researchMarkdowns: [], entityKind: "character" } as never);
    expect(completeTextRouted).toHaveBeenCalledWith(expect.anything(), expect.anything(), "create-from-research", expect.objectContaining({ preferred }));
  });
});

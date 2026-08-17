import { describe, expect, it } from "vitest";
import { resolveExportProfileSelection } from "@/components/book/BookExportDialog";
import { researchSaveBaseline } from "@/pages/DeepResearchPage";
import { ownsCompletedSpeechController } from "@/components/layout/Topbar";
import type { BookEntry } from "@/types/settings";
import type { SpeechController } from "@/assistant/speech";

describe("fixed audit regressions", () => {
  it("keeps a selected secondary export profile and resolves its settings", () => {
    const book = {
      id: "book", owner: "owner", repo: "repo", name: "Book", tokenIndex: null, addedAt: "now", defaultExportProfileId: "default",
      exportProfiles: [
        { id: "default", name: "Default", settings: { defaultScope: "draft", fontSize: 12 } },
        { id: "large", name: "Large", settings: { defaultScope: "full", fontSize: 18, microsoftDriveFolderPath: "Exports/Large" } },
      ],
    } satisfies BookEntry;
    expect(resolveExportProfileSelection(book, "large")).toMatchObject({ scope: "full", microsoftFolderPath: "Exports/Large", settings: { fontSize: 18 } });
  });

  it("parses the saved research title into the new clean baseline", () => {
    const saved = researchSaveBaseline("---\ntitle: New title\nupdatedAt: 2026-08-17T00:00:00Z\n---\n\nBody\n");
    expect(saved.frontmatter).toMatchObject({ title: "New title" });
    expect(saved.body).toBe("Body");
    expect(saved.body.trim()).toBe(saved.markdown.split("---").slice(-1)[0]?.trim());
  });

  it("clears speech only for the controller and generation that completed", () => {
    const controller = {} as SpeechController;
    const newer = {} as SpeechController;
    expect(ownsCompletedSpeechController(controller, controller, 3, 3)).toBe(true);
    expect(ownsCompletedSpeechController(newer, controller, 4, 3)).toBe(false);
    expect(ownsCompletedSpeechController(controller, controller, 4, 3)).toBe(false);
  });
});

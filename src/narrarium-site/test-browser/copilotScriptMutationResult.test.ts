import { expect, test } from "vitest";
import { describeCopilotScriptCreation } from "@/assistant/scriptMutationResult";
import type { CanonicalScriptMutationResult } from "@/narrarium/canonicalScriptMutationPlan";

const base: CanonicalScriptMutationResult = { changed: true, changedPaths: [], checks: [], errorCount: 0, warningCount: 0, revisions: {} };
const input = { title: "Opening", chapterSlug: "001-one", scriptPath: "scripts/001-one/001-opening.md" };

test("Copilot script creation describes create, ledger-only repair, and true duplicate no-op accurately", () => {
  expect(describeCopilotScriptCreation({ ...input, result: { ...base, changedPaths: [input.scriptPath, "state/script-ledger.md"] } })).toContain("I created a script");
  expect(describeCopilotScriptCreation({ ...input, result: { ...base, changedPaths: ["state/script-ledger.md"] } })).toContain("already existed; I repaired");
  expect(describeCopilotScriptCreation({ ...input, result: { ...base, changed: false, changedPaths: [] } })).toContain("no files changed");
});

test("Copilot duplicate results keep ledger warnings visible", () => {
  const text = describeCopilotScriptCreation({ ...input, result: { ...base, changed: false, changedPaths: [], warningCount: 1, checks: [{ severity: "warning", code: "unknown-command", path: input.scriptPath, line: 7, message: "Unknown command." }] } });
  expect(text).toContain("Ledger warnings:");
  expect(text).toContain(`${input.scriptPath}:7: Unknown command.`);
});

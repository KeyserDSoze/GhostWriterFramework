import { describe, expect, it } from "vitest";
import { migrateSettingsWithDiagnostics } from "@/drive/cloudSettingsClient";

const base = { version: 2, books: [], defaultGitHubToken: "", ui: { language: "en" } };

describe("cloud settings nested schema normalization", () => {
  it.each([
    ["missing", {}],
    ["null", { copilotTools: null, customActions: null }],
    ["partial", { copilotTools: {}, customActions: [{ id: "legacy", name: "Legacy", prompt: "Run" }] }],
    ["versioned", { copilotTools: { schemaVersion: 1, toolOverrides: { search: { enabled: false } } }, customActionsSchemaVersion: 1, customActions: [] }],
  ])("reconstructs defaults for the %s historical shape", (_name, shape) => {
    const { settings } = migrateSettingsWithDiagnostics({ ...base, ...shape });
    expect(settings.copilotTools.schemaVersion).toBe(1);
    expect(settings.copilotTools.toolOverrides).toBeTypeOf("object");
    expect(settings.customActionsSchemaVersion).toBe(1);
    if ("customActions" in shape && Array.isArray(shape.customActions) && shape.customActions.length) {
      expect(settings.customActions[0]?.injections).toEqual({ includeBody: true, includeFrontmatter: false, includeContext: true, includeGhostwriter: true });
    } else {
      expect(settings.customActions).toEqual([]);
    }
  });

  it("quarantines malformed actions and overrides with user-visible diagnostics", () => {
    const { settings, diagnostics } = migrateSettingsWithDiagnostics({
      ...base,
      copilotTools: { toolOverrides: { good: { enabled: false }, bad: { enabled: "yes" }, nope: null } },
      customActions: [
        { id: "good", name: "Good", prompt: "Run" },
        { id: "bad", name: 1, prompt: "Run" },
        { id: "good", name: "Duplicate", prompt: "Run" },
      ],
    });
    expect(settings.copilotTools.toolOverrides).toEqual({ good: { enabled: false } });
    expect(settings.customActions.map((entry) => entry.id)).toEqual(["good"]);
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics.join(" ")).toMatch(/ignored|quarantined/);
  });

  it("fails closed for unsupported nested schema versions and malformed roots", () => {
    const unsupported = migrateSettingsWithDiagnostics({ ...base, copilotTools: { schemaVersion: 99, toolOverrides: { tool: { enabled: false } } }, customActionsSchemaVersion: 99, customActions: [{ id: "action", name: "Action", prompt: "Run" }] });
    expect(unsupported.settings.copilotTools.toolOverrides).toEqual({});
    expect(unsupported.settings.customActions).toEqual([]);
    expect(unsupported.diagnostics).toHaveLength(2);
    expect(migrateSettingsWithDiagnostics(null).diagnostics).toHaveLength(1);
    expect(migrateSettingsWithDiagnostics([]).diagnostics).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { buildParagraphScriptArtifact } from "@/narrarium/workspace";
import { planCanonicalScriptMutation } from "@/narrarium/scriptLedger";

const chapter = (slug: string, number: number) => ({
  path: `chapters/${slug}/chapter.md`,
  content: `---\ntype: chapter\nid: chapter:${slug}\nnumber: ${number}\ntitle: Chapter ${number}\n---\n`,
});

const script = (chapterSlug: string, number: number, title: string, body?: string) =>
  buildParagraphScriptArtifact({ chapterSlug, number, title, body });

describe("canonical script mutation planning", () => {
  it("synchronizes chapter and paragraph script paths and reports every changed path", async () => {
    const first = script("001-one", 1, "Opening");
    const second = script("002-two", 2, "Answer");
    const planned = await planCanonicalScriptMutation(
      [chapter("001-one", 1), chapter("002-two", 2)],
      [
        { path: first.path, content: first.content, expectedCurrentHash: null },
        { path: second.path, content: second.content, expectedCurrentHash: null },
      ],
    );

    expect(planned.result.changed).toBe(true);
    expect(planned.result.changedPaths).toEqual([first.path, second.path, "state/script-ledger.md"]);
    expect(planned.result.errorCount).toBe(0);
    expect(planned.mutations[planned.mutations.length - 1]?.content).toContain(`"path": "${second.path}"`);
  });

  it("rejects duplicate creation and reports an identical existing script as a no-op", async () => {
    const artifact = script("001-one", 1, "Opening");
    const files = [chapter("001-one", 1), { path: artifact.path, content: artifact.content }];

    await expect(planCanonicalScriptMutation(files, [{ path: artifact.path, content: artifact.content, expectedCurrentHash: null }])).rejects.toMatchObject({ code: "REPOSITORY_CONFLICT", path: artifact.path });
    const existing = await planCanonicalScriptMutation(files, [{ path: artifact.path, content: "different", ifAbsent: true }]);
    expect(existing.result.changedPaths).toEqual(["state/script-ledger.md"]);
    const canonicalFiles = [...files, { path: "state/script-ledger.md", content: existing.mutations[0].content! }];
    const noOp = await planCanonicalScriptMutation(canonicalFiles, [{ path: artifact.path, content: artifact.content }]);
    expect(noOp.result).toMatchObject({ changed: false, changedPaths: [], warningCount: 0, errorCount: 0 });
  });

  it("repairs missing or stale ledgers on ifAbsent and preserves warnings on a canonical no-op", async () => {
    const artifact = script("001-one", 1, "Opening", "@unknown_command{keep}\n@scene_goal{Open}\n@pov{character:a}");
    const files = [chapter("001-one", 1), { path: artifact.path, content: artifact.content }];
    const missing = await planCanonicalScriptMutation(files, [{ path: artifact.path, content: "ignored", ifAbsent: true }]);
    expect(missing.result).toMatchObject({ changed: true, changedPaths: ["state/script-ledger.md"], warningCount: 1 });

    const stale = await planCanonicalScriptMutation([...files, { path: "state/script-ledger.md", content: "stale" }], [{ path: artifact.path, content: "ignored", ifAbsent: true }]);
    expect(stale.result.changedPaths).toEqual(["state/script-ledger.md"]);

    const canonical = await planCanonicalScriptMutation([...files, { path: "state/script-ledger.md", content: missing.mutations[0].content! }], [{ path: artifact.path, content: "ignored", ifAbsent: true }]);
    expect(canonical.result).toMatchObject({ changed: false, changedPaths: [], warningCount: 1 });
    expect(canonical.result.checks[0].code).toBe("unknown-command");
  });

  it("returns ledger warnings for inspection and includes the ledger on delete", async () => {
    const artifact = script("001-one", 1, "Opening", "@unknown_command{keep this}\n@scene_goal{Open}\n@pov{character:a}");
    const warning = await planCanonicalScriptMutation([chapter("001-one", 1)], [{ path: artifact.path, content: artifact.content, expectedCurrentHash: null }]);
    expect(warning.result.warningCount).toBe(1);
    expect(warning.result.checks[0].code).toBe("unknown-command");

    const deletion = await planCanonicalScriptMutation(
      [chapter("001-one", 1), { path: artifact.path, content: artifact.content }],
      [{ path: artifact.path, content: null }],
    );
    expect(deletion.result.changedPaths).toEqual([artifact.path, "state/script-ledger.md"]);
  });

  it("replaces a supplied ledger mutation with exactly one canonical ledger", async () => {
    const artifact = script("001-one", 1, "Opening");
    const planned = await planCanonicalScriptMutation(
      [chapter("001-one", 1), { path: "state/script-ledger.md", content: "stale" }],
      [
        { path: artifact.path, content: artifact.content, expectedCurrentHash: null },
        { path: "state/script-ledger.md", content: "model supplied content" },
      ],
    );

    const ledgerMutations = planned.mutations.filter((mutation) => mutation.path === "state/script-ledger.md");
    expect(ledgerMutations).toHaveLength(1);
    expect(ledgerMutations[0].content).not.toBe("model supplied content");
    expect(planned.result.changedPaths).toEqual([artifact.path, "state/script-ledger.md"]);
  });

  it("blocks the whole mutation when the prospective ledger contains errors", async () => {
    const artifact = script("001-one", 1, "Opening", "@assert{door=open}\n@scene_goal{Open}\n@pov{character:a}");
    await expect(planCanonicalScriptMutation(
      [chapter("001-one", 1)],
      [{ path: artifact.path, content: artifact.content, expectedCurrentHash: null }],
    )).rejects.toMatchObject({
      name: "ScriptLedgerValidationError",
      checks: [expect.objectContaining({ severity: "error", code: "assertion-failed", path: artifact.path })],
    });
  });
});

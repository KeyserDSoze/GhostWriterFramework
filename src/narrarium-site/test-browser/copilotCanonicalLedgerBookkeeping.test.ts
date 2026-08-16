import { expect, test } from "vitest";
import { applyCanonicalRevisionResults, markFileUpdatesApplied } from "@/assistant/multiFileOperation";
import { buildParagraphScriptArtifact } from "@/narrarium/workspace";
import { hashCanonicalText, planCanonicalScriptMutation } from "@/narrarium/canonicalScriptMutationPlan";

const chapter = { path: "chapters/001-one/chapter.md", content: "---\ntype: chapter\nid: chapter:001-one\nnumber: 1\ntitle: One\n---\n" };

test("Copilot script plus supplied-ledger bookkeeping uses canonical persistence and supports canonical undo", async () => {
  const script = buildParagraphScriptArtifact({ chapterSlug: "001-one", number: 1, title: "Opening", paragraphSlug: "001-opening" });
  const initial = await planCanonicalScriptMutation([chapter], [{ path: script.path, content: script.content, expectedCurrentHash: null }]);
  const initialByPath = new Map(initial.mutations.map((mutation) => [mutation.path, mutation.content]));
  const priorLedger = initialByPath.get("state/script-ledger.md")!;
  const priorFiles = [chapter, { path: script.path, content: script.content }, { path: "state/script-ledger.md", content: priorLedger! }];
  const nextScript = script.content.replace("Define the scene goal", "Reach the gate");
  const suppliedLedger = "model supplied ledger that must never persist";
  const updates = [{ path: script.path, content: nextScript }, { path: "state/script-ledger.md", content: suppliedLedger }];

  const appliedPlan = await planCanonicalScriptMutation(priorFiles, [
    { path: script.path, content: nextScript, expectedCurrentHash: await hashCanonicalText(script.content) },
    { path: "state/script-ledger.md", content: suppliedLedger, expectedCurrentHash: await hashCanonicalText(priorLedger!) },
  ]);
  const defaults = {
    [script.path]: { previousContent: script.content, appliedHash: await hashCanonicalText(nextScript) },
    "state/script-ledger.md": { previousContent: priorLedger!, appliedHash: await hashCanonicalText(suppliedLedger) },
  };
  const actual = applyCanonicalRevisionResults(updates, defaults, appliedPlan.result);
  const marked = markFileUpdatesApplied(updates, actual);
  const ledgerUpdate = marked.find((update) => update.path === "state/script-ledger.md")!;

  expect(ledgerUpdate.content).toBe(appliedPlan.result.revisions["state/script-ledger.md"].content);
  expect(ledgerUpdate.content).not.toBe(suppliedLedger);
  expect(ledgerUpdate.appliedHash).toBe(appliedPlan.result.revisions["state/script-ledger.md"].hash);
  expect(ledgerUpdate.appliedHash).not.toBe(await hashCanonicalText(suppliedLedger));

  const persisted = new Map(priorFiles.map((file) => [file.path, file.content]));
  for (const mutation of appliedPlan.mutations) mutation.content === null ? persisted.delete(mutation.path) : persisted.set(mutation.path, mutation.content);
  for (const update of marked) expect(await hashCanonicalText(persisted.get(update.path)!)).toBe(update.appliedHash);

  const generatedAt = /^generated_at:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(priorLedger!)?.[1].trim();
  const undo = await planCanonicalScriptMutation([...persisted].map(([path, content]) => ({ path, content })), marked.map((update) => ({ path: update.path, content: update.previousContent ?? null, expectedCurrentHash: update.appliedHash })), { ledgerGeneratedAt: generatedAt });
  expect(undo.result.revisions[script.path].content).toBe(script.content);
  expect(undo.result.revisions["state/script-ledger.md"].content).toBe(priorLedger);
  expect(undo.result.revisions["state/script-ledger.md"].hash).toBe(await hashCanonicalText(priorLedger!));
});

test("Copilot bookkeeping records canonical ledger bytes when supplied ledger and script are persistence no-ops", async () => {
  const script = buildParagraphScriptArtifact({ chapterSlug: "001-one", number: 1, title: "Opening", paragraphSlug: "001-opening" });
  const initial = await planCanonicalScriptMutation([chapter], [{ path: script.path, content: script.content, expectedCurrentHash: null }]);
  const ledger = initial.mutations.find((mutation) => mutation.path === "state/script-ledger.md")!.content!;
  const suppliedLedger = "not canonical";
  const updates = [{ path: script.path, content: script.content }, { path: "state/script-ledger.md", content: suppliedLedger }];
  const plan = await planCanonicalScriptMutation([chapter, { path: script.path, content: script.content }, { path: "state/script-ledger.md", content: ledger }], updates);
  const actual = applyCanonicalRevisionResults(updates, {
    [script.path]: { previousContent: script.content, appliedHash: await hashCanonicalText(script.content) },
    "state/script-ledger.md": { previousContent: ledger, appliedHash: await hashCanonicalText(suppliedLedger) },
  }, plan.result);

  expect(plan.result).toMatchObject({ changed: false, changedPaths: [] });
  expect(actual["state/script-ledger.md"]).toEqual({ previousContent: ledger, appliedContent: ledger, appliedHash: await hashCanonicalText(ledger) });
});

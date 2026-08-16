import type { CanonicalScriptMutationResult } from "@/narrarium/canonicalScriptMutationPlan";

export function describeCopilotScriptCreation(input: { title: string; chapterSlug: string; scriptPath: string; result: CanonicalScriptMutationResult }): string {
  const summary = input.result.changedPaths.includes(input.scriptPath)
    ? `I created a script for \`${input.title}\` in chapter \`${input.chapterSlug}\`.`
    : input.result.changedPaths.includes("state/script-ledger.md")
      ? `The script \`${input.scriptPath}\` already existed; I repaired the canonical script ledger without changing the script.`
      : `The script \`${input.scriptPath}\` already existed and the canonical ledger was current; no files changed.`;
  const warnings = input.result.checks.filter((check) => check.severity === "warning").map((check) => `${check.path}${check.line ? `:${check.line}` : ""}: ${check.message}`);
  return `${summary}${warnings.length ? `\n\nLedger warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : ""}`;
}

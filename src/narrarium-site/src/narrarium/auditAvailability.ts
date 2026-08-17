import { resolveTaskCandidates } from "@/assistant/router";
import { resolveBookAuditSettings, type AppSettings, type BookEntry } from "@/types/settings";

export type AuditRunBlocker = "disabled" | "missing-model";

export function auditRunBlocker(book: BookEntry, settings: AppSettings): AuditRunBlocker | null {
  if (!resolveBookAuditSettings(book).enabled) return "disabled";
  const hasExecutableRoute = resolveTaskCandidates(settings, "audit")
    .some((candidate) => Boolean(candidate.integration && candidate.model && candidate.supportsToolCalls !== false));
  return hasExecutableRoute ? null : "missing-model";
}

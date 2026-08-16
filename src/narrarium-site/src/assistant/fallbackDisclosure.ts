import type { AppSettings } from "@/types/settings";
import { setAiOperationAccountScope } from "@/assistant/accountScopedOperation";

export type DisclosedContentKind = "text" | "image" | "audio";

let activeAccountScope: string | null = null;

export interface BoundaryCandidate {
  browser?: boolean;
  integration?: { id: string; name: string; provider: string };
}

export class CrossBoundaryFallbackCancelledError extends DOMException {
  constructor() {
    super("Cross-boundary fallback was cancelled before content was sent.", "AbortError");
  }
}

export function candidateBoundary(candidate: BoundaryCandidate): string {
  return candidate.browser ? "local:browser" : `integration:${candidate.integration?.id ?? "unknown"}`;
}

export function candidateBoundaryLabel(candidate: BoundaryCandidate): string {
  if (candidate.browser) return "Browser / local device";
  return `${candidate.integration?.provider ?? "unknown"} / ${candidate.integration?.name ?? "unknown account"}`;
}

export function applySameBoundaryPolicy<C extends BoundaryCandidate>(settings: AppSettings, candidates: C[]): C[] {
  if (!settings.fallbackDisclosure?.sameBoundaryOnly || candidates.length < 2) return candidates;
  const primaryBoundary = candidateBoundary(candidates[0]);
  return candidates.filter((candidate) => candidateBoundary(candidate) === primaryBoundary);
}

export function setFallbackAcknowledgementAccountScope(accountScope: string | null): void {
  activeAccountScope = accountScope?.trim().toLocaleLowerCase() || null;
  setAiOperationAccountScope(activeAccountScope);
}

function acknowledgementKey(accountScope: string, kind: DisclosedContentKind, from: string, to: string): string {
  return `narrarium:fallback-disclosure:v2:${encodeURIComponent(accountScope)}:${kind}:${encodeURIComponent(from)}:${encodeURIComponent(to)}`;
}

export function acknowledgeCrossBoundaryFallback(input: {
  settings: AppSettings;
  kind: DisclosedContentKind;
  from: BoundaryCandidate;
  to: BoundaryCandidate;
  accountScope?: string | null;
  confirm?: (message: string) => boolean;
}): void {
  const from = candidateBoundary(input.from);
  const to = candidateBoundary(input.to);
  if (from === to || !input.settings.fallbackDisclosure?.requireAcknowledgement) return;
  const accountScope = input.accountScope === undefined ? activeAccountScope : input.accountScope?.trim().toLocaleLowerCase() || null;
  const key = accountScope ? acknowledgementKey(accountScope, input.kind, from, to) : null;
  if (key && typeof localStorage !== "undefined" && localStorage.getItem(key) === "acknowledged") return;
  const confirm = input.confirm ?? ((message: string) => typeof window !== "undefined" && window.confirm(message));
  const accepted = confirm(`The next fallback crosses an account/provider boundary. ${input.kind} content will be sent from ${candidateBoundaryLabel(input.from)} to ${candidateBoundaryLabel(input.to)}. Continue?`);
  if (!accepted) throw new CrossBoundaryFallbackCancelledError();
  if (key && typeof localStorage !== "undefined") localStorage.setItem(key, "acknowledged");
}

export function clearFallbackAcknowledgements(accountScope: string | null = activeAccountScope): void {
  if (typeof localStorage === "undefined") return;
  const scopedPrefix = accountScope ? `narrarium:fallback-disclosure:v2:${encodeURIComponent(accountScope.trim().toLocaleLowerCase())}:` : null;
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key && (key.startsWith("narrarium:fallback-disclosure:v1:") || (scopedPrefix && key.startsWith(scopedPrefix)))) localStorage.removeItem(key);
  }
}

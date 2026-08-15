export type BranchSource = "active" | "working" | "personal" | "loaded" | "default" | "fallback";

export interface BranchResolution {
  branch: string;
  source: BranchSource;
  requiresCreation: boolean;
  structureMatches: boolean;
}

function personalBranch(email: string): string {
  const local = email.split("@")[0].toLowerCase().replace(/\+/g, "-").replace(/[^a-z0-9._-]/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  return `dev-${local}`;
}

export function resolveAuthoritativeBranch(input: { activeBranch?: string; workingBranch?: string; loadedBranch?: string; defaultBranch?: string; userEmail?: string }): BranchResolution {
  const branch = input.activeBranch ?? input.workingBranch ?? (input.userEmail ? personalBranch(input.userEmail) : undefined) ?? input.loadedBranch ?? input.defaultBranch ?? "main";
  const source: BranchSource = input.activeBranch ? "active" : input.workingBranch ? "working" : input.userEmail ? "personal" : input.loadedBranch ? "loaded" : input.defaultBranch ? "default" : "fallback";
  return { branch, source, requiresCreation: source === "personal", structureMatches: !input.loadedBranch || input.loadedBranch === branch };
}

export function branchIsReady(input: { resolution: BranchResolution; ensuring: boolean; error: string | null; personalBranchRecorded: boolean }): boolean {
  return !input.ensuring && !input.error && (!input.resolution.requiresCreation || input.personalBranchRecorded) && input.resolution.structureMatches;
}

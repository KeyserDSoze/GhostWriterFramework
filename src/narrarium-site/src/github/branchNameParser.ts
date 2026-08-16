export type BranchNameParseResult =
  | { status: "ok"; branchName: string }
  | { status: "missing" }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "invalid"; branchName: string };

export function isValidGitBranchName(value: string): boolean {
  if (!value || value.length > 255 || value === "@" || value === "HEAD" || value.startsWith("-")) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("//")) return false;
  if (value.includes("..") || value.includes("@{") || /[\x00-\x20\x7f~^:?*[\\]/.test(value)) return false;
  return value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function parseBranchName(prompt: string): BranchNameParseResult {
  const candidates: string[] = [];
  const quoted = /\b(?:branch|ramo)\s+(?:(?:called|named|chiamat[oa]|denominat[oa]|di nome)\s+)?(["“'‘`])/gi;
  const closingQuote: Record<string, string> = { '"': '"', "'": "'", "`": "`", "“": "”", "‘": "’" };
  for (const match of prompt.matchAll(quoted)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = prompt.indexOf(closingQuote[match[1]], start);
    if (end < 0) return { status: "invalid", branchName: prompt.slice(start).trim() };
    candidates.push(prompt.slice(start, end).trim());
  }
  if (candidates.length) return branchCandidateResult(candidates);

  const patterns = [
    /\b(?:branch|ramo)\s+(?:called|named|chiamat[oa]|denominat[oa]|di nome|in|to|su|a|al|verso)\s+([^\s,;!?]+)/gi,
    /\b(?:switch|checkout|create|new|crea|cambia|passa|vai|usa)\s+(?:(?:to|a|al|alla|in|nel|nella|su|sul|sulla|verso)\s+)?(?:(?:the|a|an|il|lo|la|un|uno|una)\s+)?(?:branch|ramo)\s+(?:(?:called|named|chiamat[oa]|denominat[oa]|di nome|in|to|su|a|al|verso)\s+)?([^\s,;!?]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) candidates.push(match[1].replace(/[.]+$/, "").trim());
  }

  return branchCandidateResult(candidates);
}

function branchCandidateResult(candidates: string[]): BranchNameParseResult {
  const unique = [...new Set(candidates.filter(Boolean))];
  if (!unique.length) return { status: "missing" };
  if (unique.length > 1) return { status: "ambiguous", candidates: unique };
  return isValidGitBranchName(unique[0]) ? { status: "ok", branchName: unique[0] } : { status: "invalid", branchName: unique[0] };
}

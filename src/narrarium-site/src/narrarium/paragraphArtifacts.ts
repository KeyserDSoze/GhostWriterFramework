export interface ParagraphArtifactTarget {
  path: string;
  chapterSlug: string;
  paragraphSlug: string;
  title: string;
}

export interface ParagraphArtifactMetadata {
  title?: string;
  paragraph?: string;
}

type ParagraphArtifactKind = "draft" | "script";

function artifactInfo(path: string, kind: ParagraphArtifactKind): { chapterSlug: string; paragraphSlug: string } | undefined {
  const pattern = kind === "draft"
    ? /^(?:drafts\/([^/]+)|chapters\/([^/]+)\/drafts)\/([^/]+)\.md$/
    : /^scripts\/([^/]+)\/([^/]+)\.md$/;
  const match = pattern.exec(path);
  if (!match) return undefined;
  return kind === "draft"
    ? { chapterSlug: match[1] ?? match[2] ?? "", paragraphSlug: match[3] ?? "" }
    : { chapterSlug: match[1] ?? "", paragraphSlug: match[2] ?? "" };
}

function normalizedTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/^\d{3}(?:-|\s+)?/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Resolve paragraph companions without guessing when more than one artifact could match. */
export function resolveParagraphArtifactPaths(
  kind: ParagraphArtifactKind,
  allPaths: string[],
  targets: ParagraphArtifactTarget[],
  metadataByPath: Record<string, ParagraphArtifactMetadata>,
): Map<string, string> {
  const pathSet = new Set(allPaths);
  const candidates = allPaths.filter((path) => artifactInfo(path, kind));
  const resolved = new Map<string, string>();
  const used = new Set<string>();

  for (const target of targets) {
    const canonical = kind === "draft"
      ? `drafts/${target.chapterSlug}/${target.paragraphSlug}.md`
      : `scripts/${target.chapterSlug}/${target.paragraphSlug}.md`;
    const legacy = kind === "draft"
      ? `chapters/${target.chapterSlug}/drafts/${target.paragraphSlug}.md`
      : undefined;
    const exact = pathSet.has(canonical) ? canonical : legacy && pathSet.has(legacy) ? legacy : undefined;
    if (exact) {
      resolved.set(target.path, exact);
      used.add(exact);
      if (legacy && pathSet.has(legacy)) used.add(legacy);
    }
  }

  function assignUnique(match: (candidate: string, target: ParagraphArtifactTarget) => boolean) {
    const availableTargets = targets.filter((target) => !resolved.has(target.path));
    const availableCandidates = candidates.filter((candidate) => !used.has(candidate));
    const matchesByTarget = new Map<string, string[]>();
    const targetCountByCandidate = new Map<string, number>();

    for (const target of targets) {
      const matches = availableCandidates.filter((candidate) => match(candidate, target));
      if (!resolved.has(target.path)) matchesByTarget.set(target.path, matches);
      for (const candidate of matches) {
        targetCountByCandidate.set(candidate, (targetCountByCandidate.get(candidate) ?? 0) + 1);
      }
    }

    for (const target of availableTargets) {
      const matches = matchesByTarget.get(target.path) ?? [];
      const candidate = matches[0];
      if (!candidate || matches.length !== 1 || targetCountByCandidate.get(candidate) !== 1) continue;
      resolved.set(target.path, candidate);
      used.add(candidate);
    }
  }

  assignUnique((candidate, target) =>
    metadataByPath[candidate]?.paragraph === `paragraph:${target.chapterSlug}:${target.paragraphSlug}`,
  );

  assignUnique((candidate, target) => {
    const info = artifactInfo(candidate, kind);
    const candidateTitle = metadataByPath[candidate]?.title ?? info?.paragraphSlug ?? "";
    const targetTitle = normalizedTitle(target.title);
    return Boolean(targetTitle) && normalizedTitle(candidateTitle) === targetTitle;
  });

  // A lone leftover in the current chapter is safe to associate even after a title rename.
  const chapterSlugs = new Set(targets.map((target) => target.chapterSlug));
  for (const chapterSlug of chapterSlugs) {
    const remainingTargets = targets.filter((target) => target.chapterSlug === chapterSlug && !resolved.has(target.path));
    const remainingCandidates = candidates.filter((candidate) =>
      !used.has(candidate) && artifactInfo(candidate, kind)?.chapterSlug === chapterSlug,
    );
    const target = remainingTargets[0];
    const candidate = remainingCandidates[0];
    if (target && candidate && remainingTargets.length === 1 && remainingCandidates.length === 1) {
      resolved.set(target.path, candidate);
      used.add(candidate);
    }
  }

  return resolved;
}

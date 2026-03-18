export type CanonMentionEntry = {
  id: string;
  href: string;
};

export function buildCanonHrefIndex(entries: CanonMentionEntry[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const entry of entries) {
    const normalizedHref = normalizeCanonEntityHref(entry.href);
    if (!normalizedHref) {
      continue;
    }

    index.set(normalizedHref, entry.id);
  }

  return index;
}

export function resolveCanonEntryIdFromHref(href: string, entries: CanonMentionEntry[]): string | null {
  const normalizedHref = normalizeCanonEntityHref(href);
  if (!normalizedHref) {
    return null;
  }

  return buildCanonHrefIndex(entries).get(normalizedHref) ?? null;
}

export function normalizeCanonEntityHref(href: string): string | null {
  const strippedOrigin = href
    .trim()
    .replace(/^[a-z]+:\/\/[^/]+/i, "")
    .split(/[?#]/, 1)[0]
    .replace(/\\/g, "/");
  if (!strippedOrigin) {
    return null;
  }

  const segments = strippedOrigin
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== "." && segment !== "..");

  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index]?.toLowerCase();
    if (!current) {
      continue;
    }

    if (current === "timelines" && segments[index + 1]?.toLowerCase() === "events") {
      const slug = normalizeSlugSegment(segments[index + 2]);
      if (slug) {
        return `timeline/${slug}/`;
      }
      continue;
    }

    const section = normalizeCanonSection(current);
    if (!section) {
      continue;
    }

    const slug = normalizeSlugSegment(segments[index + 1]);
    if (slug) {
      return `${section}/${slug}/`;
    }
  }

  return null;
}

function normalizeCanonSection(segment: string): string | null {
  switch (segment.toLowerCase()) {
    case "character":
    case "characters":
      return "characters";
    case "location":
    case "locations":
      return "locations";
    case "faction":
    case "factions":
      return "factions";
    case "item":
    case "items":
      return "items";
    case "secret":
    case "secrets":
      return "secrets";
    case "timeline":
    case "timeline-event":
      return "timeline";
    default:
      return null;
  }
}

function normalizeSlugSegment(segment: string | undefined): string | null {
  if (!segment) {
    return null;
  }

  const normalized = segment.replace(/\.md$/i, "").trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(normalized) ? normalized : null;
}

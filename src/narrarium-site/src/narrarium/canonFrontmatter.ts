export type CanonEntityKind = "character" | "location" | "faction" | "item" | "secret" | "timeline-event";
export const PROTECTED_CANON_FIELDS = ["type", "id", "canon", "status", "name", "title"] as const;
const COMMON = ["pronunciation", "spoken_name", "tts_label", "tags", "refs", "sources", "historical", "secret_refs", "private_notes", "reveal_in", "known_from"];
const SPECIFIC: Record<CanonEntityKind, string[]> = {
  character: ["aliases", "former_names", "current_identity", "identity_shifts", "identity_arc", "role_tier", "story_role", "speaking_style", "background_summary", "function_in_book", "age", "occupation", "origin", "first_impression", "arc", "internal_conflict", "external_conflict", "traits", "mannerisms", "desires", "fears", "relationships", "factions", "home_location", "introduced_in", "timeline_ages"],
  location: ["location_kind", "region", "atmosphere", "function_in_book", "landmarks", "risks", "factions_present", "based_on_real_place", "timeline_ref"],
  faction: ["faction_kind", "mission", "ideology", "function_in_book", "public_image", "hidden_agenda", "leaders", "allies", "enemies", "methods", "base_location"],
  item: ["item_kind", "appearance", "purpose", "function_in_book", "significance", "origin_story", "powers", "limitations", "owner", "introduced_in"],
  secret: ["secret_kind", "function_in_book", "stakes", "protected_by", "false_beliefs", "reveal_strategy", "holders", "timeline_ref"],
  "timeline-event": ["date", "participants", "significance", "function_in_book", "consequences"],
};

export function validateCanonExtraFrontmatter(kind: CanonEntityKind, value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  const allowed = new Set([...COMMON, ...SPECIFIC[kind]]);
  const invalid = Object.keys(value).filter((key) => !allowed.has(key));
  if (invalid.length) throw new Error(`Invalid ${kind} frontmatter field${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`);
  return { ...value };
}

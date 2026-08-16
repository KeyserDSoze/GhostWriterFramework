import { parseDocument } from "yaml";
import type { AppRouteContext } from "@/assistant/context";
import type { BookStructure, Chapter } from "@/types/book";

export type SecretAccess = "hidden" | "known" | "revealed" | "author";

// Copilot follows story-position thresholds even in the private author app.
// Only opening one secret's canon route explicitly unlocks that secret for author work.

export interface SecretThresholds {
  knownFrom?: string;
  revealIn?: string;
}

export function parseSecretThresholds(raw: string): SecretThresholds {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return {};
  try {
    const value = parseDocument(match[1]).toJSON() as Record<string, unknown> | null;
    return {
      knownFrom: optionalString(value?.known_from),
      revealIn: optionalString(value?.reveal_in),
    };
  } catch {
    return {};
  }
}

export function resolveSecretAccess(input: {
  thresholds: SecretThresholds;
  chapters: Chapter[];
  currentChapterSlug?: string;
  directAuthorRoute?: boolean;
}): SecretAccess {
  if (input.directAuthorRoute) return "author";
  if (!input.currentChapterSlug) return "hidden";

  const current = chapterIndex(input.currentChapterSlug, input.chapters);
  if (current === null) return "hidden";
  const { knownFrom, revealIn } = input.thresholds;
  if (!knownFrom && !revealIn) return "hidden";

  const known = knownFrom ? resolveReference(knownFrom, input.chapters) : null;
  const reveal = revealIn ? resolveReference(revealIn, input.chapters) : null;
  if ((knownFrom && known === null) || (revealIn && reveal === null)) return "hidden";

  const visibleAt = known ?? reveal;
  if (visibleAt === null || current < visibleAt) return "hidden";
  const revealedAt = reveal ?? known;
  return revealedAt !== null && current >= revealedAt ? "revealed" : "known";
}

export function directSecretPath(route: AppRouteContext): string | null {
  return route.kind === "canon" && route.section === "secrets" ? `secrets/${route.slug}.md` : null;
}

export function secretAccessFromManifest(context: { availableFiles: Array<{ path: string; secretAccess?: Exclude<SecretAccess, "hidden"> }> }, path: string): SecretAccess {
  return context.availableFiles.find((file) => file.path === path)?.secretAccess ?? "hidden";
}

export function canDiscloseSecretBody(access: SecretAccess): boolean {
  return access === "revealed" || access === "author";
}

export function canSearchAvailableFile(file: { path: string; secretAccess?: Exclude<SecretAccess, "hidden"> }): boolean {
  return !isSecretPath(file.path) || canDiscloseSecretBody(file.secretAccess ?? "hidden");
}

export function isSecretPath(path: string): boolean {
  return path.startsWith("secrets/");
}

export function visibleSecretManifestEntries<T extends { path: string }>(secrets: T[], accessByPath: ReadonlyMap<string, SecretAccess>) {
  return secrets.flatMap((file) => {
    const secretAccess = accessByPath.get(file.path) ?? "hidden";
    return secretAccess === "hidden" ? [] : [{ path: file.path, role: "secret", exists: true, secretAccess }];
  });
}

export function secretAccessMapForRoute(input: {
  structure: BookStructure;
  route: AppRouteContext;
  chapter: Chapter | null;
}): Map<string, SecretAccess> {
  const directPath = directSecretPath(input.route);
  return new Map(input.structure.secrets.map((secret) => {
    const access = resolveSecretAccess({
      thresholds: { knownFrom: secret.knownFrom, revealIn: secret.revealIn },
      chapters: input.structure.chapters,
      currentChapterSlug: input.chapter?.slug,
      directAuthorRoute: secret.path === directPath,
    });
    return [secret.path, access];
  }));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function chapterIndex(slug: string, chapters: Chapter[]): number | null {
  const index = chapters.findIndex((chapter) => chapter.slug === slug);
  return index < 0 ? null : index;
}

function resolveReference(reference: string, chapters: Chapter[]): number | null {
  const normalized = reference.trim()
    .replace(/^chapter:/, "")
    .replace(/^chapters\//, "")
    .replace(/\/chapter\.md$/, "");
  return chapterIndex(normalized, chapters);
}

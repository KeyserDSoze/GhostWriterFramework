import { parseDocument, stringify } from "yaml";
import { captureImmediateMutation, commitImmediateMutations } from "@/assistant/immediateMutation";
import { defaultGhostwriter, serializeGhostwriter } from "@/narrarium/ghostwriter";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

const DEFAULT_GHOSTWRITER_PATH = "ghostwriters/default.md";
const LEGACY_STYLE_PATH = /^(?:writing-style|punctuation-style)\.md$|^guidelines\/(?:writing-style|punctuation-style|style|prose|voices|chapter-rules|structure)\.md$|^guidelines\/styles\/|^(?:chapters|drafts)\/[^/]+\/writing-style\.md$/;

function parseBookMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("Invalid book.md frontmatter: expected a closed YAML frontmatter block.");
  const document = parseDocument(match[1]);
  if (document?.errors.length) throw new Error(`Invalid book.md frontmatter: ${document.errors[0].message}`);
  const frontmatter = (document.toJSON() as Record<string, unknown>) ?? {};
  if (frontmatter.type !== "book" || frontmatter.id !== "book" || typeof frontmatter.title !== "string" || !frontmatter.title.trim()) {
    throw new Error("Invalid book.md frontmatter: type, id, and title are required.");
  }
  return { frontmatter, body: match[2] };
}

function selectDefaultGhostwriter(raw: string): string {
  const { frontmatter, body } = parseBookMarkdown(raw);
  frontmatter.ghostwriter = "default";
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}

export async function ensureDefaultGhostwriter(input: {
  token: string;
  book: BookEntry;
  branch: string;
  structure: BookStructure;
  signal?: AbortSignal;
}): Promise<boolean> {
  const hasDefault = input.structure.ghostwriters.some((entry) => entry.slug === "default");
  const hasSelectedGhostwriter = input.structure.ghostwriters.some((entry) => entry.slug === input.structure.ghostwriter);
  const legacyPaths = Array.from(new Set((input.structure.searchableFiles ?? []).map((entry) => entry.path).filter((path) => LEGACY_STYLE_PATH.test(path))));
  if (hasDefault && hasSelectedGhostwriter && !legacyPaths.length) return false;

  const bookSnapshot = await captureImmediateMutation({
    token: input.token,
    book: input.book,
    branch: input.branch,
    path: "book.md",
    signal: input.signal,
  });
  if (bookSnapshot.content === null) throw new Error("The book metadata file is missing.");
  parseBookMarkdown(bookSnapshot.content);
  const selectedBookContent = hasSelectedGhostwriter ? null : selectDefaultGhostwriter(bookSnapshot.content);

  const snapshots: Parameters<typeof commitImmediateMutations>[0]["snapshots"] = [];
  if (!hasDefault) {
    const ghostwriterSnapshot = await captureImmediateMutation({
      token: input.token,
      book: input.book,
      branch: input.branch,
      path: DEFAULT_GHOSTWRITER_PATH,
      remoteHeadSha: bookSnapshot.remoteHeadSha,
      signal: input.signal,
    });
    if (ghostwriterSnapshot.content === null) {
      snapshots.push({
        snapshot: ghostwriterSnapshot,
        content: serializeGhostwriter(defaultGhostwriter(input.structure.language)),
      });
    }
  }
  if (selectedBookContent !== null) snapshots.push({ snapshot: bookSnapshot, content: selectedBookContent });
  for (const path of legacyPaths) {
    const snapshot = await captureImmediateMutation({
      token: input.token,
      book: input.book,
      branch: input.branch,
      path,
      remoteHeadSha: bookSnapshot.remoteHeadSha,
      signal: input.signal,
    });
    if (snapshot.content !== null) snapshots.push({ snapshot, content: null });
  }
  if (!snapshots.length) return false;

  await commitImmediateMutations({
    token: input.token,
    book: input.book,
    branch: input.branch,
    snapshots,
    message: "Ensure default ghostwriter",
    signal: input.signal,
  });
  return true;
}

import { loadFileContent } from "@/github/githubClient";
import { mergeReaderPersonas, parseReaderPersona, type ReaderPersonaProfile } from "@/narrarium/readerPersona";
import { optionalRepositoryRead } from "@/repository/repositoryError";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

/** Built-in simulated readers merged with the book's `personas/*.md` overrides, in panel order. */
export async function loadReaderPersonas(input: { token: string; book: BookEntry; branch: string; structure: BookStructure }): Promise<ReaderPersonaProfile[]> {
  const overrides = await Promise.all(input.structure.readerPersonas.map(async (entry) => {
    const raw = await optionalRepositoryRead(() => loadFileContent(input.token, input.book.owner, input.book.repo, entry.path, input.branch)) ?? "";
    return raw ? parseReaderPersona(entry.slug, raw) : null;
  }));
  return mergeReaderPersonas(input.structure.language, overrides.filter((profile): profile is ReaderPersonaProfile => Boolean(profile)));
}

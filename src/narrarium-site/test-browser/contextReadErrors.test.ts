import { describe, expect, it } from "vitest";
import { RepositoryError } from "@/repository/repositoryError";

import { loadWriterContext } from "@/assistant/context";

const chapter = { slug: "001-start", path: "chapters/001-start", title: "Start", paragraphs: [{ number: "001", title: "One", path: "chapters/001-start/001-one.md" }] };
const structure = { title: "Book", defaultBranch: "main", loadedBranch: "main", globalWritingStylePath: "writing-style.md", plotPath: "plot.md", chapters: [chapter], characters: [], locations: [], factions: [], items: [], timelines: [], secrets: [], ghostwriters: [], readerPersonas: [], readerEvaluationFiles: [], operationManifestFiles: [], auditFiles: [], researchFiles: [], notesFiles: [] } as any;
const book = { id: "book", owner: "owner", repo: "repo", tokenIndex: null } as any;
const settings = { books: [book], defaultGitHubToken: "token" } as any;

describe("writer context repository errors", () => {
  it("ignores only confirmed 404s for optional context files", async () => {
    const read = async (_token: string, _owner: string, _repo: string, path: string) => {
      if (path === "writing-style.md" || path.startsWith("resumes/") || path.startsWith("evaluations/")) throw new RepositoryError("missing", "not-found", "read", 404);
      return `content:${path}`;
    };
    const context = await loadWriterContext("/app/books/book/chapters/001-start", settings, [book], { book: structure }, { book: "main" }, "main", read);
    expect(context.loadedFilePaths).toContain("chapters/001-start/chapter.md");
    expect(context.loadedFilePaths).not.toContain("writing-style.md");
  });

  it.each(["auth", "rate-limit", "network", "abort", "conflict", "malformed"] as const)("propagates optional %s failures", async (kind) => {
    const read = async () => { throw new RepositoryError(kind, kind, "read", kind === "auth" ? 401 : undefined); };
    await expect(loadWriterContext("/app/books/book/chapters/001-start", settings, [book], { book: structure }, { book: "main" }, "main", read)).rejects.toMatchObject({ kind });
  });

  it("propagates a required current-file 404", async () => {
    const read = async (_token: string, _owner: string, _repo: string, path: string) => {
      if (path === "chapters/001-start/001-one.md") throw new RepositoryError("missing", "not-found", "read", 404);
      if (path === "writing-style.md" || path.startsWith("resumes/") || path.startsWith("evaluations/")) throw new RepositoryError("missing", "not-found", "read", 404);
      return `content:${path}`;
    };
    await expect(loadWriterContext("/app/books/book/chapters/001-start/paragraphs/001", settings, [book], { book: structure }, { book: "main" }, "main", read)).rejects.toMatchObject({ kind: "not-found" });
  });
});

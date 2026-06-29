import { stringify } from "yaml";
import { createFileIfAbsent } from "@/github/githubClient";
import { chapterSlug, formatOrdinal, slugify } from "@/narrarium/canon";

function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}\n`;
}

function paragraphSlugFromPath(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

export async function createChapterDraftArtifacts(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: { number: number; title: string },
) {
  const slug = chapterSlug(input.number, input.title);
  const chapterId = `chapter:${slug}`;
  await createFileIfAbsent(
    token,
    owner,
    repo,
    branch,
    `drafts/${slug}/chapter.md`,
    renderMarkdown(
      {
        type: "chapter-draft",
        id: `draft:chapter:${slug}`,
        chapter: chapterId,
        number: input.number,
        title: input.title,
        canon: "draft",
      },
      `# ${input.title}\n\nStart the chapter draft here.\n`,
    ),
    `Add chapter draft ${slug}`,
  );

  for (const bucket of ["notes", "ideas", "promoted"] as const) {
    const title =
      bucket === "ideas"
        ? `Chapter Draft Ideas ${slug}`
        : bucket === "promoted"
          ? `Chapter Draft Promoted ${slug}`
          : `Chapter Draft Notes ${slug}`;
    await createFileIfAbsent(
      token,
      owner,
      repo,
      branch,
      `drafts/${slug}/${bucket}.md`,
      renderMarkdown(
        {
          type: "note",
          id: `note:chapter-draft:${bucket}:${slug}`,
          title,
          scope: "chapter-draft",
          bucket,
          chapter: chapterId,
        },
        `# ${title}\n\nKeep working material for this chapter draft here.\n`,
      ),
      `Add chapter draft ${bucket} ${slug}`,
    ).catch(() => undefined);
  }
}

export async function createChapterResumeArtifact(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: { chapterSlug: string },
) {
  await createFileIfAbsent(
    token,
    owner,
    repo,
    branch,
    `resumes/chapters/${input.chapterSlug}.md`,
    renderMarkdown(
      {
        type: "resume",
        id: `resume:chapter:${input.chapterSlug}`,
        title: `Resume ${input.chapterSlug}`,
      },
      "# Summary\n\nSummarize the chapter here.\n",
    ),
    `Add chapter resume ${input.chapterSlug}`,
  );
}

export async function createChapterEvaluationArtifact(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: { chapterSlug: string },
) {
  await createFileIfAbsent(
    token,
    owner,
    repo,
    branch,
    `evaluations/chapters/${input.chapterSlug}.md`,
    renderMarkdown(
      {
        type: "evaluation",
        id: `evaluation:chapter:${input.chapterSlug}`,
        title: `Evaluation ${input.chapterSlug}`,
      },
      "# Evaluation\n\nEvaluate the chapter here.\n",
    ),
    `Add chapter evaluation ${input.chapterSlug}`,
  );
}

export async function createParagraphDraftArtifact(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: { chapterSlug: string; number: number; title: string },
) {
  const slug = `${formatOrdinal(input.number)}-${slugify(input.title)}`;
  await createFileIfAbsent(
    token,
    owner,
    repo,
    branch,
    `drafts/${input.chapterSlug}/${slug}.md`,
    renderMarkdown(
      {
        type: "paragraph-draft",
        id: `draft:paragraph:${input.chapterSlug}:${slug}`,
        paragraph: `paragraph:${input.chapterSlug}:${slug}`,
        chapter: `chapter:${input.chapterSlug}`,
        number: input.number,
        title: input.title,
        canon: "draft",
      },
      "",
    ),
    `Add paragraph draft ${slug}`,
  );
}

export async function createParagraphScriptArtifact(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: { chapterSlug: string; number: number; title: string; location?: string },
) {
  const slug = `${formatOrdinal(input.number)}-${slugify(input.title)}`;
  await createFileIfAbsent(
    token,
    owner,
    repo,
    branch,
    `scripts/${input.chapterSlug}/${slug}.md`,
    renderMarkdown(
      {
        type: "script",
        id: `script:${input.chapterSlug}:${slug}`,
        chapter: `chapter:${input.chapterSlug}`,
        paragraph: `paragraph:${input.chapterSlug}:${slug}`,
        number: input.number,
        title: input.title,
        location: input.location,
        tags: [],
        secret_refs: [],
        character_refs: [],
        location_refs: [],
        item_refs: [],
        faction_refs: [],
        timeline_refs: [],
        reveal_policy: {},
      },
      `@scene_goal{Define the scene goal}\n@pov{character:todo}\nLocation: ${input.location ?? "todo"}\n[Plan the scene beats here]\n`,
    ),
    `Add script ${slug}`,
  );
}

export async function createParagraphEvaluationArtifact(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: { chapterSlug: string; paragraphPath: string },
) {
  const slug = paragraphSlugFromPath(input.paragraphPath);
  await createFileIfAbsent(
    token,
    owner,
    repo,
    branch,
    `evaluations/paragraphs/${input.chapterSlug}/${slug}.md`,
    renderMarkdown(
      {
        type: "evaluation",
        id: `evaluation:paragraph:${input.chapterSlug}:${slug}`,
        title: `Evaluation ${input.chapterSlug} ${slug}`,
        chapter: `chapter:${input.chapterSlug}`,
        paragraph: `paragraph:${input.chapterSlug}:${slug}`,
      },
      "# Paragraph Evaluation\n\nEvaluate the paragraph here.\n",
    ),
    `Add paragraph evaluation ${slug}`,
  );
}

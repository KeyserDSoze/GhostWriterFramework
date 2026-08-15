import { stringify } from "yaml";
import { createFileIfAbsent, createOrUpdateTextFile } from "@/github/githubClient";
import { chapterSlug, formatOrdinal, slugify } from "@/narrarium/canon";

function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}\n`;
}

function paragraphSlugFromPath(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

export function chapterDraftArtifactPaths(slug: string): [string, string, string, string] {
  return [
    `drafts/${slug}/chapter.md`,
    `drafts/${slug}/notes.md`,
    `drafts/${slug}/ideas.md`,
    `drafts/${slug}/promoted.md`,
  ];
}

async function writeWorkspaceFile(token: string, owner: string, repo: string, branch: string, path: string, content: string, message: string, replace = false) {
  if (replace) {
    await createOrUpdateTextFile(token, owner, repo, branch, path, content, message);
    return true;
  }
  return createFileIfAbsent(token, owner, repo, branch, path, content, message);
}

export async function createChapterDraftArtifacts(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: { number: number; title: string; chapterSlug?: string; body?: string; replace?: boolean },
) {
  const slug = input.chapterSlug ?? chapterSlug(input.number, input.title);
  const chapterId = `chapter:${slug}`;
  const [path, ...bucketPaths] = chapterDraftArtifactPaths(slug);
  const changedPaths: string[] = [];
  const primaryChanged = await writeWorkspaceFile(
    token,
    owner,
    repo,
    branch,
    path,
    renderMarkdown(
      {
        type: "chapter-draft",
        id: `draft:chapter:${slug}`,
        chapter: chapterId,
        number: input.number,
        title: input.title,
        canon: "draft",
      },
      input.body?.trim() || `# ${input.title}\n\nStart the chapter draft here.\n`,
    ),
    `Add chapter draft ${slug}`,
    input.replace,
  );
  if (primaryChanged) changedPaths.push(path);

  for (const [index, bucket] of (["notes", "ideas", "promoted"] as const).entries()) {
    const title =
      bucket === "ideas"
        ? `Chapter Draft Ideas ${slug}`
        : bucket === "promoted"
          ? `Chapter Draft Promoted ${slug}`
          : `Chapter Draft Notes ${slug}`;
    const bucketPath = bucketPaths[index];
    await createFileIfAbsent(
      token,
      owner,
      repo,
      branch,
      bucketPath,
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
    ).then((created) => { if (created) changedPaths.push(bucketPath); }).catch(() => undefined);
  }
  return { path, changedPaths };
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
  input: { chapterSlug: string; number: number; title: string; paragraphSlug?: string; body?: string; replace?: boolean },
) {
  const slug = input.paragraphSlug ?? `${formatOrdinal(input.number)}-${slugify(input.title)}`;
  await writeWorkspaceFile(
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
      input.body?.trim() ?? "",
    ),
    `Add paragraph draft ${slug}`,
    input.replace,
  );
  return `drafts/${input.chapterSlug}/${slug}.md`;
}

export async function createParagraphScriptArtifact(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  input: { chapterSlug: string; number: number; title: string; paragraphSlug?: string; location?: string; body?: string; replace?: boolean },
) {
  const artifact = buildParagraphScriptArtifact(input);
  await writeWorkspaceFile(token, owner, repo, branch, artifact.path, artifact.content, `Add script ${artifact.slug}`, input.replace);
  return artifact.path;
}

export function buildParagraphScriptArtifact(
  input: { chapterSlug: string; number: number; title: string; paragraphSlug?: string; location?: string; body?: string },
) {
  const slug = input.paragraphSlug ?? `${formatOrdinal(input.number)}-${slugify(input.title)}`;
  const path = `scripts/${input.chapterSlug}/${slug}.md`;
  const content = renderMarkdown(
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
      input.body?.trim() || `@scene_goal{Define the scene goal}\n@pov{character:todo}\nLocation: ${input.location ?? "todo"}\n[Plan the scene beats here]\n`,
    );
  return { path, content, slug };
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

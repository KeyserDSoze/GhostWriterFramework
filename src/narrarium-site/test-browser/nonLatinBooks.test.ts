import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const octokit = vi.hoisted(() => ({ getRepo: vi.fn(), getTree: vi.fn(), getContent: vi.fn(), graphql: vi.fn() }));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    rest = { repos: { get: octokit.getRepo, getContent: octokit.getContent }, git: { getTree: octokit.getTree } };
    graphql = octokit.graphql;
  },
}));

import { slugCode } from "narrarium/slug";
import i18n from "@/i18n";
import { loadBookStructure, reorderParagraphsInChapter } from "@/github/githubClient";
import { buildInitialBookFiles } from "@/narrarium/bookScaffold";
import { createCanonEntity, createChapter, createParagraphDocument, slugifyAny, type EntityKind } from "@/narrarium/canon";
import { createNote } from "@/narrarium/notes";
import { createParagraphDraftArtifact } from "@/narrarium/workspace";
import { emptyGhostwriter, serializeGhostwriter } from "@/narrarium/ghostwriter";
import { buildLocalBookStructure, listLocalFiles, putLocalRepository, removeLocalRepository, type LocalRepositoryMeta } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import type { BookStructure } from "@/types/book";
import { putCleanLocalFile } from "./helpers/localRepositorySeed";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const SECTIONS = ["characters", "locations", "factions", "items", "timelines", "secrets"] as const;
const KIND_OF: Record<(typeof SECTIONS)[number], EntityKind> = { characters: "character", locations: "location", factions: "faction", items: "item", timelines: "timeline-event", secrets: "secret" };

let repoIds: string[] = [];

afterEach(async () => {
  for (const id of repoIds) await removeLocalRepository(id, captureRepositoryOperationScope());
  repoIds = [];
  await i18n.changeLanguage("en");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  // A file that is not in the working copy is looked for on GitHub: say it is not there, and never reach out.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } })));
});

async function seedRepository(files: Record<string, string>): Promise<LocalRepositoryMeta> {
  const suffix = crypto.randomUUID();
  const repo = await putLocalRepository({ bookId: `book-${suffix}`, owner: "owner", repo: `repo-${suffix}`, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: new Date().toISOString(), cloneComplete: true }, captureRepositoryOperationScope());
  repoIds.push(repo.id);
  await Promise.all(Object.entries(files).map(([path, text]) => putCleanLocalFile({ repoId: repo.id, path, kind: "text", text, size: new TextEncoder().encode(text).byteLength })));
  return repo;
}

async function textFiles(repo: LocalRepositoryMeta): Promise<Record<string, string>> {
  return Object.fromEntries((await listLocalFiles(repo.id)).flatMap((file) => (file.kind === "text" && file.text !== undefined ? [[file.path, file.text] as const] : [])));
}

/** Serves these files the way GitHub does: the tree, book.md, and the frontmatter batch query. */
function serveFromGitHub(files: Record<string, string>, options: { graphql?: "works" | "fails" } = {}) {
  octokit.getRepo.mockResolvedValue({ data: { default_branch: "main" } });
  octokit.getTree.mockResolvedValue({ data: { tree: Object.entries(files).map(([path, text]) => ({ path, type: "blob", sha: `sha-${path}`, size: text.length })) } });
  octokit.getContent.mockImplementation(async ({ path }: { path: string }) => ({ data: { content: btoa(String.fromCharCode(...new TextEncoder().encode(files[path]))) } }));
  octokit.graphql.mockImplementation(async (query: string) => {
    if (options.graphql === "fails") throw new Error("Resource not accessible by personal access token");
    const repository: Record<string, { text: string } | null> = {};
    for (const match of query.matchAll(/(f\d+): object\(expression: ("(?:[^"\\]|\\.)*")\)/g)) {
      const path = (JSON.parse(match[2]) as string).slice("main:".length);
      repository[match[1]] = path in files ? { text: files[path] } : null;
    }
    return { repository };
  });
}

/** What the app shows of a book: its title, chapters with their scenes, the canon, the profiles and the notes. */
function outline(structure: BookStructure) {
  return {
    title: structure.title,
    language: structure.language,
    chapters: structure.chapters.map((chapter) => ({
      slug: chapter.slug,
      title: chapter.title,
      scenes: chapter.paragraphs.map((scene) => ({ number: scene.number, title: scene.title, file: scene.path.split("/").pop(), draft: scene.draftPath })),
    })),
    canon: Object.fromEntries(SECTIONS.map((section) => [section, structure[section].map((file) => ({ path: file.path, name: file.name }))])),
    ghostwriters: structure.ghostwriters.map((entry) => ({ slug: entry.slug, name: entry.name })),
    notes: structure.notesFiles.map((note) => ({ slug: note.slug.replace(/^\d{4}-\d{2}-\d{2}-/, ""), title: note.title })),
  };
}

async function readBack(repo: LocalRepositoryMeta, options: { graphql?: "works" | "fails" } = {}) {
  serveFromGitHub(await textFiles(repo), options);
  return { local: await buildLocalBookStructure(repo), github: await loadBookStructure("token", repo.owner, repo.repo) };
}

interface BookPlan {
  title: string;
  language: string;
  chapters: Array<{ title: string; scenes: string[] }>;
  canon: Record<EntityKind, string>;
  ghostwriter: string;
  note: string;
}

/** Makes a book with the functions the app itself uses to create chapters, scenes, canon, drafts, notes and profiles. */
async function createBook(plan: BookPlan): Promise<LocalRepositoryMeta> {
  const files: Record<string, string> = {};
  for (const file of buildInitialBookFiles({ title: plan.title, language: plan.language })) files[file.path] = file.content;
  const repo = await seedRepository(files);
  const target = [repo.owner, repo.repo, repo.branch] as const;
  for (const [chapterIndex, chapter] of plan.chapters.entries()) {
    const created = await createChapter("token", ...target, { number: chapterIndex + 1, title: chapter.title, summary: "…" });
    for (const [sceneIndex, scene] of chapter.scenes.entries()) await createParagraphDocument("token", ...target, { chapterSlug: created.slug, number: sceneIndex + 1, title: scene, body: "Text." });
    if (chapterIndex === 0) await createParagraphDraftArtifact("token", ...target, { chapterSlug: created.slug, number: 1, title: chapter.scenes[0] });
  }
  for (const [kind, label] of Object.entries(plan.canon) as Array<[EntityKind, string]>) await createCanonEntity("token", ...target, { kind, label });
  const ghostwriterSlug = slugifyAny(plan.ghostwriter, "ghostwriter", true);
  await putCleanLocalFile({ repoId: repo.id, path: `ghostwriters/${ghostwriterSlug}.md`, kind: "text", text: serializeGhostwriter({ slug: ghostwriterSlug, ...emptyGhostwriter(plan.ghostwriter) }), size: 1 });
  await createNote("token", ...target, { title: plan.note, body: "Idea." });
  return repo;
}

const CHINESE: BookPlan = {
  title: "海辺の町",
  language: "ja",
  chapters: [{ title: "海辺の朝", scenes: ["朝の港", "漁師の家"] }, { title: "夜の港", scenes: ["灯台"] }],
  canon: { character: "李明", location: "海辺の町", faction: "漁師組合", item: "古い鍵", secret: "沈んだ船", "timeline-event": "嵐の夜" },
  ghostwriter: "李明の声",
  note: "李明の日記",
};

const RUSSIAN: BookPlan = {
  title: "Тихая гавань",
  language: "ru",
  chapters: [{ title: "Тихая гавань", scenes: ["Утро в гавани", "Дом рыбака"] }, { title: "Ночная гавань", scenes: ["Маяк"] }],
  canon: { character: "Иван Петров", location: "Тихая гавань", faction: "Артель рыбаков", item: "Старая карта", secret: "Затонувшая лодка", "timeline-event": "Ночь шторма" },
  ghostwriter: "Тихая сестра",
  note: "Дневник Ивана",
};

/** What every new book starts with. */
const MAIN_TIMELINE = { path: "timelines/main.md", name: "Main Timeline" };
const DEFAULT_GHOSTWRITER = { slug: "default", name: "Default Ghostwriter" };

describe("a book made with the app in a script it cannot read letter by letter", () => {
  it("loads, lists and shows a Chinese book the same from the local copy and from GitHub", async () => {
    const repo = await createBook(CHINESE);
    const { local, github } = await readBack(repo);

    const code = (text: string) => slugCode(text);
    const expected = {
      title: "海辺の町",
      language: "ja",
      chapters: [
        { slug: "001-chapter", title: "海辺の朝", scenes: [{ number: "001", title: "朝の港", file: "001-scene.md", draft: "drafts/001-chapter/001-scene.md" }, { number: "002", title: "漁師の家", file: "002-scene.md", draft: undefined }] },
        { slug: "002-chapter", title: "夜の港", scenes: [{ number: "001", title: "灯台", file: "001-scene.md", draft: undefined }] },
      ],
      canon: {
        characters: [{ path: `characters/character-${code("李明")}.md`, name: "李明" }],
        locations: [{ path: `locations/location-${code("海辺の町")}.md`, name: "海辺の町" }],
        factions: [{ path: `factions/faction-${code("漁師組合")}.md`, name: "漁師組合" }],
        items: [{ path: `items/item-${code("古い鍵")}.md`, name: "古い鍵" }],
        timelines: [{ path: `timelines/events/timeline-event-${code("嵐の夜")}.md`, name: "嵐の夜" }, MAIN_TIMELINE],
        secrets: [{ path: `secrets/secret-${code("沈んだ船")}.md`, name: "沈んだ船" }],
      },
      ghostwriters: [DEFAULT_GHOSTWRITER, { slug: `ghostwriter-${code("李明の声")}`, name: "李明の声" }],
      notes: [{ slug: `note-${code("李明の日記")}`, title: "李明の日記" }],
    };
    expect(outline(local)).toEqual(expected);
    expect(outline(github)).toEqual(expected);
  });

  it("loads, lists and shows a Russian book the same from the local copy and from GitHub", async () => {
    const repo = await createBook(RUSSIAN);
    const { local, github } = await readBack(repo);

    const expected = {
      title: "Тихая гавань",
      language: "ru",
      chapters: [
        { slug: "001-tikhaya-gavan", title: "Тихая гавань", scenes: [{ number: "001", title: "Утро в гавани", file: "001-utro-v-gavani.md", draft: "drafts/001-tikhaya-gavan/001-utro-v-gavani.md" }, { number: "002", title: "Дом рыбака", file: "002-dom-rybaka.md", draft: undefined }] },
        { slug: "002-nochnaya-gavan", title: "Ночная гавань", scenes: [{ number: "001", title: "Маяк", file: "001-mayak.md", draft: undefined }] },
      ],
      canon: {
        characters: [{ path: "characters/ivan-petrov.md", name: "Иван Петров" }],
        locations: [{ path: "locations/tikhaya-gavan.md", name: "Тихая гавань" }],
        factions: [{ path: "factions/artel-rybakov.md", name: "Артель рыбаков" }],
        items: [{ path: "items/staraya-karta.md", name: "Старая карта" }],
        timelines: [{ path: "timelines/events/noch-shtorma.md", name: "Ночь шторма" }, MAIN_TIMELINE],
        secrets: [{ path: "secrets/zatonuvshaya-lodka.md", name: "Затонувшая лодка" }],
      },
      ghostwriters: [DEFAULT_GHOSTWRITER, { slug: "tikhaya-sestra", name: "Тихая сестра" }],
      notes: [{ slug: "dnevnik-ivana", title: "Дневник Ивана" }],
    };
    expect(outline(local)).toEqual(expected);
    expect(outline(github)).toEqual(expected);
  });

  it("opens every file the app created from the name it listed", async () => {
    const repo = await createBook(CHINESE);
    const files = await textFiles(repo);
    const { local } = await readBack(repo);
    for (const chapter of local.chapters) {
      expect(files[`${chapter.path}/chapter.md`], chapter.slug).toContain(`title: ${chapter.title}`);
      for (const scene of chapter.paragraphs) expect(files[scene.path], scene.path).toContain(`title: ${scene.title}`);
    }
    for (const section of SECTIONS) for (const file of local[section]) expect(files[file.path], file.path).toMatch(new RegExp(`^(?:name|title): ${file.name}$`, "m"));
    expect(files["book.md"]).toContain("title: 海辺の町");
  });
});

describe("folders and files the author named with Unicode letters", () => {
  const frontmatter = (fields: Record<string, string | number>) => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n\nText.\n`;
  const FILES: Record<string, string> = {
    "book.md": frontmatter({ type: "book", id: "book", title: "Два языка", language: "ru" }),
    "chapters/001-глава-первая/chapter.md": frontmatter({ type: "chapter", id: "chapter:001-глава-первая", title: "Глава первая" }),
    "chapters/001-глава-первая/001-тихая-гавань.md": frontmatter({ type: "paragraph", number: 1, title: "Тихая гавань" }),
    "chapters/001-глава-первая/002-ночной-порт.md": frontmatter({ type: "paragraph", number: 2, title: "Ночной порт" }),
    "chapters/002-海辺の朝/chapter.md": frontmatter({ type: "chapter", id: "chapter:002-海辺の朝", title: "海辺の朝" }),
    "chapters/002-海辺の朝/001-朝の港.md": frontmatter({ type: "paragraph", number: 1, title: "朝の港" }),
    "drafts/002-海辺の朝/001-朝の港.md": frontmatter({ type: "paragraph-draft", number: 1, title: "朝の港" }),
    "scripts/002-海辺の朝/001-朝の港.md": frontmatter({ type: "script", number: 1, title: "朝の港" }),
    "characters/李明.md": frontmatter({ type: "character", name: "李明" }),
    "characters/иван.md": frontmatter({ type: "character", name: "Иван" }),
    "locations/海辺の町.md": frontmatter({ type: "location", name: "海辺の町" }),
    "timelines/events/буря.md": frontmatter({ type: "timeline-event", title: "Буря" }),
    "ghostwriters/автор.md": frontmatter({ type: "ghostwriter", name: "Автор" }),
    "notes/2026-11-21-идея.md": frontmatter({ type: "note", title: "Идея" }),
  };

  it("are listed with their own names, from the local copy and from GitHub", async () => {
    const repo = await seedRepository(FILES);
    const { local, github } = await readBack(repo);
    const expected = {
      title: "Два языка",
      language: "ru",
      chapters: [
        { slug: "001-глава-первая", title: "Глава первая", scenes: [{ number: "001", title: "Тихая гавань", file: "001-тихая-гавань.md", draft: undefined }, { number: "002", title: "Ночной порт", file: "002-ночной-порт.md", draft: undefined }] },
        { slug: "002-海辺の朝", title: "海辺の朝", scenes: [{ number: "001", title: "朝の港", file: "001-朝の港.md", draft: "drafts/002-海辺の朝/001-朝の港.md" }] },
      ],
      canon: {
        characters: [{ path: "characters/иван.md", name: "Иван" }, { path: "characters/李明.md", name: "李明" }],
        locations: [{ path: "locations/海辺の町.md", name: "海辺の町" }],
        factions: [],
        items: [],
        timelines: [{ path: "timelines/events/буря.md", name: "Буря" }],
        secrets: [],
      },
      ghostwriters: [{ slug: "автор", name: "Автор" }],
      notes: [{ slug: "идея", title: "Идея" }],
    };
    for (const structure of [local, github]) {
      const seen = outline(structure);
      expect({ ...seen, canon: { ...seen.canon, characters: [...seen.canon.characters].sort((a, b) => a.path.localeCompare(b.path)) } }).toEqual(expected);
    }
    expect(local.chapters[1].paragraphs[0].scriptPath).toBe("scripts/002-海辺の朝/001-朝の港.md");
    expect(github.chapters[1].paragraphs[0].scriptPath).toBe("scripts/002-海辺の朝/001-朝の港.md");
  });

  it("keep the chapter in reading order by its number", async () => {
    const repo = await seedRepository({ ...FILES, "chapters/010-десятая/chapter.md": frontmatter({ title: "Десятая" }), "chapters/003-三/chapter.md": frontmatter({ title: "三" }) });
    const { local, github } = await readBack(repo);
    expect(local.chapters.map((chapter) => chapter.slug)).toEqual(["001-глава-первая", "002-海辺の朝", "003-三", "010-десятая"]);
    expect(github.chapters.map((chapter) => chapter.slug)).toEqual(local.chapters.map((chapter) => chapter.slug));
  });
});

describe("a chapter folder with the fallback name shows the title from its file", () => {
  const files = (titled: boolean) => ({
    "book.md": "---\ntype: book\nid: book\ntitle: 海辺の町\n---\n",
    "chapters/001-chapter/chapter.md": titled ? "---\ntype: chapter\ntitle: 海辺の朝\n---\n" : "---\ntype: chapter\n---\n",
    "chapters/001-chapter/001-scene.md": titled ? "---\ntype: paragraph\ntitle: 朝の港\n---\n" : "---\ntype: paragraph\n---\n",
    "chapters/001-chapter/002-scene.md": titled ? "---\ntype: paragraph\ntitle: 漁師の家\n---\n" : "---\ntype: paragraph\n---\n",
    "chapters/012-chapter/chapter.md": titled ? "---\ntype: chapter\ntitle: 夜の港\n---\n" : "---\ntype: chapter\n---\n",
    "characters/character-0crj2m.md": titled ? "---\ntype: character\nname: 李明\n---\n" : "---\ntype: character\n---\n",
    "locations/location-1abcde.md": titled ? "---\ntype: location\nname: 海辺の町\n---\n" : "---\ntype: location\n---\n",
    "timelines/events/timeline-event-0crj2m.md": titled ? "---\ntype: timeline-event\ntitle: 嵐の夜\n---\n" : "---\ntype: timeline-event\n---\n",
    "research/2026-11-21-research-0crj2m.md": titled ? "---\ntype: research\ntitle: 罗马水道的建造\n---\n" : "---\ntype: research\n---\n",
  });
  const titles = (structure: BookStructure) => ({
    chapters: structure.chapters.map((chapter) => chapter.title),
    scenes: structure.chapters[0].paragraphs.map((scene) => scene.title),
    canon: [...structure.characters, ...structure.locations, ...structure.timelines].map((file) => file.name),
  });

  it("never shows 'Chapter' or 'Scene' when the file has a title", async () => {
    const repo = await seedRepository(files(true));
    const { local, github } = await readBack(repo);
    const real = { chapters: ["海辺の朝", "夜の港"], scenes: ["朝の港", "漁師の家"], canon: ["李明", "海辺の町", "嵐の夜"] };
    expect(titles(local)).toEqual(real);
    expect(titles(github)).toEqual(real);
  });

  it("shows a numbered, neutral label in the language of the app when the file has no title, never the raw code", async () => {
    const repo = await seedRepository(files(false));
    for (const [language, labels] of [
      ["en", { chapters: ["Chapter 1", "Chapter 12"], scenes: ["Scene 1", "Scene 2"], canon: ["Character", "Location", "Timeline event"] }],
      ["it", { chapters: ["Capitolo 1", "Capitolo 12"], scenes: ["Scena 1", "Scena 2"], canon: ["Personaggio", "Luogo", "Evento timeline"] }],
    ] as const) {
      await i18n.changeLanguage(language);
      const { local, github } = await readBack(repo);
      expect(titles(local), language).toEqual(labels);
      expect(titles(github), language).toEqual(labels);
    }
  });

  it("shows a research document by the title in its file, or by its date, never by its code", async () => {
    const titled = await readBack(await seedRepository(files(true)));
    expect(titled.local.researchFiles.map((file) => file.title)).toEqual(["罗马水道的建造"]);
    // The titles of research documents are not part of the batch GitHub is asked for: the research page reads them from the files.
    expect(titled.github.researchFiles.map((file) => file.title)).toEqual(["Research 2026-11-21"]);

    const untitled = await readBack(await seedRepository(files(false)));
    expect(untitled.local.researchFiles.map((file) => file.title)).toEqual(["Research 2026-11-21"]);
    expect(untitled.github.researchFiles.map((file) => file.title)).toEqual(["Research 2026-11-21"]);
    await i18n.changeLanguage("it");
    expect((await buildLocalBookStructure(await seedRepository(files(false)))).researchFiles.map((file) => file.title)).toEqual(["Ricerca 2026-11-21"]);
  });

  it("shows the labels too when GitHub cannot give the titles of the files in a batch", async () => {
    const repo = await seedRepository(files(true));
    const { github } = await readBack(repo, { graphql: "fails" });
    expect(titles(github)).toEqual({ chapters: ["Chapter 1", "Chapter 12"], scenes: ["Scene 1", "Scene 2"], canon: ["Character", "Location", "Timeline event"] });
  });

  it("keeps the readable title made from the name of a Latin file", async () => {
    const repo = await seedRepository({
      "book.md": "---\ntype: book\nid: book\ntitle: The Glass Harbor\n---\n",
      "chapters/001-the-gate/chapter.md": "---\ntype: chapter\n---\n",
      "chapters/001-the-gate/001-at-the-gate.md": "---\ntype: paragraph\n---\n",
      "chapters/1000-the-end/chapter.md": "---\ntype: chapter\n---\n",
      "characters/lyra-vale.md": "---\ntype: character\n---\n",
      "ghostwriters/night-owl.md": "---\ntype: ghostwriter\n---\n",
    });
    const { local, github } = await readBack(repo);
    for (const structure of [local, github]) {
      expect(structure.chapters.map((chapter) => chapter.title)).toEqual(["The Gate", "The End"]);
      expect(structure.chapters[0].paragraphs.map((scene) => scene.title)).toEqual(["At The Gate"]);
      expect(structure.ghostwriters.map((entry) => entry.name)).toEqual(["Night Owl"]);
    }
    expect(local.characters.map((file) => file.name)).toEqual(["Lyra Vale"]);
  });

  it("does not touch a real title that happens to read like the label", async () => {
    const repo = await seedRepository({ "chapters/001-chapter/chapter.md": "---\ntitle: Chapter\n---\n", "chapters/001-chapter/001-scene.md": "---\ntitle: Scene\n---\n" });
    const { local, github } = await readBack(repo);
    for (const structure of [local, github]) {
      expect(structure.chapters[0].title).toBe("Chapter");
      expect(structure.chapters[0].paragraphs[0].title).toBe("Scene");
    }
  });
});

describe("reordering the scenes of a chapter written in another script", () => {
  it("keeps the title of each scene, and numbers again the label of a scene that has no title", async () => {
    const repo = await seedRepository({
      "chapters/001-chapter/chapter.md": "---\ntype: chapter\ntitle: 海辺の朝\n---\n",
      "chapters/001-chapter/001-scene.md": "---\ntype: paragraph\ntitle: 朝の港\nnumber: 1\n---\n",
      "chapters/001-chapter/002-scene.md": "---\ntype: paragraph\ntitle: 漁師の家\nnumber: 2\n---\n",
      "chapters/001-chapter/003-scene.md": "---\ntype: paragraph\nnumber: 3\n---\n",
    });
    const before = (await buildLocalBookStructure(repo)).chapters[0].paragraphs;
    expect(before.map((scene) => scene.title)).toEqual(["朝の港", "漁師の家", "Scene 3"]);

    const outcome = await reorderParagraphsInChapter("token", repo.owner, repo.repo, repo.branch, "chapters/001-chapter", before, [before[2], before[0], before[1]]);
    expect(outcome.paragraphs.map((scene) => [scene.number, scene.title, scene.path])).toEqual([
      ["001", "Scene 1", "chapters/001-chapter/001-scene.md"],
      ["002", "朝の港", "chapters/001-chapter/002-scene.md"],
      ["003", "漁師の家", "chapters/001-chapter/003-scene.md"],
    ]);
    expect((await buildLocalBookStructure(repo)).chapters[0].paragraphs.map((scene) => scene.title)).toEqual(["Scene 1", "朝の港", "漁師の家"]);
  });
});

import {
  CONTEXT_FILE,
  DIRECTOR_FILE,
  EVALUATION_GUIDELINES_FILE,
  STORY_DESIGN_FILE,
  countWords,
  defaultDirector,
  designText,
  directorPrompt,
  evaluationStyleBlock,
  ghostwriterPrompt,
  isThinDocument,
  isValidGhostwriterSlug,
  mergeReaderPersonas,
  parseDirector,
  parseEvaluationStyle,
  parseGhostwriter,
  parseMarkdown,
  parseOutline,
  parseReaderPersona,
  type BookStore,
  type EstimateContext,
} from "narrarium-engine";

/**
 * What the estimate of a run needs to know of a book, as far as its files say it. The estimate is made without any of it too (with typical
 * sizes, and the engine says what it assumed): everything here is optional, and what cannot be read is left out, never made up.
 */
export interface EstimateBook {
  /** The files of the book could be read here. A book whose working copy this browser does not have cannot be. */
  read: boolean;
  /** The most rounds of review a chapter gets, as the director of the book says (the default director's when the book has none). */
  directorRounds?: number;
  /** The book has its own `director.md`. */
  directorFile: boolean;
  /** The words the files weigh as the prompts carry them: only the ones the book has, the engine's typical size for the others. */
  context: Pick<EstimateContext, "designWords" | "worldWords" | "ghostwriterWords" | "directorWords" | "styleWords" | "chapterDesignWords">;
  /** The author wrote the story design: the autopilot does not start with its concept. */
  designWritten: boolean;
  /** The readers of the panel the director does not ignore. */
  readerPanelSize?: number;
  /** The entries of the author's outline: how many, the last chapter one asks for and their words. Absent when the author wrote none. */
  outline?: { entries: number; lastChapter: number; words: number };
}

export interface EstimateBookInput {
  store: Pick<BookStore, "read"> & Partial<Pick<BookStore, "readMany">>;
  /** The files of `outline/`, read as one folder (not entry by entry, nor through the list of every file of the book). */
  outlineFiles: () => Promise<ReadonlyArray<{ path: string; content: string; hash?: string }>>;
  language?: string;
  /** The ghostwriter `book.md` names. */
  ghostwriter?: string;
  /** The slugs of `ghostwriters/*.md`, in the order the book lists them. */
  ghostwriterSlugs: readonly string[];
  /** The paths of `personas/*.md`. */
  personaPaths: readonly string[];
}

const UNREAD: EstimateBook = { read: false, directorFile: false, context: {}, designWritten: false };

/** The ghostwriter the writer uses, as the engine chooses it when no chapter or scene names another: the book's, else `default`, else the first. */
function ghostwriterOf(named: string | undefined, slugs: readonly string[]): string | undefined {
  if (named && isValidGhostwriterSlug(named)) return named;
  const slug = slugs.includes("default") ? "default" : slugs[0];
  return slug && isValidGhostwriterSlug(slug) ? slug : undefined;
}

async function readAll(store: EstimateBookInput["store"], paths: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(paths)];
  const files = store.readMany ? await store.readMany(wanted) : (await Promise.all(wanted.map((path) => store.read(path)))).filter((file) => file !== null);
  return new Map(files.map((file) => [file.path, file.content]));
}

async function readOutline(input: EstimateBookInput): Promise<{ outline?: EstimateBook["outline"]; chapterDesignWords?: number }> {
  try {
    const parsed = await parseOutline(await input.outlineFiles());
    // The design of a chapter, whoever wrote it, is what the writing steps read of it: its size on average among the entries that have one.
    const designed = parsed.chapters.filter((entry) => entry.design);
    const chapterDesignWords = designed.length ? Math.round(designed.reduce((total, entry) => total + countWords(designText(entry.design, 100_000)), 0) / designed.length) : 0;
    // The entries the autopilot wrote and nobody changed since are its own: they bind nothing, and they are not the author's outline. The empty ones it made with
    // no digest (a new book of a given size, the chapters a design adds) are the chapters of the book all the same: they give its length.
    const author = parsed.chapters.filter((entry) => !entry.intact || (!entry.digest && !entry.title && !entry.body.trim() && !entry.ghostwriter && !entry.design));
    if (author.length === 0) return chapterDesignWords ? { chapterDesignWords } : {};
    // The description of the book is the idea, which the estimate takes from the brief: it is not counted again among the outline's words.
    return {
      outline: {
        entries: author.length,
        lastChapter: author.reduce((last, entry) => Math.max(last, entry.number), 0),
        words: author.reduce((total, entry) => total + countWords(`${entry.title} ${entry.body}`.trim()), 0),
      },
      ...(chapterDesignWords ? { chapterDesignWords } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Reads the few files of a book that the prompts of the autopilot carry, in one batch, and the outline as a folder: the director (its rounds of
 * review and its weight), the story design and the world context, the ghostwriter, the evaluation style and the readers of the panel. A
 * story design or a world context that is still the scaffold is the one the concept writes first, so its size is the engine's typical one.
 */
export async function readEstimateBook(input: EstimateBookInput): Promise<EstimateBook> {
  const { language } = input;
  const slug = ghostwriterOf(input.ghostwriter, input.ghostwriterSlugs);
  const paths = [DIRECTOR_FILE, STORY_DESIGN_FILE, CONTEXT_FILE, EVALUATION_GUIDELINES_FILE, ...(slug ? [`ghostwriters/${slug}.md`] : []), ...input.personaPaths];
  let files: Map<string, string>;
  try {
    files = await readAll(input.store, paths);
  } catch {
    return { ...UNREAD, context: {} };
  }
  const context: EstimateBook["context"] = {};

  const directorText = files.get(DIRECTOR_FILE);
  const director = directorText === undefined ? defaultDirector(language) : parseDirector(directorText, language);
  if (directorText !== undefined) context.directorWords = countWords(directorPrompt(director));

  const design = files.get(STORY_DESIGN_FILE);
  const designBody = design === undefined ? "" : parseMarkdown(design).body;
  const designWritten = design !== undefined && !isThinDocument(designBody);
  if (designWritten) context.designWords = countWords(designBody);

  const world = files.get(CONTEXT_FILE);
  const worldBody = world === undefined ? "" : parseMarkdown(world).body;
  if (world !== undefined && !isThinDocument(worldBody)) context.worldWords = countWords(worldBody);

  const ghostwriter = slug ? files.get(`ghostwriters/${slug}.md`) : undefined;
  if (slug && ghostwriter !== undefined) context.ghostwriterWords = countWords(ghostwriterPrompt(parseGhostwriter(slug, ghostwriter)));

  const style = files.get(EVALUATION_GUIDELINES_FILE);
  if (style !== undefined) context.styleWords = countWords(evaluationStyleBlock(parseEvaluationStyle(style), { criteria: true }));

  const overrides = input.personaPaths.flatMap((path) => {
    const text = files.get(path);
    return text === undefined ? [] : [parseReaderPersona(path.slice("personas/".length, -".md".length), text)];
  });
  const panel = mergeReaderPersonas(language, overrides);
  const readerPanelSize = panel.filter((reader) => reader.enabled && (director.readerWeights[reader.slug] ?? 1) > 0).length;

  const { outline, chapterDesignWords } = await readOutline(input);
  if (chapterDesignWords) context.chapterDesignWords = chapterDesignWords;
  return { read: true, directorRounds: director.maxReviewRounds, directorFile: directorText !== undefined, context, designWritten, readerPanelSize, ...(outline ? { outline } : {}) };
}

import type { AiPort, AiRequest, AiResponse } from "../ai/types.js";
import { DESIGN_CRITERIA } from "../autopilot/design-review-types.js";
import { BookConflictError, type BookCommitResult, type BookFileChange, type BookFileContent, type BookFileEntry, type BookStore } from "../book/store.js";
import { sha256Hex } from "../util/hash.js";

/** In-memory `BookStore` with the same compare-and-swap rules as the real hosts. */
export class MemoryBookStore implements BookStore {
  readonly files = new Map<string, string>();
  readonly commits: Array<{ message: string; paths: string[] }> = [];
  /** Optional hook to simulate concurrent edits right before a commit is validated. */
  beforeCommit?: (changes: BookFileChange[]) => void | Promise<void>;
  /** The hash of a file is computed once per content, like a real host that keeps it with the file. */
  private readonly hashes = new Map<string, { content: string; hash: string }>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
  }

  private async hashOf(path: string, content: string): Promise<string> {
    const known = this.hashes.get(path);
    if (known?.content === content) return known.hash;
    const hash = await sha256Hex(content);
    this.hashes.set(path, { content, hash });
    return hash;
  }

  async list(): Promise<BookFileEntry[]> {
    const entries = await Promise.all([...this.files.entries()].map(async ([path, content]) => ({ path, hash: await this.hashOf(path, content) })));
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(path: string): Promise<BookFileContent | null> {
    const content = this.files.get(path);
    return content === undefined ? null : { path, content, hash: await this.hashOf(path, content) };
  }

  async readMany(paths: string[]): Promise<BookFileContent[]> {
    const files: BookFileContent[] = [];
    for (const path of new Set(paths)) {
      const file = await this.read(path);
      if (file) files.push(file);
    }
    return files;
  }

  async commit(changes: BookFileChange[], message: string): Promise<BookCommitResult> {
    await this.beforeCommit?.(changes);
    for (const change of changes) {
      if (change.expectedHash === undefined) continue;
      const current = this.files.get(change.path);
      const hash = current === undefined ? null : await this.hashOf(change.path, current);
      if (hash !== change.expectedHash) throw new BookConflictError(`File changed since it was read: ${change.path}`, change.path);
    }
    for (const change of changes) {
      if (change.content === null) {
        this.files.delete(change.path);
        this.hashes.delete(change.path);
      } else this.files.set(change.path, change.content);
    }
    this.commits.push({ message, paths: changes.map((change) => change.path) });
    return { revision: String(this.commits.length) };
  }

  /** Direct write that bypasses CAS, to simulate an author editing the book. */
  write(path: string, content: string | null): void {
    if (content === null) {
      this.files.delete(path);
      this.hashes.delete(path);
    } else this.files.set(path, content);
  }

  toObject(): Record<string, string> {
    return Object.fromEntries([...this.files.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }
}

/** Minimal Narrarium book, like the one the web app scaffolds. */
/** The outline entries of `count` chapters, as the author writes them: a title and what happens, no ghostwriter, origin `author`. */
export function outlineEntryFiles(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return [`outline/chapters/${String(number).padStart(3, "0")}.md`, `---\ntype: outline-chapter\nid: outline-chapter:${String(number).padStart(3, "0")}\nnumber: ${number}\ntitle: Chapter Title ${number}\norigin: author\n---\n\nEvent ${number} happens and the story turns.\n`];
  }));
}

export function seedBookFiles(input: { title?: string; language?: string; chapters?: number } = {}): Record<string, string> {
  const title = input.title ?? "The Glass Harbor";
  const language = input.language ?? "en";
  return {
    ...(input.chapters ? outlineEntryFiles(input.chapters) : {}),
    "book.md": `---\ntype: book\nid: book\ntitle: ${title}\nlanguage: ${language}\ncanon: draft\nghostwriter: default\n---\n\n# Book\n\nDescribe the book here.\n`,
    "context.md": "---\ntype: context\nid: context:book\ntitle: Book Context\n---\n\n# Historical And Temporal Frame\n\n- Record the time period.\n",
    "story-design.md": "---\ntype: note\nid: note:story-design\ntitle: Story Design\nscope: story-design\nbucket: story-design\n---\n\n# Story Design\n\n## Premise\n\n## Main Conflict\n\n## Character Arcs\n\n## Structure\n",
    "plot.md": "---\ntype: plot\nid: plot:main\ntitle: Story Plot\n---\n\n# Plot Overview\n\nNo chapters yet.\n",
    "resumes/total.md": "---\ntype: resume\nid: resume:total\ntitle: Total Resume\n---\n\n# Book So Far\n\nKeep an up-to-date summary of the entire book here.\n",
    "ghostwriters/default.md": "---\ntype: ghostwriter\nid: ghostwriter:default\nname: Default Ghostwriter\nlanguage: English\ntone: Natural\ntemperature: 0.8\n---\n\nWrite clean, professional narrative prose.\n",
  };
}

export interface FakeAiOptions {
  /** Chapters returned by the plan schema (default: as many as requested, else 2). */
  chapters?: number;
  /** Scenes returned by the scene-plan schema (default 2). */
  scenes?: number;
  /** Words of every prose reply (default 220). */
  words?: number;
  /** Director verdict per review round (default: revise in round 1, approve later). */
  reviewVerdict?: (round: number) => "approve" | "revise";
  /** Delay of every reply, to test interruptions (ms). */
  delayMs?: number;
  /** Fail the n-th call (1-based) with this error. */
  failOn?: { call: number; error: Error };
  /** The director's review of a design, by the number of the review (default: approve at 8 with nothing to change). */
  designReview?: (round: number, user: string) => Record<string, unknown>;
  /** The director's corrections of the whole book (a review of the book in a book-level round), by the number of the request (default: one correction of chapter 1, citing the first point). */
  bookCorrections?: (call: number, user: string) => Record<string, unknown>;
  /** The reply of a wildcard of the room, by its name (default: two ideas, or two findings for a sentinel, about the chapter it reads). */
  wildcardIdeas?: (name: string, user: string) => unknown;
  /** The Director's triage of the room's ideas, by their ids (default: the first adopted, the second adapted, the others rejected). */
  wildcardTriage?: (ids: string[], user: string) => unknown;
  /** The reply to a request, before the defaults (return `undefined` to leave it to them): a test says what a step gets. */
  answer?: (request: AiRequest) => unknown;
  /**
   * The score of the twelve criteria of the rubric of a design (`subject`: `design` for the director, `reader:<slug>`; `round`: the number of the review), a number for
   * all of them or one by criterion (default 7.5). Added to every reply that asks for the rubric and has none.
   */
  designRubric?: (subject: string, round: number) => number | Record<string, number>;
  /** The scores of the criteria of the chapters the review of a design judges (`chapter` and the number of the review), as `designRubric`: a number for all, or one by criterion (default 7.5). */
  chapterRubric?: (chapter: number, round: number) => number | Record<string, number>;
  /** The scores of the criteria of a pitch (`id`: p1, p2…) by whom judges it (`director`, or the slug of a reader), as `designRubric` (default: the higher the number of the pitch, the higher the score). */
  pitchRubric?: (id: string, by: string) => number | Record<string, number>;
  /** The pitch the director recommends, among the ids (default: the one with the highest mean of the director's scores, the last of equals). */
  pitchRecommend?: (ids: string[]) => string;
}

const FAKE_PITCHES: ReadonlyArray<{ title: string; logline: string; premise: string; protagonist: string; stakes: string; twist: string; tone: string }> = [
  { title: "The Tide Ledger", logline: "A glassmaker's daughter finds the ledger that proves the sea wall was never mended.", premise: "Mira inherits a workshop and a book of accounts that does not add up.", protagonist: "Mira Vale wants her father's name cleared and fears the harbor's silence.", stakes: "The town floods if the wall stays hidden.", twist: "Her father kept the second set of books.", tone: "Melancholic and tense." },
  { title: "A Harbor of Mirrors", logline: "Every window of a town of glassmakers reflects a street that does not exist.", premise: "Orrin Hale, the harbor master, notices a second town in the mirrors.", protagonist: "Orrin Hale wants control of the lights and fears being seen.", stakes: "The reflected town replaces the real one.", twist: "The reflection is the older town, drowned.", tone: "Uncanny, patient." },
  { title: "The Lighthouse Debt", logline: "The light that keeps the ships away from the rocks is owed to someone who wants it back.", premise: "A council pledged the lighthouse for a loan that comes due at the next spring tide.", protagonist: "The keeper's apprentice wants to be believed and fears the dark.", stakes: "Ships wreck on a darkened coast.", twist: "The lender is the sea itself, in a person's shape.", tone: "Fable-like, dry humour." },
  { title: "Salt and Silence", logline: "Three sisters who stopped speaking must cross a flooded town to bury their mother.", premise: "A funeral procession by boat through streets under water.", protagonist: "The eldest sister wants to be forgiven and fears she is right.", stakes: "The family house, and what is left of them.", twist: "The mother is not in the coffin.", tone: "Quiet, bitter, tender." },
  { title: "The Glass Cartographer", logline: "A mapmaker draws the coast in glass, and the coast starts to follow the map.", premise: "Maps made of glass change the shore they describe.", protagonist: "Ines wants a map that never lies and fears the one she drew.", stakes: "Every town on the map.", twist: "The first map was a warning, not a copy.", tone: "Wondering, ominous." },
  { title: "Low Water", logline: "The tide stops coming in, and the town finds out what it was built on.", premise: "A harbor with no water reveals its foundations.", protagonist: "A diver wants a last job and fears the bottom.", stakes: "The founding story of the town.", twist: "The town was built on a ship.", tone: "Eerie, elegiac." },
];


/** The rubric of a reply: the twelve criteria with their scores (a number for all, or one by criterion), the weak ones with an issue and a proposal. */
export function fakeRubric(scores: number | Record<string, number> = 7.5, options: { applicable?: boolean } = {}): Array<Record<string, unknown>> {
  return DESIGN_CRITERIA.map((criterion) => {
    const score = typeof scores === "number" ? scores : scores[criterion] ?? 7.5;
    return {
      criterion,
      ...(options.applicable ? { applicable: true } : {}),
      score,
      reason: `A fair ${criterion}.`,
      issues: score < 7 ? [`The ${criterion} is weak.`] : [],
      proposals: score < 7 ? [`Strengthen the ${criterion}.`] : [],
    };
  });
}

function prose(words: number, seed: string): string {
  const vocabulary = ["the", "harbor", "light", "glass", "she", "walked", "slowly", "toward", "silent", "boats", "while", "wind", "carried", "salt", "and", "memory", "across", "stone", "steps", "of", "old", "town"];
  const output: string[] = [];
  for (let index = 0; index < words; index += 1) output.push(vocabulary[(index * 7 + seed.length) % vocabulary.length]);
  const sentences: string[] = [];
  for (let index = 0; index < output.length; index += 12) {
    const sentence = output.slice(index, index + 12).join(" ");
    sentences.push(sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".");
  }
  return sentences.join(" ");
}

function requestedRange(user: string): [number, number] | null {
  const match = /numbered (\d+) to (\d+)/.exec(user) ?? /chapters (\d+)-(\d+)/.exec(user);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function firstQuote(user: string): string {
  const scene = /=== SCENE 1:[^\n]*\n([^\n]{30,})/.exec(user)?.[1] ?? "";
  return scene.slice(0, 40);
}

/** Deterministic AI answering every autopilot and director schema, for tests and demos. */
export function createFakeAutopilotAi(options: FakeAiOptions = {}): AiPort & { calls: AiRequest[] } {
  const calls: AiRequest[] = [];
  const respond = (request: AiRequest): unknown => {
    const custom = options.answer?.(request);
    const reply = custom !== undefined ? custom : answerOf(request);
    const properties = (request.json?.parameters?.properties ?? {}) as Record<string, unknown>;
    if (reply && typeof reply === "object" && !Array.isArray(reply) && "rubric" in properties && !("rubric" in reply)) {
      const slug = /^autopilot:plan-reader:(.+)$/.exec(request.label)?.[1];
      const round = Number(/review (\d+) of at most/.exec(request.user)?.[1] ?? "1");
      const asked = options.designRubric?.(slug ? `reader:${slug}` : "design", round) ?? 7.5;
      return { ...reply, rubric: fakeRubric(asked) };
    }
    return reply;
  };
  const answerOf = (request: AiRequest): unknown => {
    const user = request.user;
    switch (request.json?.name) {
      case "book_concept":
        return {
          logline: "A glassmaker's daughter must expose the harbor's oldest lie before the tide takes the town.",
          premise: "In a harbor town built on glass, Mira discovers the lighthouse keeps a secret.",
          themes: ["truth", "inheritance"],
          tone: "Melancholic, tense",
          conflict: "Mira against the council that profits from the lie.",
          storyDesign: "# Story Design\n\n## Premise\n\nMira, a glassmaker's daughter, uncovers the harbor's oldest lie.\n\n## Main Conflict\n\nThe council hides the failing sea wall.\n\n## Character Arcs\n\nMira learns to speak.\n\n## Structure\n\nThree movements.",
          context: "# World\n\nA cold northern harbor in an age of sail, where glass is the only trade that matters and the council controls the light.",
          characters: [
            { name: "Mira Vale", roleTier: "main", storyRole: "protagonist", description: "A stubborn young glassmaker.", desire: "The truth", fear: "Silence", arc: "From silence to voice", voice: "Short, exact sentences" },
            { name: "Orrin Hale", roleTier: "main", storyRole: "antagonist", description: "The harbor master.", desire: "Control", fear: "Exposure", arc: "Falls", voice: "Smooth and patient" },
          ],
          locations: [{ name: "Glass Harbor", description: "A town of glass workshops.", atmosphere: "Cold light" }],
          factions: [],
          secrets: [{ title: "The Wall Is Failing", truth: "The sea wall cracked years ago.", holders: ["Orrin Hale"], stakes: "The town floods", revealChapter: 2 }],
        };
      case "chapter_plan": {
        const range = requestedRange(user);
        const count = options.chapters ?? (range ? range[1] - range[0] + 1 : 2);
        const start = range ? range[0] : 1;
        return {
          chapters: Array.from({ length: count }, (_, index) => ({
            number: start + index,
            title: `Chapter Title ${start + index}`,
            summary: `Summary of chapter ${start + index}.`,
            goal: `Goal of chapter ${start + index}.`,
            pov: ["Mira Vale"],
            keyEvents: [`Event ${start + index}`],
            reveals: start + index === 2 ? ["The Wall Is Failing"] : [],
          })),
        };
      }
      case "design_concept":
        return {
          logline: "A glassmaker's daughter must expose the harbor's oldest lie before the tide takes the town.",
          premise: "In a harbor town built on glass, Mira discovers the lighthouse keeps a secret.",
          themes: ["truth", "inheritance"],
          tone: "Melancholic, tense",
          conflict: "Mira against the council that profits from the lie.",
          storyDesign: "# Story Design\n\n## Premise\n\nMira, a glassmaker's daughter, uncovers the harbor's oldest lie.\n\n## Main Conflict\n\nThe council hides the failing sea wall.\n\n## Character Arcs\n\nMira learns to speak.\n\n## Structure\n\nThree movements.",
          context: "# World\n\nA cold northern harbor in an age of sail, where glass is the only trade that matters and the council controls the light.",
          characters: [
            { name: "Mira Vale", roleTier: "main", storyRole: "protagonist", description: "A stubborn young glassmaker.", desire: "The truth", fear: "Silence", arc: "From silence to voice", voice: "Short, exact sentences", relationships: ["Orrin Hale: her late father's partner, whom she distrusts"] },
            { name: "Orrin Hale", roleTier: "main", storyRole: "antagonist", description: "The harbor master.", desire: "Control", fear: "Exposure", arc: "Falls", voice: "Smooth and patient", relationships: ["Mira Vale: the one person who could expose him"] },
          ],
          locations: [{ name: "Glass Harbor", description: "A town of glass workshops.", atmosphere: "Cold light" }],
          factions: [],
          items: [{ name: "The Tide Ledger", description: "The council's book of the sea wall's repairs.", significance: "It proves the lie." }],
          worldRules: ["Glass is the only trade that matters", "The council controls the light of the lighthouse"],
          secrets: [{ title: "The Wall Is Failing", truth: "The sea wall cracked years ago.", holders: ["Orrin Hale"], stakes: "The town floods", revealChapter: 2, consequences: ["The town turns on the council"] }],
        };
      case "chapter_design": {
        const range = requestedRange(user);
        const count = options.chapters ?? (range ? range[1] - range[0] + 1 : 2);
        const start = range ? range[0] : 1;
        const numbers = Array.from({ length: count }, (_, index) => start + index);
        // A design asked to be revised comes back with a changed summary, so that the chapters it rewrote are not the ones it left.
        const revised = /Revise the design of chapters/.test(user);
        return {
          chapters: numbers.map((number) => ({
            number,
            title: `Chapter Title ${number}`,
            summary: `Summary of chapter ${number}.${revised ? " Revised." : ""}`,
            design: {
              goal: `Goal of chapter ${number}.`,
              pov: ["Mira Vale"],
              characters: ["Mira Vale", "Orrin Hale"],
              setting: "Glass Harbor",
              time: `Day ${number}`,
              events: [`Event ${number}`],
              scenes: [`Scene A of chapter ${number}`, `Scene B of chapter ${number}`],
              conflicts: ["Mira against Orrin"],
              emotions: "From doubt to resolve",
              reveals: number === 2 ? ["The Wall Is Failing"] : [],
              withholds: number < 2 ? ["Who knew about the wall"] : [],
              clues: number === 1 ? ["Salt water in the cellar"] : [],
              previous: number > 1 ? `Picks up chapter ${number - 1}.` : "",
              next: `Sets up chapter ${number + 1}.`,
              ending: `Chapter ${number} ends on a door closing.`,
              cliffhanger: number === 1,
              notes: "Keep Orrin calm on the surface.",
            },
          })),
          secrets: numbers.includes(1) || numbers.includes(2)
            ? [{
              title: "The Wall Is Failing",
              revealChapter: numbers.includes(2) ? 2 : 0,
              learnedBy: numbers.includes(2) ? [{ character: "Mira Vale", chapter: 2 }] : [],
              readerKnows: numbers.includes(1) ? [{ chapter: 1, note: "Something is wrong with the sea wall." }] : [],
              clues: numbers.includes(1) ? [{ chapter: 1, note: "Salt water in the cellar." }] : [],
              redHerrings: numbers.includes(1) ? [{ chapter: 1, note: "The storms are blamed." }] : [],
            }]
            : [],
        };
      }
      case "design_pitches": {
        const count = Number(/exactly (\d+) alternative pitches/.exec(user)?.[1] ?? "3");
        return { pitches: Array.from({ length: count }, (_, index) => ({ ...FAKE_PITCHES[index % FAKE_PITCHES.length], difference: `Pitch ${index + 1} is the book where ${FAKE_PITCHES[index % FAKE_PITCHES.length].twist.toLowerCase()}` })) };
      }
      case "design_pitch_reaction":
      case "design_pitch_choice": {
        const director = request.json?.name === "design_pitch_choice";
        const by = director ? "director" : /^autopilot:design-pitch-reader:(.+)$/.exec(request.label)?.[1] ?? "reader";
        const ids = [...new Set([...user.matchAll(/^Pitch (p\d+):/gm)].map((match) => match[1]))];
        const scores = (id: string) => options.pitchRubric?.(id, by) ?? 6.5 + Number(id.slice(1)) * 0.5;
        const mean = (id: string) => { const asked = scores(id); const values = typeof asked === "number" ? [asked] : Object.values(asked); return values.reduce((sum, value) => sum + value, 0) / values.length; };
        const best = ids.reduce((top, id) => (mean(id) >= mean(top) ? id : top), ids[0]);
        return {
          pitches: ids.map((id) => ({ id, note: `Pitch ${id} is ${mean(id) >= 7.5 ? "promising" : "familiar"}.`, rubric: fakeRubric(scores(id), { applicable: true }) })),
          ...(director ? { recommended: options.pitchRecommend?.(ids) ?? best, reason: "It is the book this author's idea promises, with a stronger turn." } : {}),
        };
      }
      case "design_chapter_review": {
        const round = Number(/Round (\d+) of the design/.exec(user)?.[1] ?? "1");
        const section = user.slice(user.indexOf("CHAPTERS UNDER REVIEW:"));
        const chapters = [...section.matchAll(/^Chapter (\d+)(?: \(the author's entry: binding\))?:$/gm)].map((match) => Number(match[1]));
        return {
          chapters: chapters.map((chapterNumber) => {
            const asked = options.chapterRubric?.(chapterNumber, round) ?? 7.5;
            const weak = Object.values(typeof asked === "number" ? { all: asked } : asked).some((score) => score < 7);
            return { chapterNumber, verdict: weak ? "revise" : "ok", summary: weak ? `Chapter ${chapterNumber} has weak points.` : `Chapter ${chapterNumber} holds.`, rubric: fakeRubric(asked, { applicable: true }) };
          }),
        };
      }
      case "design_reaction":
        return { interest: 7, reaction: "I would read it.", concerns: ["Slow start?"], wishes: ["More of the harbor"], weakSpots: ["Chapter 1: the storm is a familiar opening"], counterProposal: "Open on the flood that has not happened yet." };
      case "design_review": {
        const round = Number(/review (\d+) of at most/.exec(user)?.[1] ?? "1");
        return options.designReview?.(round, user) ?? { verdict: "approve", score: 8, summary: "A solid design.", strengths: ["Clear stakes"], changes: [], guidance: ["Keep every chapter ending on a turn."], critical: [], counterProposal: "Reveal the wall earlier and make the cost personal." };
      }
      case "plan_reaction":
        return { interest: 7, reaction: "I would read it.", concerns: ["Slow start?"], wishes: ["More of the harbor"] };
      case "plan_review":
        return { verdict: "approve", score: 8, summary: "A solid plan.", strengths: ["Clear stakes"], changes: [], guidance: ["Keep every chapter ending on a turn."] };
      case "scene_plan":
        return {
          scenes: Array.from({ length: options.scenes ?? 2 }, (_, index) => ({
            title: `Scene ${index + 1} Title`,
            goal: `Goal of scene ${index + 1}.`,
            beats: ["Arrival", "Conflict", "Turn"],
            pov: "Mira Vale",
            location: "Glass Harbor",
            characters: ["Mira Vale", "Orrin Hale"],
            summary: `Outcome of scene ${index + 1}.`,
          })),
        };
      case "scene_summary":
        return { summary: "Mira confronts Orrin at the harbor." };
      case "chapter_summary":
        return { summary: `Summary of imported chapter ${/chapter (\d+)/i.exec(user)?.[1] ?? "?"}.` };
      case "plan_reader":
      case "reader_evaluation":
        return { generalImpression: "Engaging.", strengths: ["Atmosphere"], weaknesses: ["Pacing"], mostEffectiveMoment: "The confrontation.", mainProblem: "The middle drags.", prioritySuggestion: "Tighten the middle.", score: 7 };
      case "reader_evaluation_summary":
        return { consensus: ["Strong atmosphere"], disagreements: [], recurringStrengths: ["Voice"], recurringProblems: ["The middle drags"], prioritySuggestions: ["Tighten the middle"], isolatedObservations: [], revisionPriorities: ["Tighten the middle"], overallScore: 7 };
      case "chapter_findings": {
        const quote = firstQuote(user);
        return { summary: "One issue.", findings: quote ? [{ sceneNumber: 1, category: "pacing", severity: "major", evidence: quote, problem: "The opening is slow.", remediation: "Start in motion." }] : [] };
      }
      case "director_review": {
        const round = Number(/review round (\d+)/.exec(user)?.[1] ?? "1");
        const verdict = options.reviewVerdict?.(round) ?? (round === 1 ? "revise" : "approve");
        const ids = [...user.matchAll(/\[([A-Z]\d+-\d+)\]/g)].map((match) => match[1]);
        return {
          verdict,
          score: verdict === "approve" ? 8 : 6,
          summary: verdict === "approve" ? "The chapter works." : "Tighten the opening.",
          strengths: ["Voice"],
          decisions: ids.map((id, index) => ({ findingId: id, action: verdict === "revise" && index === 0 ? "accept" : "reject", rationale: "Because.", remediation: "Open with Mira already running.", sceneNumber: 1 })),
          extraFixes: [],
          guidance: ["Keep Orrin calm on the surface."],
        };
      }
      case "chapter_consolidation":
        return { summary: "Mira confronts Orrin.", recap: "- Scene 1: arrival.\n- Scene 2: confrontation.", stateChanges: { open_loops_add: ["the wall"] }, storySoFar: "Mira has started to uncover the lie." };
      case "revision_impact":
        return { summary: "Only the first scene changes.", targets: [{ chapterNumber: 1, sceneNumber: 1, instruction: "Apply the author's revision." }] };
      case "book_corrections":
        return options.bookCorrections?.(calls.filter((entry) => entry.json?.name === "book_corrections").length, user) ?? { summary: "The ending needs its setup.", corrections: [{ chapterNumber: 1, change: "Plant the setup of the ending in the first scene.", reason: "The ending pays off a promise the book never made.", cites: [1] }] };
      case "wildcard_ideas": {
        const name = /You are «([^»]+)»/.exec(user)?.[1] ?? "A wildcard";
        if (options.wildcardIdeas) return options.wildcardIdeas(name, user);
        const sentinel = /a sentinel: you check/.test(user);
        const chapter = Number(/WHAT THE ROOM READS: [^\n]*?(?:Chapter|Capitolo) (\d+)/.exec(user)?.[1] ?? "0");
        const chapters = chapter ? [chapter] : [];
        return {
          items: sentinel
            ? [
              { title: `${name}: a loose thread`, idea: "The lighthouse key is shown and never used.", why: "A promise the reader will remember.", changes: "Pay it off or cut it.", chapters, risk: "None.", audacity: 2, evidence: "the key on the hook", severity: "major" },
              { title: `${name}: a date`, idea: "The storm lasts two days here and one in the summary.", why: "Continuity.", changes: "Align the duration.", chapters, risk: "None.", audacity: 1, evidence: "two days of wind", severity: "minor" },
            ]
            : [
              { title: `${name}: tell it from the tide`, idea: "Let the tide narrate the night of the flood.", why: "Nobody expects it, and it carries the dread.", changes: "One scene changes point of view.", chapters, risk: "It may feel like a trick.", audacity: 8 },
              { title: `${name}: Orrin's own plan`, idea: "Give Orrin a plan of his own that Mira stumbles on.", why: "The antagonist acts instead of waiting.", changes: "Adds a beat to the confrontation.", chapters, risk: "Longer chapter.", audacity: 6 },
            ],
        };
      }
      case "wildcard_triage": {
        const ids = [...new Set([...user.matchAll(/\[(idea-[0-9a-f]{16})\]/g)].map((match) => match[1]))];
        if (options.wildcardTriage) return options.wildcardTriage(ids, user);
        return {
          decisions: ids.map((id, index) => (index === 0
            ? { id, verdict: "adopted", reason: "It lifts the chapter where it sags." }
            : index === 1
              ? { id, verdict: "adapted", reason: "The core is right, the form too loud.", adaptation: "Keep the idea, in one paragraph only." }
              : { id, verdict: "rejected", reason: "It breaks the tone the author set." })),
          summary: "One idea adopted, one adapted.",
        };
      }
      case "director_opinion":
        return { verdict: "revise", score: 7, summary: "Good, but the middle drags.", answer: user.includes("asks you") ? "Yes, keep it." : undefined, strengths: ["Atmosphere"], concerns: [{ severity: "major", issue: "Pacing", suggestion: "Cut a scene" }], decisions: ["Keep the ending"], nextSteps: ["Tighten chapter 2"], questionsForAuthor: [] };
      default:
        return {};
    }
  };
  return {
    calls,
    async complete(request: AiRequest): Promise<AiResponse> {
      calls.push(request);
      if (options.failOn && options.failOn.call === calls.length) throw options.failOn.error;
      if (options.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          request.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(request.signal?.reason ?? new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
      request.signal?.throwIfAborted();
      const usage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 };
      if (request.json) {
        const json = respond(request);
        return { text: JSON.stringify(json), json, usage, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" };
      }
      const text = prose(options.words ?? 220, request.label);
      request.onText?.(text.slice(0, Math.floor(text.length / 2)));
      request.onText?.(text);
      return { text, usage, model: "fake-model", provider: "fake", cost: 0.002, currency: "USD" };
    },
  };
}

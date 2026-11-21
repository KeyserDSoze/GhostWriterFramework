import type { AiPort, AiRequest, AiResponse } from "../ai/types.js";
import { BookConflictError, type BookCommitResult, type BookFileChange, type BookFileContent, type BookFileEntry, type BookStore } from "../book/store.js";
import { sha256Hex } from "../util/hash.js";

/** In-memory `BookStore` with the same compare-and-swap rules as the real hosts. */
export class MemoryBookStore implements BookStore {
  readonly files = new Map<string, string>();
  readonly commits: Array<{ message: string; paths: string[] }> = [];
  /** Optional hook to simulate concurrent edits right before a commit is validated. */
  beforeCommit?: (changes: BookFileChange[]) => void | Promise<void>;

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
  }

  async list(): Promise<BookFileEntry[]> {
    const entries = await Promise.all([...this.files.entries()].map(async ([path, content]) => ({ path, hash: await sha256Hex(content) })));
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(path: string): Promise<BookFileContent | null> {
    const content = this.files.get(path);
    return content === undefined ? null : { path, content, hash: await sha256Hex(content) };
  }

  async commit(changes: BookFileChange[], message: string): Promise<BookCommitResult> {
    await this.beforeCommit?.(changes);
    for (const change of changes) {
      if (change.expectedHash === undefined) continue;
      const current = this.files.get(change.path);
      const hash = current === undefined ? null : await sha256Hex(current);
      if (hash !== change.expectedHash) throw new BookConflictError(`File changed since it was read: ${change.path}`, change.path);
    }
    for (const change of changes) {
      if (change.content === null) this.files.delete(change.path);
      else this.files.set(change.path, change.content);
    }
    this.commits.push({ message, paths: changes.map((change) => change.path) });
    return { revision: String(this.commits.length) };
  }

  /** Direct write that bypasses CAS, to simulate an author editing the book. */
  write(path: string, content: string | null): void {
    if (content === null) this.files.delete(path);
    else this.files.set(path, content);
  }

  toObject(): Record<string, string> {
    return Object.fromEntries([...this.files.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }
}

/** Minimal Narrarium book, like the one the web app scaffolds. */
export function seedBookFiles(input: { title?: string; language?: string } = {}): Record<string, string> {
  const title = input.title ?? "The Glass Harbor";
  const language = input.language ?? "en";
  return {
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

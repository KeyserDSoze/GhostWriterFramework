import type { Page } from "@playwright/test";
import { engineModule, filesUnder, type SeedBook } from "./autopilot";

/** A book with nothing but its description and its brief, made in Node by the engine: what a design run starts from. */
export async function describedBook(book: { id: string; repo: string; name: string }, idea: string): Promise<SeedBook> {
  const { writeOutlineBrief } = await engineModule("index.js");
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: book.name }));
  await writeOutlineBrief(store, { idea, genre: "mystery", audience: "adults", wordsPerScene: 300 });
  return { ...book, files: store.toObject() };
}

/** Every request to GitHub is recorded and refused: the spec says afterwards that none was made. */
export function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`); });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

/** The design of the chapters the request asks for, as the engine's fake writes one, for any range (the stub's own fake answers one chapter). */
export function chapterDesign(user: string) {
  const range = /numbered (\d+) to (\d+)/.exec(user) ?? /chapters (\d+)-(\d+)/.exec(user);
  const [from, to] = range ? [Number(range[1]), Number(range[2])] : [1, 4];
  const numbers = Array.from({ length: to - from + 1 }, (_, index) => from + index);
  return {
    chapters: numbers.map((number) => ({
      number,
      title: `The Tide ${number}`,
      summary: `Mira follows the lie of the sea wall, step ${number}.`,
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
    secrets: numbers.includes(1) ? [{
      title: "The Wall Is Failing",
      revealChapter: 2,
      learnedBy: [{ character: "Mira Vale", chapter: 2 }],
      readerKnows: [{ chapter: 1, note: "Something is wrong with the sea wall." }],
      clues: [{ chapter: 1, note: "Salt water in the cellar." }],
      redHerrings: [{ chapter: 1, note: "The storms are blamed." }],
    }] : [],
  };
}

/** What the autopilot kept of the book: its state file, read from the local repository of the book (`null` before there is one). */
export async function autopilotState(page: Page, repo: string) {
  const [file] = await filesUnder(page, repo, "autopilot/state.json");
  return file ? JSON.parse(file.text) as { status: string; message?: string; design?: Record<string, any>; concept?: { done: boolean } } : null;
}

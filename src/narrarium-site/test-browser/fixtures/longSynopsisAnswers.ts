/** What a model answers to the import of the synopsis of `longSynopsis.ts`, for the tests and the end-to-end specs alike (nothing of vitest here). */

/** What a model reads back from a chapter of the synopsis: its title, its summary, and the fields its labels give. */
export function readBack(section: string, number: number) {
  const field = (label: string) => new RegExp(`\\*\\*${label}:\\*\\* (.+)`).exec(section)?.[1];
  const ending = field("Chiusura e colpo di scena") ?? "";
  return {
    number,
    title: /^## Capitolo \d+ — (.+)$/m.exec(section)?.[1] ?? "",
    body: (/\*\*Riassunto\.\*\* ([\s\S]*?)\n\n\*\*Personaggi/.exec(section)?.[1] ?? "").trim(),
    design: { events: [...section.matchAll(/^- (.+)$/gm)].map((match) => match[1]), emotions: field("Evoluzione dei personaggi"), ending, goal: field("Funzione narrativa"), next: field("Collegamenti futuri"), ...(ending.includes("cliffhanger") ? { cliffhanger: true } : {}) },
  };
}

/** The chapters a batch asks for, read back from the text it carries. */
export function chaptersAnswer(user: string, fail: ReadonlySet<number> = new Set()) {
  const asked = (/Write the entries of chapters ([\d, ]+)\./.exec(user)?.[1] ?? "").split(",").map((value) => Number(value.trim())).filter(Boolean);
  const sections = user.split(/(?=^## Capitolo \d+)/m).filter((part) => /^## Capitolo \d+/.test(part));
  return asked.some((number) => fail.has(number)) ? { chapters: [] } : { chapters: asked.map((number) => readBack(sections.find((section) => section.startsWith(`## Capitolo ${number} `)) ?? "", number)) };
}

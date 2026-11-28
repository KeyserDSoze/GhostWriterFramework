import { isItalian, truncate } from "../util/text.js";
import { designChecks, designFindingText, type DesignCheckCanon, type DesignCheckInput, type DesignCheckSecret, type DesignFinding, type OutlineChapterDesign } from "./design.js";

/**
 * The checks of a design that came after the first ones (`designChecks` in `./design.ts` runs them all, and the findings they make are the same kind): what the reader is
 * told too early, what is planted and never paid, who knows what and when, where and when the story puts someone, and what the files name that the canon does not have. Pure
 * and deterministic: they read the Synopsis entries (their `design`), the ledgers of the secrets, the timeline events and the threads of `bible/threads.md`, and say what does
 * not hold together, with where. Findings, never blockers: the design run tells them to the director, the Bible and the Studio show them, a review uses them as evidence.
 *
 * `designFindings` is every check of a design (the first ones and these); `findingText` tells any finding. These are what the autopilot, the Bible, the Studio and the tools use.
 *
 * - `reveal-too-early`: a chapter before the one that reveals a secret lists it among what the reader learns.
 * - `hint-too-explicit`: a clue before the reveal names the secret outright (its title), or the entry spells it out in its events or scenes.
 * - `character-acts-on-secret`: a character who has not learned a secret yet acts on it or speaks of it in a chapter (whatever the point of view); only on stage with the
 *   secret in the chapter is a lighter finding.
 * - `thread-without-payoff`, `thread-payoff-before-setup`, `thread-out-of-range`: a thread of `bible/threads.md` planted and never paid, paid before it is planted, or beyond the last chapter.
 * - `timeline-date-mismatch`: a timeline event anchored to a chapter whose design puts it at another date; `timeline-order`: events, or chapters, in an order their dates contradict.
 * - `character-in-two-places`: two chapters at the same time with the same character in two different places.
 * - `unknown-secret`: an entry names a secret the book does not have; `unknown-character` of a secret (its holders, who learns it) or of a timeline event (its participants).
 */

/** The fields of a design whose lines say what happens: where a secret named outright, or a character acting on it, shows. */
const STORY_FIELDS = ["events", "scenes", "conflicts", "emotions", "ending"] as const;

function normalizeName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[«»"'“”‘’()[\]]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function matchCanon(value: string, canon: readonly DesignCheckCanon[]): DesignCheckCanon | undefined {
  const text = value.trim();
  const ref = /^character:(.+)$/.exec(text);
  if (ref) return canon.find((entry) => entry.slug === ref[1].trim());
  const candidate = normalizeName(text);
  if (!candidate) return undefined;
  const names = (entry: DesignCheckCanon) => [entry.name, ...(entry.aliases ?? [])].map(normalizeName).filter(Boolean);
  const exact = canon.find((entry) => names(entry).includes(candidate) || entry.slug === candidate);
  if (exact) return exact;
  const first = (name: string) => name.split(" ")[0];
  return canon.find((entry) => names(entry).some((name) => (!candidate.includes(" ") && first(name) === candidate) || (!name.includes(" ") && first(candidate) === name)));
}

/** The identity of a name for comparing two of them: the canon entry it points to, else its text. */
function identityOf(value: string, canon: readonly DesignCheckCanon[]): string {
  const entry = matchCanon(value, canon);
  return entry ? `canon:${entry.slug}` : `name:${normalizeName(value)}`;
}

/** A text as words, without its punctuation (a name is found next to a comma or a full stop). */
const plain = (value: string): string => ` ${normalizeName(value).replace(/[^\p{L}\p{N}:_-]+/gu, " ").trim()} `;

/** Whether a line names the secret by its id (`secret:<slug>`). */
const namesId = (line: string, secret: Pick<DesignCheckSecret, "slug">): boolean => normalizeName(line).includes(`secret:${secret.slug}`);

/** Whether a line names the secret by its title (a title of three letters or less names nothing in particular). */
function namesTitle(line: string, secret: Pick<DesignCheckSecret, "title">): boolean {
  const title = plain(secret.title).trim();
  return title.length > 3 && plain(line).includes(` ${title} `);
}

const mentionsSecret = (line: string, secret: Pick<DesignCheckSecret, "slug" | "title">): boolean => namesId(line, secret) || namesTitle(line, secret);

/** Whether a line names the character (by any name the canon gives it, or the text it was written with). */
function namesCharacter(line: string, character: string, canon: readonly DesignCheckCanon[]): boolean {
  const entry = matchCanon(character, canon);
  const names = entry ? [entry.name, ...(entry.aliases ?? []), entry.name.split(" ")[0]] : [character.replace(/^character:/, ""), character.replace(/^character:/, "").split(" ")[0]];
  const text = plain(line);
  return names.map((name) => plain(name).trim()).some((name) => name.length >= 3 && text.includes(` ${name} `));
}

function linesOf(design: OutlineChapterDesign | undefined, fields: ReadonlyArray<keyof OutlineChapterDesign>): Array<{ field: keyof OutlineChapterDesign; line: string }> {
  const lines: Array<{ field: keyof OutlineChapterDesign; line: string }> = [];
  for (const field of fields) {
    const value = design?.[field];
    if (typeof value === "string") lines.push({ field, line: value });
    else if (Array.isArray(value)) for (const line of value) lines.push({ field, line });
  }
  return lines;
}

// ─── Dates ──────────────────────────────────────────────────────────────────

/** A date of the story as far as the text says it: a year, a month of a year, a day. */
export interface StoryDate {
  year: number;
  month?: number;
  day?: number;
}

/**
 * The date a text says, when it says one in a form that cannot be misread: `1348-03-12`, `1348-03`, `12/03/1348` (day first), or a year of four digits on its own (`1348`, `in 1348`,
 * `spring 1348`; a year from 100 to 2999: `room 4821` is no date). Anything else (`three days later`, `the same night`) says no date: nothing is compared.
 */
export function storyDate(text: string | undefined): StoryDate | undefined {
  const value = (text ?? "").trim();
  if (!value) return undefined;
  const iso = /(?:^|[^\d])(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec(value);
  if (iso) {
    const month = Number(iso[2]);
    const day = iso[3] ? Number(iso[3]) : undefined;
    if (month >= 1 && month <= 12 && (day === undefined || (day >= 1 && day <= 31))) return { year: Number(iso[1]), month, ...(day !== undefined ? { day } : {}) };
  }
  const european = /(?:^|[^\d])(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?!\d)/.exec(value);
  if (european) {
    const day = Number(european[1]);
    const month = Number(european[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year: Number(european[3]), month, day };
  }
  const year = /(?:^|[^\d-/.])(\d{4})(?![\d-/])/.exec(value);
  if (year && Number(year[1]) >= 100 && Number(year[1]) <= 2999) return { year: Number(year[1]) };
  return undefined;
}

/** How two dates compare at the precision both have: `-1` before, `0` the same, `1` after. */
export function compareStoryDates(left: StoryDate, right: StoryDate): -1 | 0 | 1 {
  if (left.year !== right.year) return left.year < right.year ? -1 : 1;
  if (left.month === undefined || right.month === undefined) return 0;
  if (left.month !== right.month) return left.month < right.month ? -1 : 1;
  if (left.day === undefined || right.day === undefined) return 0;
  if (left.day !== right.day) return left.day < right.day ? -1 : 1;
  return 0;
}

/** Words that say the chapter leaves the line of the story: its time is not meant to follow the chapters before it. */
const OUT_OF_LINE = /\b(flashback|flash-back|years? earlier|years? before|years? ago|memory|memories|dream|prologue|epilogue|backstory|ricordo|ricordi|sogno|anni prima|anni fa|prologo|epilogo|retroscena)\b/i;

// ─── The checks ─────────────────────────────────────────────────────────────

const excerpt = (line: string) => truncate(line.replace(/\s+/g, " ").trim(), 140);

/** The chapter from which the reader may know the truth of a secret: the lower of the chapter that reveals it and `known_from`. */
function thresholdOf(secret: DesignCheckSecret): number | undefined {
  const values = [secret.revealChapter, secret.knownFromChapter].filter((value): value is number => typeof value === "number" && value > 0);
  return values.length ? Math.min(...values) : undefined;
}

/** The checks that came after the first ones, in a stable order. `done` holds what the first ones already said, so that nothing is said twice. */
export function extraDesignChecks(input: DesignCheckInput, done: readonly DesignFinding[]): DesignFinding[] {
  const findings: DesignFinding[] = [];
  const chapters = [...input.chapters].sort((left, right) => left.number - right.number);
  const last = input.lastChapter ?? chapters.reduce((highest, chapter) => Math.max(highest, chapter.number), 0);
  const early = new Set(done.filter((finding) => finding.code === "knowledge-before-learning").map((finding) => `${finding.chapter}:${finding.secret?.slug}`));

  for (const secret of input.secrets) {
    const subject = { slug: secret.slug, title: secret.title };
    const threshold = thresholdOf(secret);
    // What the reader is told, and what is spelled out, before the chapter from which the reader may know.
    if (threshold !== undefined) {
      for (const chapter of chapters) {
        if (chapter.number >= threshold) break;
        const design = chapter.design;
        if (!design) continue;
        const told = (design.reveals ?? []).find((line) => mentionsSecret(line, secret));
        if (told && !early.has(`${chapter.number}:${secret.slug}`)) findings.push({ code: "reveal-too-early", severity: "warning", chapter: chapter.number, secret: subject, other: threshold, excerpt: excerpt(told) });
        for (const { field, line } of linesOf(design, ["clues", ...STORY_FIELDS])) {
          if (!namesTitle(line, secret)) continue;
          findings.push({ code: "hint-too-explicit", severity: field === "clues" ? "warning" : "info", chapter: chapter.number, secret: subject, other: threshold, field, excerpt: excerpt(line) });
          break;
        }
      }
      for (const clue of secret.ledger.clues) {
        if (clue.chapter < threshold && namesTitle(clue.note, secret)) findings.push({ code: "hint-too-explicit", severity: "info", chapter: clue.chapter, secret: subject, other: threshold, field: "clues", excerpt: excerpt(clue.note) });
      }
    }
    // A character acting on a secret, or speaking of it, before learning it: in any chapter, whoever has the point of view.
    for (const learner of secret.ledger.learnedBy) {
      const identity = identityOf(learner.character, input.characters);
      if (secret.holders.some((holder) => identityOf(holder, input.characters) === identity)) continue;
      const name = matchCanon(learner.character, input.characters)?.name ?? learner.character.replace(/^character:/, "");
      for (const chapter of chapters) {
        if (chapter.number >= learner.chapter) break;
        const design = chapter.design;
        if (!design) continue;
        const onStage = [...(design.pov ?? []), ...(design.characters ?? [])].some((entry) => identityOf(entry, input.characters) === identity);
        if (!onStage || early.has(`${chapter.number}:${secret.slug}`)) continue;
        const story = linesOf(design, STORY_FIELDS);
        const together = story.find(({ line }) => mentionsSecret(line, secret) && namesCharacter(line, learner.character, input.characters));
        if (together) findings.push({ code: "character-acts-on-secret", severity: "warning", chapter: chapter.number, secret: subject, name, other: learner.chapter, excerpt: excerpt(together.line) });
        else {
          const apart = story.find(({ line }) => mentionsSecret(line, secret));
          if (apart) findings.push({ code: "character-acts-on-secret", severity: "info", chapter: chapter.number, secret: subject, name, other: learner.chapter, excerpt: excerpt(apart.line) });
        }
      }
    }
    // Who the ledger names that the canon does not have.
    if (input.characters.length) {
      const named = [...secret.holders, ...secret.ledger.learnedBy.map((item) => item.character)];
      for (const entry of [...new Set(named.map((value) => value.trim()).filter(Boolean))]) {
        if (!matchCanon(entry, input.characters)) findings.push({ code: "unknown-character", severity: "info", secret: subject, name: entry.replace(/^character:/, "") });
      }
    }
  }

  // The secrets the entries name that the book does not have.
  const slugs = new Set(input.secrets.map((secret) => secret.slug));
  for (const chapter of chapters) {
    const unknown = new Set<string>();
    for (const { line } of linesOf(chapter.design, ["reveals", "withholds", "clues"])) {
      for (const match of line.matchAll(/secret:([a-z0-9][a-z0-9-_]*)/gi)) if (!slugs.has(match[1])) unknown.add(match[1]);
    }
    for (const name of [...unknown].sort()) findings.push({ code: "unknown-secret", severity: "warning", chapter: chapter.number, name });
  }

  // The threads of setup and payoff.
  for (const thread of input.threads ?? []) {
    if (thread.status === "dropped") continue;
    const subject = { id: thread.id, title: thread.title };
    const setup = thread.setup?.chapter;
    const payoff = thread.payoff?.chapter;
    if (setup !== undefined && payoff === undefined && thread.status === "open") findings.push({ code: "thread-without-payoff", severity: "warning", thread: subject, chapter: setup });
    if (setup !== undefined && payoff !== undefined && payoff < setup) findings.push({ code: "thread-payoff-before-setup", severity: "warning", thread: subject, chapter: payoff, other: setup });
    if (last) {
      for (const chapter of [setup, payoff]) if (chapter !== undefined && chapter > last) findings.push({ code: "thread-out-of-range", severity: "warning", thread: subject, chapter, other: last });
    }
  }

  // The timeline: the events against the chapters they are anchored to, and the dates in their order.
  const byNumber = new Map(chapters.map((chapter) => [chapter.number, chapter]));
  const events = (input.timeline ?? []).map((event) => ({ event, date: storyDate(event.date) }));
  for (const { event, date } of events) {
    if (!date || event.chapter === undefined) continue;
    const time = byNumber.get(event.chapter)?.design?.time;
    const chapterDate = storyDate(time);
    if (chapterDate && !OUT_OF_LINE.test(time ?? "") && compareStoryDates(date, chapterDate) !== 0) findings.push({ code: "timeline-date-mismatch", severity: "warning", chapter: event.chapter, event: { slug: event.slug, title: event.title }, excerpt: excerpt(`${event.date} / ${time}`) });
  }
  const anchored = events.filter((item): item is typeof item & { date: StoryDate; event: { chapter: number } } => item.date !== undefined && item.event.chapter !== undefined).sort((left, right) => left.event.chapter - right.event.chapter || left.event.slug.localeCompare(right.event.slug));
  for (let index = 1; index < anchored.length; index += 1) {
    const previous = anchored.slice(0, index).reduce((latest, item) => (compareStoryDates(item.date, latest.date) > 0 ? item : latest));
    const current = anchored[index];
    if (current.event.chapter > previous.event.chapter && compareStoryDates(current.date, previous.date) < 0 && !OUT_OF_LINE.test(byNumber.get(current.event.chapter)?.design?.time ?? "")) {
      findings.push({ code: "timeline-order", severity: "info", chapter: current.event.chapter, other: previous.event.chapter, event: { slug: current.event.slug, title: current.event.title } });
    }
  }
  let latest: { chapter: number; date: StoryDate } | undefined;
  for (const chapter of chapters) {
    const time = chapter.design?.time;
    const date = storyDate(time);
    if (!date || OUT_OF_LINE.test(time ?? "")) continue;
    if (latest && compareStoryDates(date, latest.date) < 0) findings.push({ code: "timeline-order", severity: "info", chapter: chapter.number, other: latest.chapter, excerpt: excerpt(time ?? "") });
    else if (!latest || compareStoryDates(date, latest.date) > 0) latest = { chapter: chapter.number, date };
  }
  if (input.characters.length) {
    for (const event of input.timeline ?? []) {
      for (const name of [...new Set(event.participants.map((value) => value.trim()).filter(Boolean))]) {
        if (!matchCanon(name, input.characters)) findings.push({ code: "unknown-character", severity: "info", event: { slug: event.slug, title: event.title }, name: name.replace(/^character:/, "") });
      }
    }
  }

  // The same character in two places at the same time.
  const seen = new Set<string>();
  for (let first = 0; first < chapters.length; first += 1) {
    const a = chapters[first].design;
    const timeA = normalizeName(a?.time ?? "");
    if (!a || !timeA || !a.setting) continue;
    for (let second = first + 1; second < chapters.length; second += 1) {
      const b = chapters[second].design;
      if (!b || normalizeName(b.time ?? "") !== timeA || !b.setting) continue;
      const placeA = matchCanon(a.setting, input.locations)?.slug ?? normalizeName(a.setting);
      const placeB = matchCanon(b.setting, input.locations)?.slug ?? normalizeName(b.setting);
      if (placeA === placeB) continue;
      const peopleA = new Map([...(a.pov ?? []), ...(a.characters ?? [])].map((name) => [identityOf(name, input.characters), name] as const));
      for (const name of [...(b.pov ?? []), ...(b.characters ?? [])]) {
        const identity = identityOf(name, input.characters);
        const key = `${chapters[first].number}:${chapters[second].number}:${identity}`;
        if (!peopleA.has(identity) || seen.has(key)) continue;
        seen.add(key);
        findings.push({ code: "character-in-two-places", severity: "warning", chapter: chapters[first].number, other: chapters[second].number, name: matchCanon(name, input.characters)?.name ?? name, places: [a.setting, b.setting], excerpt: excerpt(a.time ?? "") });
      }
    }
  }
  return findings;
}

/** Every check of a design, the first ones (`designChecks`) and the later ones, in a stable order. */
export function designFindings(input: DesignCheckInput): DesignFinding[] {
  const first = designChecks(input);
  return [...first, ...extraDesignChecks(input, first)];
}

// ─── What the checks say ────────────────────────────────────────────────────

/** A finding of any check in words, in English or in Italian (the language of the book, or of the interface). */
export function findingText(finding: DesignFinding, language: string): string {
  const text = extraFindingText(finding, language);
  return text === finding.code ? designFindingText(finding, language) : text;
}

/** The findings of the checks of this module in words (see `findingText`). */
export function extraFindingText(finding: DesignFinding, language: string): string {
  const it = isItalian(language);
  const chapter = finding.chapter ?? 0;
  const other = finding.other ?? 0;
  const secret = finding.secret ? `«${finding.secret.title}»` : "";
  const thread = finding.thread ? `«${finding.thread.title}»` : "";
  const event = finding.event ? `«${finding.event.title}»` : "";
  const quote = finding.excerpt ? ` (${it ? "dice" : "it says"}: «${finding.excerpt}»)` : "";
  switch (finding.code) {
    case "reveal-too-early":
      return it ? `Il capitolo ${chapter} fa scoprire al lettore il segreto ${secret}, che si rivela solo dal capitolo ${other}${quote}.` : `Chapter ${chapter} tells the reader the secret ${secret}, which is revealed only from chapter ${other}${quote}.`;
    case "hint-too-explicit":
      return it ? `Il capitolo ${chapter} nomina apertamente il segreto ${secret} prima della rivelazione (capitolo ${other}): un indizio troppo esplicito${quote}.` : `Chapter ${chapter} names the secret ${secret} outright before its reveal (chapter ${other}): a hint that is too explicit${quote}.`;
    case "character-acts-on-secret":
      return finding.severity === "warning"
        ? (it ? `Nel capitolo ${chapter} ${finding.name} agisce sul segreto ${secret} o ne parla, ma lo scopre solo nel capitolo ${other}${quote}.` : `In chapter ${chapter} ${finding.name} acts on the secret ${secret} or speaks of it, but only learns it in chapter ${other}${quote}.`)
        : (it ? `Il capitolo ${chapter} ha in scena ${finding.name} e parla del segreto ${secret}, che ${finding.name} scopre solo nel capitolo ${other}: verifica che non ne sappia nulla${quote}.` : `Chapter ${chapter} has ${finding.name} on stage and speaks of the secret ${secret}, which ${finding.name} only learns in chapter ${other}: check that they know nothing of it${quote}.`);
    case "thread-without-payoff":
      return it ? `Il filo ${thread} è preparato nel capitolo ${chapter} e non ha una chiusura: nessun capitolo lo risolve.` : `The thread ${thread} is set up in chapter ${chapter} and has no payoff: no chapter pays it off.`;
    case "thread-payoff-before-setup":
      return it ? `Il filo ${thread} si chiude nel capitolo ${chapter}, prima di essere preparato (capitolo ${other}).` : `The thread ${thread} is paid off in chapter ${chapter}, before it is set up (chapter ${other}).`;
    case "thread-out-of-range":
      return it ? `Il filo ${thread} indica il capitolo ${chapter}, dopo l'ultimo capitolo del libro (${other}).` : `The thread ${thread} names chapter ${chapter}, after the last chapter of the book (${other}).`;
    case "timeline-date-mismatch":
      return it ? `L'evento ${event} della cronologia, ancorato al capitolo ${chapter}, ha una data diversa dal tempo del capitolo${quote}.` : `The timeline event ${event}, anchored to chapter ${chapter}, has another date than the time of the chapter${quote}.`;
    case "timeline-order":
      return event
        ? (it ? `L'evento ${event} (capitolo ${chapter}) ha una data prima di quella di un evento del capitolo ${other}, che lo precede nel libro: un flashback?` : `The event ${event} (chapter ${chapter}) is dated before an event of chapter ${other}, which comes before it in the book: a flashback?`)
        : (it ? `Il tempo del capitolo ${chapter} è prima di quello del capitolo ${other}, che lo precede nel libro: un flashback?${quote}` : `The time of chapter ${chapter} is earlier than that of chapter ${other}, which comes before it in the book: a flashback?${quote}`);
    case "character-in-two-places": {
      const [placeA, placeB] = finding.places ?? ["", ""];
      return it ? `${finding.name} è in due posti nello stesso momento: nel capitolo ${chapter} in «${placeA}» e nel capitolo ${other} in «${placeB}»${quote}.` : `${finding.name} is in two places at the same time: in chapter ${chapter} at «${placeA}» and in chapter ${other} at «${placeB}»${quote}.`;
    }
    case "unknown-secret":
      return it ? `Il capitolo ${chapter} nomina il segreto «${finding.name}», che il libro non ha.` : `Chapter ${chapter} names the secret «${finding.name}», which the book does not have.`;
    case "spoiler-in-prose":
      return it ? `Il testo scritto del capitolo ${chapter} dice il segreto ${secret} prima della rivelazione (capitolo ${other})${quote}.` : `The written text of chapter ${chapter} states the secret ${secret} before its reveal (chapter ${other})${quote}.`;
    default:
      return finding.code;
  }
}

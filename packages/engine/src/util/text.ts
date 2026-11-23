// ─── Cutting text ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Characters (UTF-16 units) of text looked at on each side of a cut, to find where a character really begins. */
const CLUSTER_WINDOW = 96;

/** What can follow the first code point of a character: marks, joiners, emoji modifiers, regional indicators, Hangul jamo, the Thai and Lao "sara am". */
const CLUSTER_PART = /[\p{M}\p{Grapheme_Extend}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\u1100-\u11ff\ua960-\ua97f\ud7b0-\ud7ff\u0e33\u0eb3]/u;
/** What can still be joined to the code point that follows it: a regional indicator (a flag) or a Hangul jamo. */
const CLUSTER_START = /[\p{Regional_Indicator}\u1100-\u11ff\ua960-\ua97f\ud7b0-\ud7ff]/u;

const segmenters = new Map<"grapheme" | "word", Intl.Segmenter>();

/** The platform's segmenter, when it has one: Node and the browsers do, but an old browser may not (checked at every use). */
function segmenter(granularity: "grapheme" | "word"): Intl.Segmenter | null {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return null;
  let instance = segmenters.get(granularity);
  if (!instance) {
    instance = new Intl.Segmenter("en", { granularity });
    segmenters.set(granularity, instance);
  }
  return instance;
}

function codePointBefore(value: string, index: number): string {
  const low = value.charCodeAt(index - 1);
  return low >= 0xdc00 && low <= 0xdfff && index >= 2 && value.charCodeAt(index - 2) >= 0xd800 && value.charCodeAt(index - 2) <= 0xdbff ? value.slice(index - 2, index) : value[index - 1];
}

/** Whether cutting `value` before `index` would split a surrogate pair or a character made of several code points. */
function splitsCharacter(value: string, index: number): boolean {
  const before = value.charCodeAt(index - 1);
  const after = value.charCodeAt(index);
  if (before < 0x300 && after < 0x300) return false;
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) return true;
  const previous = codePointBefore(value, index);
  return CLUSTER_PART.test(String.fromCodePoint(value.codePointAt(index) ?? 0)) || previous === "\u200d" || CLUSTER_START.test(previous);
}

/** A place where a character certainly begins whatever is on its left: between two plain letters of the Latin alphabet. */
function certainStart(value: string, index: number): boolean {
  return index === 0 || (value.charCodeAt(index - 1) < 0x300 && value.charCodeAt(index) < 0x300 && value.charCodeAt(index - 1) !== 0x0d);
}

/**
 * The edge of a character nearest to `index`, looking left (`-1`) or right (`1`): `index` itself unless it is inside a
 * surrogate pair, a letter with its marks, an emoji sequence, a flag, a Hangul syllable written in jamo or a conjunct of
 * consonants joined by a virama. Between two characters of Latin-1 (all that ASCII text has) nothing is ever joined; anywhere
 * else the platform's segmenter says where a character begins, and without one the common cases are recognized.
 */
function characterEdge(value: string, index: number, direction: -1 | 1): number {
  if (!(index > 0)) return 0;
  if (index >= value.length) return value.length;
  if (value.charCodeAt(index - 1) < 0x300 && value.charCodeAt(index) < 0x300) return index;
  const graphemes = segmenter("grapheme");
  if (!graphemes) {
    let at = index;
    while (at > 0 && at < value.length && splitsCharacter(value, at)) at += direction;
    return at;
  }
  let from = Math.max(0, index - CLUSTER_WINDOW);
  for (let look = from, limit = Math.max(0, from - 160); look >= limit; look -= 1) {
    if (certainStart(value, look)) {
      from = look;
      break;
    }
  }
  const to = Math.min(value.length, index + CLUSTER_WINDOW);
  let previous = from;
  for (const part of graphemes.segment(value.slice(from, to))) {
    const start = from + part.index;
    if (start === index) return index;
    if (start > index) return direction < 0 ? previous : start;
    previous = start;
  }
  return direction < 0 ? previous : to;
}

/** Shorten text to at most `max` characters, cutting at a word boundary when possible and never inside a character. */
export function truncate(text: string, max: number, marker = "…"): string {
  const value = text ?? "";
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const cut = value.slice(0, characterEdge(value, Math.max(0, max - marker.length), -1));
  const boundary = cut.lastIndexOf(" ");
  return `${boundary > max * 0.6 ? cut.slice(0, characterEdge(cut, boundary, -1)) : cut}${marker}`;
}

/** Keep the last `max` characters, starting at a word boundary when possible and never inside a character. */
export function tail(text: string, max: number, marker = "…"): string {
  const value = text ?? "";
  if (value.length <= max) return value;
  const cut = value.slice(characterEdge(value, value.length - max, 1));
  const boundary = cut.indexOf(" ");
  return `${marker}${boundary >= 0 && boundary < max * 0.3 ? cut.slice(characterEdge(cut, boundary + 1, 1)) : cut}`;
}

/** The first `max` characters of a text, without a marker and never cutting a character in two. */
export function clipText(text: string, max: number): string {
  const value = text ?? "";
  return value.length <= max ? value : value.slice(0, characterEdge(value, max, -1));
}

/** What stands between the two parts of a text clipped in the middle: the reader (a model, or a person) sees at once that something is left out. */
export const CLIP_MARKER = "[…]";

/** Below this many characters for the two parts together a cut in the middle is no use: only the start is kept. */
const MIN_ROOM_FOR_A_MIDDLE_CUT = 16;

/**
 * Shorten a text to at most `max` characters keeping both ends, for prose that is judged or summarized: its beginning and
 * its end matter, its middle can wait. `options.head` is the share of what is kept that comes from the start (0.6 by
 * default); the two parts are joined by `[…]` (on a line of its own when the text has several lines). A text that fits is
 * returned as it is. Each part begins and ends at a word when one is near, and never inside a character.
 */
export function clipMiddle(text: string, max: number, options: { head?: number; marker?: string } = {}): string {
  const value = text ?? "";
  if (!(max > 0)) return "";
  if (value.length <= max) return value;
  const marker = options.marker ?? CLIP_MARKER;
  const share = typeof options.head === "number" && Number.isFinite(options.head) ? Math.min(0.95, Math.max(0.05, options.head)) : 0.6;
  const glue = value.includes("\n") ? "\n" : " ";
  const room = max - marker.length - 2 * glue.length;
  if (room < MIN_ROOM_FOR_A_MIDDLE_CUT) return truncate(value, max);
  const headBudget = Math.floor(room * share);
  const tailBudget = room - headBudget;
  const headEnd = characterEdge(value, headBudget, -1);
  let head = value.slice(0, headEnd);
  const wordEnd = head.search(/\s\S*$/);
  if (!/\s/.test(value[headEnd] ?? " ") && wordEnd > head.length * 0.75) head = head.slice(0, wordEnd);
  const tailStart = characterEdge(value, value.length - tailBudget, 1);
  let tail = value.slice(tailStart);
  const wordStart = tail.search(/\s/);
  if (tailStart > 0 && !/\s/.test(value[tailStart - 1]) && wordStart >= 0 && wordStart < tail.length * 0.25) tail = tail.slice(wordStart);
  return `${head.trimEnd()}${glue}${marker}${glue}${tail.trimStart()}`;
}

// ─── Counting words ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A word of a script written with spaces: letters and numbers, with the marks inside them, joined by an apostrophe or a hyphen. */
const SPACED_WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}\u200c\u200d]*(?:['’-][\p{L}\p{N}][\p{L}\p{M}\p{N}\u200c\u200d]*)*/gu;
/** Chinese, Japanese, Thai, Khmer, Lao and Burmese: the scripts whose words are not separated by spaces. */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}]/u;
const UNSPACED_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}]+/gu;
const IDEOGRAPH_OR_KANA = /(?=[\p{L}\p{N}])[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const SOUTH_EAST_ASIAN_LETTER = /(?=[\p{L}\p{N}])[\p{Script=Thai}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}]/gu;
/** Characters per word without the segmenter, from what it finds in a long text: Chinese and Japanese about 1.7, the others 3.5. */
const CHARACTERS_PER_WORD = { ideographs: 1.7, southEastAsian: 3.5 };
/** Characters of a word of Italian or English text, with the space after it. */
const LATIN_CHARACTERS_PER_WORD = 6;

function spacedWords(text: string): number {
  return (text.match(SPACED_WORD) ?? []).length;
}

/** The words of a text without spaces: the segmenter's word-like segments, or an estimate from its characters when there is none. */
function unspacedWords(token: string): number {
  const words = segmenter("word");
  if (words) {
    let count = 0;
    for (const part of words.segment(token)) if (part.isWordLike) count += 1;
    return count;
  }
  const ideographs = token.match(IDEOGRAPH_OR_KANA)?.length ?? 0;
  const southEastAsian = token.match(SOUTH_EAST_ASIAN_LETTER)?.length ?? 0;
  return spacedWords(token.replace(UNSPACED_RUN, " ")) + Math.ceil(ideographs / CHARACTERS_PER_WORD.ideographs + southEastAsian / CHARACTERS_PER_WORD.southEastAsian);
}

/**
 * Words of a text. Scripts written with spaces are counted by letters, numbers and the marks inside words, with an
 * apostrophe or a hyphen joining two parts (the count of Italian and English has not changed). Chinese, Japanese, Thai,
 * Khmer, Lao and Burmese have no spaces between words: their words are those of `Intl.Segmenter`, or, where a browser
 * has none, estimated from the characters.
 */
export function countWords(text: string): number {
  const value = text ?? "";
  if (!UNSPACED_SCRIPT.test(value)) return spacedWords(value);
  let total = 0;
  for (const token of value.match(/\S+/gu) ?? []) total += UNSPACED_SCRIPT.test(token) ? unspacedWords(token) : spacedWords(token);
  return total;
}

/**
 * The length of a text in characters, as the same words would take in Latin script. A word of Chinese, Japanese, Thai,
 * Khmer, Lao or Burmese is one or two characters long where one of Italian or English takes five or six letters, so each
 * counts for six: a limit set in characters (what makes a document "thin") then means the same amount of text in every
 * language. A text with none of these scripts is as long as it is.
 */
export function latinLength(text: string): number {
  const value = text ?? "";
  if (!UNSPACED_SCRIPT.test(value)) return value.length;
  let length = 0;
  for (const token of value.match(/\S+|\s+/gu) ?? []) length += UNSPACED_SCRIPT.test(token) ? unspacedWords(token) * LATIN_CHARACTERS_PER_WORD : token.length;
  return length;
}

/**
 * Characters of a word with the space after it, as much as the longest words of any language written with spaces (German
 * and Finnish average eight or nine): a scene of the length the book asks for fits in this many whatever its language.
 */
const SCENE_CHARACTERS_PER_WORD = 10;
/** A scene may run this much over the length asked for before a prompt cuts it. */
const SCENE_OVERRUN = 1.5;

/**
 * Characters a prompt keeps of a scene that is judged or summarized: the scene's own length with room for a scene that
 * runs over (`wordsPerScene` of the brief). A scene of the length the book asks for is never clipped by it; the limits that
 * were fixed numbers before stay as the least a prompt keeps, so no scene is cut that was not cut already.
 */
export function sceneCharacterLimit(wordsPerScene: number): number {
  return Number.isFinite(wordsPerScene) && wordsPerScene > 0 ? Math.ceil(wordsPerScene * SCENE_CHARACTERS_PER_WORD * SCENE_OVERRUN) : 0;
}

export function collapseWhitespace(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Human title from a Narrarium slug such as `001-the-arrival` (same rule as the web app). */
export function slugToTitle(slug: string): string {
  return slug
    .replace(/^\d{3,}-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * The frontmatter block at the start of a Markdown file, or `null` when the file does not start with one: the lines between
 * the opening `---` line and the first line that is only `---`, and what follows it. A byte order mark before the first line
 * is ignored (editors on Windows add one), and so are CRLF line ends. The one place where a file is cut in two: the parsers of
 * frontmatter and the readers that only want the text (`stripFrontmatter`) all come here.
 */
export function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
  const text = (raw ?? "").replace(/^\uFEFF/, "");
  const opening = /^---\r?\n/.exec(text);
  if (!opening) return null;
  let lineStart = opening[0].length;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    if (line === "---" || (line === "---\r" && newline >= 0)) {
      let yamlEnd = lineStart - 1;
      if (text[yamlEnd - 1] === "\r") yamlEnd -= 1;
      return { yaml: lineStart === opening[0].length ? "" : text.slice(opening[0].length, yamlEnd), body: newline < 0 ? "" : text.slice(newline + 1) };
    }
    if (newline < 0) return null;
    lineStart = newline + 1;
  }
}

/** Remove a leading YAML frontmatter block the same way the web app does before reading prose. */
export function stripFrontmatter(raw: string): string {
  const split = splitFrontmatter(raw);
  return (split ? split.body : raw ?? "").trim();
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  it: "Italian",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  nl: "Dutch",
  pl: "Polish",
  ro: "Romanian",
  sv: "Swedish",
  da: "Danish",
  no: "Norwegian",
  fi: "Finnish",
  el: "Greek",
  ru: "Russian",
  uk: "Ukrainian",
  ja: "Japanese",
  zh: "Chinese",
  ko: "Korean",
  tr: "Turkish",
  ar: "Arabic",
  he: "Hebrew",
};

const LANGUAGE_ALIASES: Record<string, string> = {
  english: "en",
  inglese: "en",
  italian: "it",
  italiano: "it",
  spanish: "es",
  español: "es",
  french: "fr",
  français: "fr",
  german: "de",
  deutsch: "de",
  portuguese: "pt",
  português: "pt",
};

// ─── Languages and what a word of each costs in tokens ──────────────────────────────────────────────────────────────────

/** Tokens per word the engine has always counted on: it sizes every limit on the reply of a book in Italian or English. */
export const LATIN_TOKENS_PER_WORD = 2.4;
/** For a language the engine does not know: higher than any script it does know except the ones that cost the most. */
export const UNKNOWN_TOKENS_PER_WORD = 6;
/** The most tokens the engine allows a reply. */
export const OUTPUT_TOKENS_CEILING = 16000;

interface Language {
  /** ISO 639-1 code. */
  code: string;
  /** What prompts call the language, for the languages that are not in Latin script. */
  label: string;
  factor: number;
  /** Lower case: the English name, the name in Italian, the name in its own script, and the ISO 639-2 codes. */
  names: string[];
}

/** Lines of `code English-name other-names…`, all sharing one factor. */
function languages(factor: number, ...lines: string[]): Language[] {
  return lines.map((line) => {
    const [code, label, ...rest] = line.split(" ");
    return { code, label, factor, names: [label, ...rest].map((name) => name.toLowerCase().normalize("NFC")) };
  });
}

/**
 * Latin script: 2.4, which is what every limit of the engine was sized on. English runs near 1.5 tokens per word and the
 * Romance and Germanic languages between 2 and 2.4; Finnish, Hungarian, Turkish, Vietnamese and the like cost more, but a
 * book in any of them is sized as it always was, whether its language is given by code, by its English or Italian name or
 * by its own name (`Svenska`, `Polski`).
 */
const LATIN_LANGUAGES = languages(
  LATIN_TOKENS_PER_WORD,
  "en English inglese eng", "it Italian italiano ita", "es Spanish español spagnolo spa", "fr French français francese fra fre", "de German deutsch tedesco deu ger",
  "pt Portuguese português portoghese por", "nl Dutch olandese nederlands nld dut", "ca Catalan catalano català cat", "gl Galician galiziano galego glg", "ro Romanian rumeno română ron rum",
  "sv Swedish svedese svenska swe", "da Danish danese dansk dan", "no Norwegian norvegese norsk nor nb nn nob nno", "is Icelandic islandese íslenska isl ice", "fi Finnish finlandese suomi fin",
  "et Estonian estone eesti est", "lv Latvian lettone latviešu lav", "lt Lithuanian lituano lietuvių lit", "pl Polish polacco polski pol", "cs Czech ceco čeština ces cze", "sk Slovak slovacco slovenčina slk slo",
  "sl Slovenian sloveno slovene slovenščina slv", "hr Croatian croato hrvatski hrv", "bs Bosnian bosniaco bosanski bos", "hu Hungarian ungherese magyar hun", "tr Turkish turco türkçe tur",
  "vi Vietnamese vietnamita tiếng vie", "id Indonesian indonesiano indonesia ind", "ms Malay malese melayu msa may", "sq Albanian albanese shqip sqi alb", "eu Basque basco euskara eus baq",
  "cy Welsh gallese cymraeg cym wel", "ga Irish irlandese gaeilge gle", "mt Maltese maltese malti mlt", "af Afrikaans afrikaans afr", "sw Swahili swahili kiswahili swa", "tl Tagalog tagalog filipino fil tgl",
  "la Latin latino latina lat", "eo Esperanto esperanto epo",
);

/**
 * The other scripts, from what the tokenizers of the common model families (OpenAI, Anthropic, Google, Llama) spend on a
 * word, each value above the dearest of them as published comparisons put it (these are estimates, not measures made here).
 * A limit that is too low cuts the reply and loses the step; one that is too high costs nothing, it only caps. Chinese and
 * Japanese words are those of `Intl.Segmenter` (about 1.7 characters).
 *   Chinese and Japanese 3.5 · Cyrillic 4 · Hebrew 4 · Arabic script 4.5 · Greek 5 · Korean 6 · Devanagari and the
 *   Caucasian and Ethiopic scripts 8 · the other Indic scripts and Thai, Lao, Khmer and Burmese 9.
 */
const OTHER_LANGUAGES = [
  ...languages(
    4,
    "ru Russian русский russo rus", "uk Ukrainian українська ucraino ukr", "be Belarusian беларуская bielorusso bel", "bg Bulgarian български bulgaro bul",
    "sr Serbian српски serbo srp", "mk Macedonian македонски macedone mkd mac", "mn Mongolian монгол mongolo mon", "kk Kazakh қазақша kazako kaz",
    "ky Kyrgyz кыргызча kirghiso kir", "tg Tajik тоҷикӣ tagico tgk", "he Hebrew עברית ebraico heb", "yi Yiddish ייִדיש yid",
  ),
  ...languages(5, "el Greek ελληνικά greco ell gre"),
  ...languages(6, "ko Korean 한국어 coreano kor"),
  ...languages(4.5, "ar Arabic العربية arabo ara", "fa Persian فارسی persiano farsi fas per", "ur Urdu اردو urd", "ps Pashto پښتو pus"),
  ...languages(3.5, "zh Chinese 中文 汉语 漢語 简体中文 繁體中文 普通话 cinese mandarin zho chi cmn yue", "ja Japanese 日本語 giapponese jpn"),
  ...languages(8, "hi Hindi हिन्दी hin", "mr Marathi मराठी mar", "ne Nepali नेपाली nepalese nep", "ka Georgian ქართული georgiano kat geo", "hy Armenian հայերեն armeno hye arm", "am Amharic አማርኛ amarico amh"),
  ...languages(
    9,
    "bn Bengali বাংলা bengalese ben", "ta Tamil தமிழ் tam", "te Telugu తెలుగు tel", "gu Gujarati ગુજરાતી guj", "kn Kannada ಕನ್ನಡ kan", "ml Malayalam മലയാളം mal",
    "pa Punjabi ਪੰਜਾਬੀ pan", "si Sinhala සිංහල singalese sin", "th Thai ไทย tailandese tha", "lo Lao ລາວ laotiano", "km Khmer ខ្មែរ khm", "my Burmese မြန်မာ birmano mya bur",
  ),
];

const LANGUAGE_BY_NAME = new Map<string, Language>();
const OTHER_CODE_BY_NAME = new Map<string, string>();
for (const language of [...LATIN_LANGUAGES, ...OTHER_LANGUAGES]) for (const name of [language.code, ...language.names]) LANGUAGE_BY_NAME.set(name, language);
for (const language of OTHER_LANGUAGES) {
  LANGUAGE_NAMES[language.code] ??= language.label;
  for (const name of language.names) OTHER_CODE_BY_NAME.set(name, language.code);
}

/**
 * What a language value says about the language: the value as a whole, its first word (`zh` in `zh-Hans`), or a later word
 * that is a name and not a short code (`Chinese` in `Traditional Chinese (Taiwan)`, `English` in `British English`).
 */
function findLanguage<T>(table: ReadonlyMap<string, T>, raw: string): T | undefined {
  const text = raw.normalize("NFC");
  const words = text.split(/[\s\-_(),;/]+/).filter(Boolean);
  const first = table.get(text) ?? table.get(words[0] ?? "");
  if (first !== undefined) return first;
  for (const word of words.slice(1)) {
    const found = word.length >= 4 ? table.get(word) : undefined;
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Tokens per word of every language the engine knows, by ISO 639-1 code. */
export const TOKENS_PER_WORD: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries([...LATIN_LANGUAGES, ...OTHER_LANGUAGES].map((language) => [language.code, language.factor])));

/**
 * Normalize a book language value (`it`, `it-IT`, `Italiano`) to a two-letter code. The names of the languages that are not
 * in Latin script are read too (`Russian`, `русский`, `日本語`, `jpn`, `Traditional Chinese`), so that a book that names
 * its language is written in it.
 */
export function languageCode(value: string | undefined, fallback = "en"): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (LANGUAGE_ALIASES[raw]) return LANGUAGE_ALIASES[raw];
  const other = findLanguage(OTHER_CODE_BY_NAME, raw);
  if (other) return other;
  const code = raw.split(/[-_\s]/)[0];
  return code.length >= 2 && code.length <= 3 ? code : fallback;
}

/** English name of a language, used inside prompts ("Write in Italian"). */
export function languageName(value: string | undefined): string {
  const code = languageCode(value);
  return LANGUAGE_NAMES[code] ?? (value?.trim() || "English");
}

export function isItalian(value: string | undefined): boolean {
  return languageCode(value) === "it";
}

/** The shapes of an ISO 8601 moment that read the same anywhere: a date, or a date and time with its zone (a time without one is the machine's). */
const BOOK_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const bookDateFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * A moment as the author reads it, in the language of the book: «21 novembre 2026» in Italian, "21 November 2026" in every other language (the
 * words around a date the engine writes are English for them). The day is the day in UTC, and nothing depends on the machine (its time zone, its
 * language). An empty text for what is not an ISO moment.
 */
export function formatBookDate(moment: string | null | undefined, language?: string): string {
  const text = typeof moment === "string" ? moment.trim() : "";
  const time = BOOK_DATE_SHAPE.test(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(time)) return "";
  const locale = isItalian(language) ? "it-IT" : "en-GB";
  let format = bookDateFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    bookDateFormats.set(locale, format);
  }
  return format.format(time);
}

/**
 * Tokens a model needs per word of prose in the language of a book, given by code, by name (`Russian`, `русский`) or with
 * a region (`zh-CN`): 2.4 for Italian, English and every language in Latin script the engine knows (`TOKENS_PER_WORD`),
 * more for the other scripts, and `UNKNOWN_TOKENS_PER_WORD` for a language it does not know. No language at all is the
 * default one, English. For Chinese and Japanese a word is what `countWords` counts, about 1.7 characters.
 */
export function tokensPerWord(language?: string): number {
  const raw = (language ?? "").trim().toLowerCase();
  if (!raw) return LATIN_TOKENS_PER_WORD;
  return findLanguage(LANGUAGE_BY_NAME, raw)?.factor ?? UNKNOWN_TOKENS_PER_WORD;
}

/**
 * An output limit that was sized for a book in a Latin script, grown for the language of the book: the same number for
 * Italian and English, more for the languages whose words cost more tokens, never above `ceiling` (or above the limit
 * itself when that is higher already).
 */
export function scaleOutputTokens(tokens: number, language: string | undefined, ceiling = OUTPUT_TOKENS_CEILING): number {
  const ratio = tokensPerWord(language) / LATIN_TOKENS_PER_WORD;
  return ratio <= 1 ? tokens : Math.min(Math.max(tokens, ceiling), Math.ceil(tokens * ratio));
}

export function bulletList(items: string[], empty = "-"): string {
  const values = items.map((item) => item.trim()).filter(Boolean);
  return values.length ? values.map((item) => `- ${item}`).join("\n") : empty;
}

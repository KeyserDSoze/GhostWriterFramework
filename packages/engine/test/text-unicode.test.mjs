import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { countWords, tail, truncate } = engine;

// ─── The implementations as they were before the engine learned non-Latin scripts ───────────────────────────────────────
// They are the reference for every text in a Latin script: the new ones must give exactly the same answer.

function oldCountWords(text) {
  const matches = (text ?? "").match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

function oldTruncate(text, max, marker = "…") {
  const value = text ?? "";
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const cut = value.slice(0, Math.max(0, max - marker.length));
  const boundary = cut.lastIndexOf(" ");
  return `${boundary > max * 0.6 ? cut.slice(0, boundary) : cut}${marker}`;
}

function oldTail(text, max, marker = "…") {
  const value = text ?? "";
  if (value.length <= max) return value;
  const cut = value.slice(value.length - max);
  const boundary = cut.indexOf(" ");
  return `${marker}${boundary >= 0 && boundary < max * 0.3 ? cut.slice(boundary + 1) : cut}`;
}

/** Deterministic pseudo-random numbers, so that a failure can be replayed. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const ITALIAN = [
  "Il porto di sale si svegliava lentamente, come un vecchio pescatore che non ha più fretta.",
  "«Perché il faro è spento?» chiese Niccolò, e l'eco rispose dall'altra parte della baia.",
  "L'albero dell'uomo più anziano — quello vicino al molo — era già stato abbattuto dal vento di tramontana.",
  "Città, virtù, perché, così, già, più: parole accentate che devono restare intere, e un po' di apostrofi.",
  "Nel 1987 costò 1.500 lire; oggi, con 3,14 euro, nessuno compra più il pane di una volta.",
  "Un'ombra sul molo… e poi nulla, solo il rumore dell’acqua contro la pietra.",
];

const ENGLISH = [
  "The quiet harbor woke slowly, like an old fisherman who no longer hurries for anyone.",
  "\"Why is the lighthouse dark?\" Mira asked, and the echo answered from the far side of the bay.",
  "A well-known sea-captain's well-worn boots stood by the door; it's half past six o'clock, isn't it?",
  "Mr. Hale's 12-year-old daughter couldn't (wouldn't) leave: she'd said so twice, in 2024 and 2025.",
  "E-mail me at noon — or don't — but remember the 3 chapters, the 1,000 words and the 2nd draft.",
  "Rock'n'roll, 'tis the season; the o' in o'clock stands for 'of the'.",
];

const LATIN_SAMPLES = [...ITALIAN, ...ENGLISH, ITALIAN.join(" "), ENGLISH.join("\n\n"), "", "   ", "...", "— — —", "'", "a", "’a’", "a-", "-a", "1", "x'y'z-w"];

// ─── countWords: Latin text does not change ─────────────────────────────────────────────────────────────────────────────

test("countWords gives exactly the old answer for every Italian and English sample, and for random Latin text", () => {
  assert.equal(typeof countWords, "function");
  for (const sample of LATIN_SAMPLES) assert.equal(countWords(sample), oldCountWords(sample), JSON.stringify(sample));
  assert.equal(countWords(undefined), 0);
  assert.equal(countWords(null), 0);
  const alphabet = "abcdefghijklmnopqrstuvwxyzàèéìòùÀÈÉÌÒÙçñüößABCXYZ0123456789   \n\t'’-—–.,;:!?«»“”\"()[]#*_…";
  const next = random(7);
  for (let round = 0; round < 400; round += 1) {
    let text = "";
    for (let index = 0, length = Math.floor(next() * 200); index < length; index += 1) text += alphabet[Math.floor(next() * alphabet.length)];
    assert.equal(countWords(text), oldCountWords(text), JSON.stringify(text));
  }
});

test("countWords still counts the words of the samples the engine has always counted", () => {
  assert.equal(countWords("Il porto di sale si svegliava lentamente."), 7);
  assert.equal(countWords("L'albero dell'uomo"), 2, "an apostrophe joins");
  assert.equal(countWords("a well-known sea-captain's boots"), 4, "so does a hyphen");
  assert.equal(countWords("Un'ombra sul molo… e poi nulla."), 6);
  assert.equal(countWords("one two\nthree\t\tfour"), 4);
  assert.equal(countWords("1,000 words"), 3);
  assert.equal(countWords("   "), 0);
});

// ─── countWords: scripts with marks inside the words ────────────────────────────────────────────────────────────────────

test("a vowel sign, a point or a combining accent never cuts a word in two (Hindi, Arabic with vowels, Hebrew, decomposed Latin)", () => {
  assert.equal(countWords("शांत बंदरगाह धीरे जाग रहा था"), 6, "Devanagari vowel signs are part of the word");
  assert.equal(countWords("हिन्दी"), 1);
  assert.equal(countWords("كَانَتِ الْمِينَاءُ الْهَادِئَةُ تَسْتَيْقِظُ بِبُطْءٍ"), 5, "Arabic with every vowel written");
  assert.equal(countWords("הַנָּמֵל הַשָּׁקֵט"), 2, "Hebrew with points");
  assert.equal(countWords("re\u0301sume\u0301"), 1, "a decomposed accent is not the end of the word");
  assert.equal(countWords("cafe\u0301 nero"), 2);
  assert.equal(countWords("\u0301"), 0, "a lone mark is not a word");
  assert.equal(countWords("می‌خواهم کتاب"), 2, "the Persian zero-width non-joiner stays inside its word");
});

test("Cyrillic, Greek, Arabic, Hebrew and Korean are counted word by word, as before", () => {
  assert.equal(countWords("Тихая гавань просыпалась медленно, как старый рыбак."), 7);
  assert.equal(countWords("Η μικρή πόλη ξυπνούσε αργά, όπως ένας γέρος ψαράς."), 9);
  assert.equal(countWords("كانت الميناء الهادئة تستيقظ ببطء، مثل صياد عجوز."), 8);
  assert.equal(countWords("הנמל השקט התעורר לאט, כמו דייג זקן."), 7);
  assert.equal(countWords("조용한 항구는 늙은 어부처럼 천천히 깨어나고 있었다."), 7);
});

// ─── countWords: scripts written without spaces ─────────────────────────────────────────────────────────────────────────

const CHINESE = "李明走进了海边的小屋，看见母亲正在补网。她抬起头，没有说话，只是轻轻地点了点头。";
const JAPANESE = "私は海辺の町で生まれた。朝になると、漁師たちが船を出す音が聞こえてくる。";
const THAI = "สวัสดีครับ ผมชื่อสมชาย อาศัยอยู่ในกรุงเทพมหานคร และชอบอ่านหนังสือมาก";
const KHMER = "ខ្ញុំចូលចិត្តអានសៀវភៅនៅពេលល្ងាច";
const LAO = "ຂ້ອຍມັກອ່ານປຶ້ມໃນຕອນແລງ";
const BURMESE = "ကျွန်တော် ညနေခင်းမှာ စာအုပ်ဖတ်ရတာ ကြိုက်တယ်";

/** What the platform's own word segmenter says: the engine must agree with it on text that has no spaces. */
function segmenterWords(text) {
  return [...new Intl.Segmenter("en", { granularity: "word" }).segment(text)].filter((part) => part.isWordLike).length;
}

test("Chinese and Japanese sentences are counted by word, not as one word per phrase", () => {
  for (const [name, text] of [["Chinese", CHINESE], ["Japanese", JAPANESE]]) {
    const words = countWords(text);
    assert.equal(oldCountWords(text) <= 5, true, `${name}: the old count was a handful of phrases`);
    assert.ok(words >= 15 && words <= 30, `${name}: ${words} words for ${[...text].length} characters`);
    assert.equal(words, segmenterWords(text), `${name}: the same as the platform's segmenter`);
  }
  assert.equal(countWords("李明"), segmenterWords("李明"));
  assert.equal(countWords("今天天气很好。".repeat(50)), segmenterWords("今天天气很好。".repeat(50)));
  assert.ok(countWords("今天天气很好。".repeat(50)) >= 100, "a long text counts for what it is");
});

test("Thai, Khmer, Lao and Burmese are counted by word with the platform's segmenter", () => {
  for (const [name, text] of [["Thai", THAI], ["Khmer", KHMER], ["Lao", LAO], ["Burmese", BURMESE]]) {
    assert.equal(countWords(text), segmenterWords(text), name);
  }
  assert.ok(countWords(KHMER) >= 4 && countWords(KHMER) <= 8, "a Khmer sentence is not one word per mark");
  assert.ok(countWords(THAI) >= 10, "Thai phrases separated by spaces are still cut into words");
});

test("a text that mixes Latin words, numbers and Japanese counts every one of them", () => {
  const mixed = "Ho comprato un iPhone 15 e 私は海辺の町で生まれた。 Poi sono partito.";
  const japanese = segmenterWords("私は海辺の町で生まれた。");
  assert.equal(countWords(mixed), 6 + japanese + 3);
  assert.equal(countWords("iPhone15を買った"), segmenterWords("iPhone15を買った"));
  assert.equal(countWords("Hello world. こんにちは世界。"), 2 + segmenterWords("こんにちは世界。"));
});

test("without Intl.Segmenter the words of such text are estimated from its characters, and every other text is counted as ever", () => {
  const original = Intl.Segmenter;
  try {
    Intl.Segmenter = undefined;
    for (const [name, text] of [["Chinese", CHINESE], ["Japanese", JAPANESE], ["Thai", THAI], ["Khmer", KHMER]]) {
      const words = countWords(text);
      assert.ok(Number.isInteger(words) && words > 3, `${name}: ${words}`);
      assert.ok(words <= [...text].length, `${name}: never more words than characters`);
    }
    assert.ok(countWords(CHINESE) > 10 && countWords(CHINESE) <= 40, `${countWords(CHINESE)} for a 40-character sentence`);
    for (const sample of LATIN_SAMPLES) assert.equal(countWords(sample), oldCountWords(sample), JSON.stringify(sample));
    assert.equal(countWords("Ho comprato un iPhone 15 e 私は海辺の町で生まれた。 Poi sono partito.") > 9, true);
    assert.equal(truncate("Italian words only", 10), oldTruncate("Italian words only", 10), "cutting works without the segmenter too");
  } finally {
    Intl.Segmenter = original;
  }
  assert.equal(countWords(CHINESE), segmenterWords(CHINESE), "and the segmenter is used again as soon as it is there");
});

// ─── truncate and tail: Latin text does not change ──────────────────────────────────────────────────────────────────────

test("truncate and tail give exactly the old answer for ASCII text and for accented Latin text", () => {
  assert.equal(typeof truncate, "function");
  const next = random(11);
  const words = ["harbor", "light", "the", "of", "a", "porto", "città", "perché", "Niccolò", "sale", "mare", "faro", "x"];
  for (let round = 0; round < 600; round += 1) {
    let text = "";
    for (let index = 0, length = Math.floor(next() * 40); index < length; index += 1) text += `${words[Math.floor(next() * words.length)]}${next() < 0.2 ? ", " : " "}`;
    const max = Math.floor(next() * 120) - 5;
    for (const marker of ["…", "...", "", " [cut]"]) {
      assert.equal(truncate(text, max, marker), oldTruncate(text, max, marker), `truncate ${JSON.stringify(text)} ${max} ${JSON.stringify(marker)}`);
      assert.equal(tail(text, max, marker), oldTail(text, max, marker), `tail ${JSON.stringify(text)} ${max} ${JSON.stringify(marker)}`);
    }
  }
  for (const sample of [...ITALIAN, ...ENGLISH, "", "short"]) {
    for (const max of [0, 1, 2, 5, 17, 40, 80, 1000]) {
      assert.equal(truncate(sample, max), oldTruncate(sample, max), `${max} ${sample}`);
      assert.equal(tail(sample, max), oldTail(sample, max), `${max} ${sample}`);
    }
  }
  assert.equal(truncate(undefined, 10), "");
  assert.equal(tail(undefined, 10), "");
  assert.equal(truncate("The Glass Harbor keeps a secret", 14), "The Glass…");
  assert.equal(tail("The Glass Harbor keeps a secret", 14), "…keeps a secret");
});

// ─── truncate and tail: never a broken character ────────────────────────────────────────────────────────────────────────

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const graphemes = (text) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].map((part) => part.segment);

/** `kept` is made of whole characters of `original`: a prefix (or a suffix) at a grapheme boundary. */
function assertWhole(kept, original, side, message) {
  assert.doesNotMatch(kept, LONE_SURROGATE, `${message}: a surrogate pair was split`);
  const whole = graphemes(original);
  const pieces = graphemes(kept);
  assert.deepEqual(pieces, side === "start" ? whole.slice(0, pieces.length) : whole.slice(whole.length - pieces.length), `${message}: a character was split`);
}

const BROKEN_BY_UTF16 = [
  ["emoji", "😀".repeat(30)],
  ["decomposed accents", "e\u0301".repeat(30)],
  ["family emoji", "👨‍👩‍👧‍👦".repeat(8)],
  ["flags", "🇮🇹🇫🇷🇯🇵".repeat(6)],
  ["emoji with skin tone", "👍🏽".repeat(15)],
  ["Hangul jamo", "\u1112\u1161\u11ab".repeat(12)],
  ["Devanagari", "हिन्दी बंदरगाह ".repeat(6)],
  ["Thai", "สวัสดีครับ ".repeat(8)],
  ["rare ideographs", "𠮷野家𠮷".repeat(10)],
  ["variation selectors", "☺\ufe0f".repeat(25)],
  ["mixed", "Ciao 👋🏿 città e\u0301 한국어 日本語 🇮🇹 end ".repeat(4)],
];

test("truncate never cuts a surrogate pair or a character made of several code points", () => {
  for (const [name, text] of BROKEN_BY_UTF16) {
    for (let max = 1; max <= text.length + 1; max += 1) {
      const result = truncate(text, max);
      assert.ok(result.length <= max, `${name} ${max}: ${result.length} units`);
      const body = result.endsWith("…") && result !== text ? result.slice(0, -1) : result;
      assertWhole(body, text, "start", `${name} ${max}`);
    }
  }
  assert.equal(truncate("😀😀😀😀", 4), "😀…", "a pair is never left in halves");
  assert.equal(truncate("e\u0301e\u0301e\u0301e\u0301", 6), "e\u0301e\u0301…", "an accent never loses its letter");
});

test("tail never starts in the middle of a surrogate pair or of a character made of several code points", () => {
  for (const [name, text] of BROKEN_BY_UTF16) {
    for (let max = 1; max <= text.length + 1; max += 1) {
      const result = tail(text, max);
      assert.ok(result.length <= max + 1, `${name} ${max}: ${result.length} units`);
      const body = result.startsWith("…") && result !== text ? result.slice(1) : result;
      assertWhole(body, text, "end", `${name} ${max}`);
    }
  }
  assert.equal(tail("😀😀😀😀", 4), "…😀😀", "a pair is never left in halves");
  assert.equal(tail("e\u0301e\u0301e\u0301e\u0301", 5), "…e\u0301e\u0301", "an accent never loses its letter");
});

test("random text in every kind of script is cut into whole characters only", () => {
  const pieces = ["a", "b", " ", "perché", "😀", "👍🏽", "👨‍👩‍👧", "🇮🇹", "e\u0301", "\u0301", "日", "本", "語", "한", "\u1112\u1161", "\u11ab", "ह", "ि", "न", "्", "ท", "ั", "ك", "َ", "\u200d", "\ufe0f", "𠮷", "\n"];
  const next = random(99);
  for (let round = 0; round < 800; round += 1) {
    let text = "";
    for (let index = 0, length = 1 + Math.floor(next() * 40); index < length; index += 1) text += pieces[Math.floor(next() * pieces.length)];
    const max = 1 + Math.floor(next() * (text.length + 2));
    const head = truncate(text, max);
    assert.ok(head.length <= max, `${JSON.stringify(text)} ${max}`);
    assertWhole(head.endsWith("…") && head !== text ? head.slice(0, -1) : head, text, "start", `truncate ${JSON.stringify(text)} ${max}`);
    const end = tail(text, max);
    assertWhole(end.startsWith("…") && end !== text ? end.slice(1) : end, text, "end", `tail ${JSON.stringify(text)} ${max}`);
  }
});

test("without Intl.Segmenter a cut still never splits a surrogate pair or leaves a mark without its letter", () => {
  const original = Intl.Segmenter;
  try {
    Intl.Segmenter = undefined;
    for (const [name, text] of BROKEN_BY_UTF16.filter(([label]) => ["emoji", "decomposed accents", "rare ideographs", "Devanagari", "Thai"].includes(label))) {
      for (let max = 1; max <= text.length; max += 1) {
        const head = truncate(text, max);
        const end = tail(text, max);
        assert.doesNotMatch(head, LONE_SURROGATE, `${name} ${max}`);
        assert.doesNotMatch(end, LONE_SURROGATE, `${name} ${max}`);
        const kept = head.endsWith("…") && head !== text ? head.slice(0, -1) : head;
        assert.doesNotMatch(text.slice(kept.length), /^\p{M}/u, `${name} ${max}: a mark was left without its letter at the end of the cut`);
        const rest = end.startsWith("…") && end !== text ? end.slice(1) : end;
        assert.doesNotMatch(rest, /^\p{M}/u, `${name} ${max}: a mark was left without its letter at the start of the cut`);
      }
    }
    assert.equal(truncate("e\u0301e\u0301e\u0301e\u0301", 6), "e\u0301e\u0301…");
    assert.equal(tail("😀😀😀😀", 4), "…😀😀");
  } finally {
    Intl.Segmenter = original;
  }
});

test("the summary of a canon entry taken from the first line of its file is never cut in the middle of a character", async () => {
  const { MemoryBookStore, seedBookFiles } = await import("../dist/testing/index.js");
  const entry = (name, line) => `---\ntype: character\nid: character:${name}\nname: ${name}\n---\n\n# ${line}\n\nMore text.\n`;
  const store = new MemoryBookStore({
    ...seedBookFiles(),
    "characters/emoji.md": entry("emoji", `${"a".repeat(239)}😀😀`),
    "characters/accent.md": entry("accent", `${"a".repeat(239)}e\u0301e\u0301`),
    "characters/plain.md": entry("plain", "b".repeat(300)),
    "characters/short.md": entry("short", "A short line"),
  });
  const summaries = Object.fromEntries((await engine.loadBookSnapshot(store)).canon.map((item) => [item.name, item.summary]));
  assert.equal(summaries.emoji, "a".repeat(239), "the pair that did not fit is left out whole");
  assert.equal(summaries.accent, "a".repeat(239), "so is the letter whose accent did not fit");
  assert.equal(summaries.plain, "b".repeat(240), "an ordinary line is cut where it always was");
  assert.equal(summaries.short, "A short line");
  for (const summary of Object.values(summaries)) assert.doesNotMatch(summary, LONE_SURROGATE);
});

test("clipText keeps the first characters without a marker, never cutting one in two", () => {
  assert.equal(typeof engine.clipText, "function");
  assert.equal(engine.clipText("The Glass Harbor", 9), "The Glass");
  assert.equal(engine.clipText("short", 100), "short");
  assert.equal(engine.clipText("😀😀😀", 3), "😀");
  assert.equal(engine.clipText("e\u0301e\u0301", 3), "e\u0301");
  assert.equal(engine.clipText(undefined, 3), "");
  assert.equal(engine.clipText("anything", 0), "");
});

// ─── languages and the number of tokens a word costs ────────────────────────────────────────────────────────────────────

test("tokensPerWord keeps 2.4 for Italian, English and the main Latin languages, however the book writes the language", () => {
  assert.equal(typeof engine.tokensPerWord, "function");
  for (const language of ["it", "en", "es", "fr", "de", "pt", "nl", "sv", "da", "no", "ro", "ca", "pl", "cs", "hu", "fi", "tr", "vi", "id"]) {
    assert.equal(engine.tokensPerWord(language), 2.4, language);
  }
  for (const language of ["it-IT", "en-US", "IT", "Italiano", "italian", "English", "inglese", "fr_FR", "pt-BR", "Español", "Deutsch", "français", "Polish", "dutch", "Turkish"]) {
    assert.equal(engine.tokensPerWord(language), 2.4, language);
  }
  for (const native of ["Nederlands", "Svenska", "Dansk", "Norsk", "Suomi", "Polski", "Čeština", "Slovenčina", "Hrvatski", "Magyar", "Türkçe", "Română", "Català", "Galego", "Euskara", "Íslenska", "Eesti", "Latviešu", "Lietuvių", "Bahasa Indonesia", "Bahasa Melayu", "Tiếng Việt", "Shqip", "Cymraeg", "Kiswahili"]) {
    assert.equal(engine.tokensPerWord(native), 2.4, `${native}: a Latin book that names its language in that language is sized as it always was`);
  }
  assert.equal(engine.tokensPerWord(undefined), 2.4, "a book that does not say its language is written in the default one, English");
  assert.equal(engine.tokensPerWord(""), 2.4);
  assert.equal(engine.tokensPerWord("   "), 2.4);
});

test("tokensPerWord is higher for every script whose words cost more tokens, and the most cautious value is for an unknown language", () => {
  const factor = engine.tokensPerWord;
  const latin = factor("it");
  const named = { ru: "Russian", uk: "Ukrainian", bg: "Bulgarian", el: "Greek", ar: "Arabic", he: "Hebrew", fa: "Persian", ur: "Urdu", hi: "Hindi", th: "Thai", zh: "Chinese", ja: "Japanese", ko: "Korean", bn: "Bengali", ta: "Tamil", km: "Khmer", lo: "Lao", my: "Burmese", ka: "Georgian", hy: "Armenian" };
  for (const [code, name] of Object.entries(named)) {
    assert.ok(factor(code) > latin, `${name}: ${factor(code)}`);
    assert.equal(factor(name), factor(code), `${name} is read like its code`);
    assert.equal(factor(name.toUpperCase()), factor(code), `${name} in capitals`);
  }
  for (const native of ["русский", "Русский", "ελληνικά", "العربية", "עברית", "हिन्दी", "ไทย", "中文", "日本語", "한국어", "简体中文", "繁體中文", "українська", "فارسی"]) {
    assert.ok(factor(native) > latin, native);
  }
  for (const italian of ["russo", "greco", "cinese", "giapponese", "coreano", "arabo", "ebraico", "ucraino"]) assert.ok(factor(italian) > latin, italian);
  for (const code of ["zh-CN", "zh-Hans", "zh_TW", "ja-JP", "ru-RU", "ar-SA", "he-IL", "ko-KR", "el-GR", "hi-IN", "th-TH", "rus", "jpn", "zho", "kor", "ara", "heb", "ell", "hin", "tha"]) assert.ok(factor(code) > latin, code);
  const unknown = factor("xx");
  assert.ok(unknown > latin, "an unknown language is not sized like Italian");
  for (const code of ["ru", "uk", "bg", "el", "ar", "he", "fa", "ko", "zh", "ja"]) assert.ok(unknown >= factor(code), `unknown (${unknown}) is not below ${code} (${factor(code)})`);
  assert.equal(factor("Klingon"), unknown);
  assert.equal(factor("qq-ZZ"), unknown);
  assert.ok(factor("hi") >= unknown && factor("th") >= unknown, "the scripts that cost the most are above the cautious value");
  assert.ok(factor("zh") < factor("hi"), "Chinese words are cheaper than Hindi ones");
  assert.ok(Object.values({ ru: factor("ru"), el: factor("el"), ar: factor("ar"), he: factor("he"), hi: factor("hi"), th: factor("th"), zh: factor("zh"), ja: factor("ja"), ko: factor("ko") }).every((value) => value > 2.4 && value <= 16));
});

test("the table of factors and its two special values are public and documented by their names", () => {
  assert.equal(engine.LATIN_TOKENS_PER_WORD, 2.4);
  assert.ok(engine.UNKNOWN_TOKENS_PER_WORD > 2.4);
  assert.equal(engine.TOKENS_PER_WORD.it, 2.4);
  assert.equal(engine.TOKENS_PER_WORD.en, 2.4);
  assert.ok(engine.TOKENS_PER_WORD.ru > 2.4 && engine.TOKENS_PER_WORD.zh > 2.4);
  assert.equal(Object.isFrozen(engine.TOKENS_PER_WORD), true, "nobody edits the table by accident");
});

test("scaleOutputTokens leaves a Latin book's limits alone and grows the others up to a ceiling", () => {
  assert.equal(typeof engine.scaleOutputTokens, "function");
  for (const tokens of [400, 1500, 2500, 4000, 5000, 6000, 9000, 16000, 20000, 1]) {
    assert.equal(engine.scaleOutputTokens(tokens, "it"), tokens, `it ${tokens}`);
    assert.equal(engine.scaleOutputTokens(tokens, "en"), tokens, `en ${tokens}`);
    assert.equal(engine.scaleOutputTokens(tokens, undefined), tokens, `no language ${tokens}`);
    assert.equal(engine.scaleOutputTokens(tokens, "fr"), tokens, `fr ${tokens}`);
  }
  assert.ok(engine.scaleOutputTokens(9000, "ru") > 9000);
  assert.ok(engine.scaleOutputTokens(9000, "ru") <= 16000, "never above the 16 000 the engine allows a reply");
  assert.equal(engine.scaleOutputTokens(9000, "hi"), 16000);
  assert.equal(engine.scaleOutputTokens(20000, "hi"), 20000, "a limit already above the ceiling is not touched");
  assert.ok(engine.scaleOutputTokens(400, "zh") > 400 && engine.scaleOutputTokens(400, "zh") < 1000);
  assert.equal(engine.scaleOutputTokens(2500, "ru"), Math.ceil(2500 * (engine.tokensPerWord("ru") / 2.4)));
});

test("languageCode and languageName read the names of the non-Latin languages as well as their codes", () => {
  const { languageCode, languageName } = engine;
  // What they always did:
  assert.equal(languageCode("it"), "it");
  assert.equal(languageCode("it-IT"), "it");
  assert.equal(languageCode("Italiano"), "it");
  assert.equal(languageCode("English"), "en");
  assert.equal(languageCode(undefined), "en");
  assert.equal(languageCode("zh-CN"), "zh");
  assert.equal(languageCode("pt_BR"), "pt");
  assert.equal(languageCode("klingon"), "en", "an unknown name still falls back");
  assert.equal(languageCode("Polish"), "en", "names of Latin languages outside the six aliases are read as before");
  assert.equal(languageName("ja"), "Japanese");
  assert.equal(languageName("ru-RU"), "Russian");
  assert.equal(languageName("Italiano"), "Italian");
  // What they learn:
  for (const [value, code, name] of [
    ["Russian", "ru", "Russian"], ["русский", "ru", "Russian"], ["Japanese", "ja", "Japanese"], ["日本語", "ja", "Japanese"], ["Chinese", "zh", "Chinese"],
    ["中文", "zh", "Chinese"], ["Greek", "el", "Greek"], ["Ελληνικά", "el", "Greek"], ["Arabic", "ar", "Arabic"], ["العربية", "ar", "Arabic"],
    ["Hebrew", "he", "Hebrew"], ["עברית", "he", "Hebrew"], ["Hindi", "hi", "Hindi"], ["हिन्दी", "hi", "Hindi"], ["Thai", "th", "Thai"], ["ไทย", "th", "Thai"],
    ["Korean", "ko", "Korean"], ["한국어", "ko", "Korean"], ["Ukrainian", "uk", "Ukrainian"], ["russo", "ru", "Russian"], ["giapponese", "ja", "Japanese"],
    ["jpn", "ja", "Japanese"], ["rus", "ru", "Russian"], ["Chinese (Simplified)", "zh", "Chinese"], ["hi", "hi", "Hindi"], ["th", "th", "Thai"], ["fa", "fa", "Persian"],
  ]) {
    assert.equal(languageCode(value), code, value);
    assert.equal(languageName(value), name, value);
  }
  assert.equal(engine.isItalian("Russian"), false);
  assert.equal(engine.isItalian("Italiano"), true);
});

// ─── names inside running text ──────────────────────────────────────────────────────────────────────────────────────────

test("a language given as a longer phrase is found in it: the Latin ones stay at 2.4, the others are read", () => {
  const { languageCode, languageName, tokensPerWord } = engine;
  for (const phrase of ["British English", "American English", "english (UK)", "Brazilian Portuguese", "Latin American Spanish", "Swiss German", "Italiano (Svizzera)", "Inglese americano", "it, en", "Old English"]) {
    assert.equal(tokensPerWord(phrase), 2.4, phrase);
  }
  for (const [phrase, code] of [["Traditional Chinese", "zh"], ["Simplified Chinese (China)", "zh"], ["Modern Standard Arabic", "ar"], ["Modern Japanese", "ja"], ["Biblical Hebrew", "he"], ["Eastern Armenian", "hy"], ["russian / английский", "ru"], ["中文 (繁體)", "zh"], ["Brazilian, Russian", "ru"]]) {
    assert.equal(languageCode(phrase), code, phrase);
    assert.equal(tokensPerWord(phrase), tokensPerWord(code), phrase);
    assert.equal(languageName(phrase), languageName(code), phrase);
  }
  assert.equal(languageCode("British English"), "en", "a Latin phrase falls back to English, as before");
  assert.equal(languageCode("Brazilian Portuguese"), "en", "and so does one the engine never read");
  assert.equal(tokensPerWord("the Klingon of Qo'noS"), engine.UNKNOWN_TOKENS_PER_WORD);
  assert.equal(tokensPerWord("no language at all"), 2.4, "a short word that is also a language code is only read as the first word");
  assert.equal(tokensPerWord("Mi idioma"), engine.UNKNOWN_TOKENS_PER_WORD);
});

test("a name is found after a candidate that was part of a longer word, and the search never loops on characters outside the BMP", () => {
  const { containsName } = engine;
  assert.equal(containsName("EvaEva Eva", "Eva"), true, "the third one is a word");
  assert.equal(containsName("EvaEva", "Eva"), false);
  assert.equal(containsName("xEvaEva EVA.", "eva"), true);
  assert.equal(containsName("aaa", "aa"), false, "overlapping candidates are all looked at");
  assert.equal(containsName("a aa b", "aa"), true);
  assert.equal(containsName("Orrin\n  Hale walked", "Orrin Hale"), true, "any run of white space inside a name");
  assert.equal(containsName("Orrin Haley walked", "Orrin Hale"), false);
  assert.equal(containsName("😀Eva😀", "Eva"), true, "an emoji is not a letter");
  assert.equal(containsName("𝒜Eva", "Eva"), false, "a mathematical letter outside the BMP is");
  assert.equal(containsName("x𝒜b", "𝒜b"), false, "a name that starts outside the BMP, in a longer word, ends the search");
  assert.equal(containsName("x𝒜b 𝒜b", "𝒜b"), true);
  assert.equal(containsName("𠮷𠮷野家", "𠮷野"), true, "an ideograph outside the BMP before a name that starts with one");
  assert.equal(containsName("", "Eva"), false);
  assert.equal(containsName("Eva", "E"), false, "a name of one character is never searched for");
});

test("canon names are found inside running text of the scripts that have no spaces between words, and before Korean particles", () => {
  const { containsName } = engine;
  assert.equal(containsName("李明走进了海边的小屋。", "李明"), true);
  assert.equal(containsName("她看见了李明，没有说话。", "李明"), true);
  assert.equal(containsName("田中太郎は桟橋に出て、水面を見ていた。", "田中太郎"), true);
  assert.equal(containsName("ผมเห็นสมชายที่ท่าเรือ", "สมชาย"), true);
  assert.equal(containsName("민수는 집에 갔다.", "민수"), true, "a Korean name followed by its particle");
  assert.equal(containsName("海辺の朝、Miraは歩いた。", "Mira"), true, "a Latin name between Japanese words");
  assert.equal(containsName("今天没有人提到王芳。", "李明"), false);
  // Spaced scripts keep their whole-word rule, exactly as for Latin text:
  assert.equal(containsName("Lei aveva paura del mare.", "Eva"), false);
  assert.equal(containsName("Анна вышла на причал.", "Анна"), true);
  assert.equal(containsName("Аннабель вышла на причал.", "Анна"), false);
  assert.equal(containsName("Η Ελένη βγήκε στην αποβάθρα.", "Ελένη"), true);
  assert.equal(containsName("خرجت ليلى إلى الرصيف.", "ليلى"), true);
  assert.equal(containsName("Mira walked.", "Mira"), true);
});

test("a name of two characters is a name in Chinese, Japanese and Korean, and the scenes' characters find their canon entries", () => {
  const { mentionedCanon } = engine;
  const entry = (kind, name, index, aliases = []) => ({ kind, slug: `c${index}`, name, aliases, path: `x/${index}.md`, hash: "" });
  const canon = [entry("character", "李明", 0), entry("character", "王芳", 1), entry("character", "민수", 2), entry("location", "海边", 3), entry("character", "Ed", 4)];
  const snapshot = { canon };
  assert.deepEqual(mentionedCanon(snapshot, "李明走进了海边的小屋，王芳在补网。").map((item) => item.name), ["李明", "王芳", "海边"]);
  assert.deepEqual(mentionedCanon(snapshot, "", 5, ["王芳", "李明"]).map((item) => item.name), ["王芳", "李明"], "named by the scene plan");
  assert.deepEqual(mentionedCanon(snapshot, "민수는 집에 갔다.").map((item) => item.name), ["민수"]);
  assert.deepEqual(mentionedCanon(snapshot, "Ed went home.").map((item) => item.name), [], "a two-letter Latin name is still too short to be safe");
});

// ─── headings the autopilot recognizes ──────────────────────────────────────────────────────────────────────────────────

test("a scene heading the model adds is removed whatever the book's language", () => {
  const { cleanProse } = engine;
  const body = "Утро над гаванью началось медленно.";
  // The Latin headings it has always removed:
  assert.equal(cleanProse(`# Scene 1\n\nScene 2: The harbor\n\nScena 3. Il porto\n\n${body}`), body);
  assert.equal(cleanProse("```markdown\nScene 1 — x\nThe harbor woke.\n```"), "The harbor woke.");
  assert.equal(cleanProse("Scene 12 and a half: it was late.\nMore."), "Scene 12 and a half: it was late.\nMore.", "prose that merely starts with the word stays");
  // The others:
  for (const heading of ["Сцена 3.", "Сцена 3: На причале", "Σκηνή 3: Στην αποβάθρα", "场景 3：在码头上", "场景3：", "第3场：在码头上", "場面3：桟橋にて", "シーン 3 — 桟橋", "장면 3. 부두에서", "مشهد 3: على الرصيف", "סצנה 3: ברציף", "दृश्य 3: घाट पर", "ฉาก 3: ที่ท่าเรือ"]) {
    assert.equal(cleanProse(`${heading}\n\n${body}`), body, heading);
  }
  assert.equal(cleanProse(`Сцена 3 была длинной, и Анна устала.\n${body}`), `Сцена 3 была длинной, и Анна устала.\n${body}`, "a sentence is not a heading");
  assert.equal(cleanProse(`${body}\nСцена 3: конец.`), `${body}\nСцена 3: конец.`, "only the first lines can be headings");
});

// ─── the recap and the chapter headings in resumes/total.md ─────────────────────────────────────────────────────────────

test("the sections of the total resume are read whatever script the titles are written in, and a Chinese story so far is measured in words", () => {
  const { parseTotalResume, renderTotalResumeBody, storySoFarExcess, STORY_SO_FAR_MAX_WORDS } = engine;
  const chapter = (number, title, summary) => ({ number, title, slug: `${String(number).padStart(3, "0")}-x`, summary, goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [] });
  const chapters = [chapter(1, "Тихая гавань", "Анна возвращается."), chapter(2, "回家", "李明回到了海边的小屋。"), chapter(1200, "الميناء", "عادت ليلى."), chapter(1201, "Mixed 海辺 Глава", "Mixed.")];
  const body = renderTotalResumeBody("", chapters, { number: 1200, title: "الميناء", summary: "عادت ليلى." });
  const parsed = parseTotalResume(body);
  assert.deepEqual(parsed.chapters.map((section) => [section.number, section.heading]), [[1, "## Chapter 001 Тихая гавань"], [2, "## Chapter 002 回家"], [1200, "## Chapter 1200 الميناء"], [1201, "## Chapter 1201 Mixed 海辺 Глава"]]);
  assert.deepEqual(parsed.chapters.map((section) => section.text), ["Анна возвращается.", "李明回到了海边的小屋。", "عادت ليلى.", "Mixed."]);
  const long = "李明回到了海边的小屋，母亲正在补网。".repeat(300);
  const excess = storySoFarExcess(long);
  assert.ok(excess, "5 000 characters of Chinese are well over the limit measured in words");
  assert.ok(excess.words > STORY_SO_FAR_MAX_WORDS);
  assert.equal(excess.over, excess.words - STORY_SO_FAR_MAX_WORDS);
  assert.equal(storySoFarExcess("李明回到了海边的小屋，母亲正在补网。".repeat(20)), null, "a short one fits");
});

import { describe, expect, it } from "vitest";
import { resolveChapterTarget, resolveParagraphTarget } from "@/assistant/targetRules";
import { resolveResearchTarget } from "@/assistant/researchTarget";
import { findCanonFileByPrompt, targetReferenceMatchesSlug } from "@/assistant/service";
import { matchKey } from "@/lib/matchText";
import { resolveParagraphArtifactPaths } from "@/narrarium/paragraphArtifacts";

const scene = (chapter: string, number: string, title: string) => ({ number, title, path: `chapters/${chapter}/${number}-scene.md` });
const chapter = (slug: string, title: string, titles: string[]) => ({ slug, title, paragraphs: titles.map((entry, index) => scene(slug, String(index + 1).padStart(3, "0"), entry)) });

describe("naming a chapter or a scene in the assistant, in any script", () => {
  const chinese = [chapter("001-chapter", "海辺の朝", ["朝の港", "漁師の家"]), chapter("002-chapter", "夜の港", ["灯台", "嵐"])];
  const russian = [chapter("001-glava-pervaya", "Глава первая", ["Тихая гавань"]), chapter("002-glava-vtoraya", "Глава вторая", ["Ночной порт"])];

  it.each([
    ['evaluate chapter "夜の港"', "002-chapter"],
    ["evaluate chapter named 海辺の朝", "001-chapter"],
    ['audit chapter "夜の港" in detail', "002-chapter"],
  ])("finds the Chinese chapter in %s", (prompt, slug) => {
    expect(resolveChapterTarget(prompt, chinese, null)).toMatchObject({ status: "resolved", value: { slug } });
  });

  it.each([
    ['evaluate chapter "Глава вторая"', "002-glava-vtoraya"],
    ["review chapter named Глава первая", "001-glava-pervaya"],
  ])("finds the Russian chapter in %s", (prompt, slug) => {
    expect(resolveChapterTarget(prompt, russian, null)).toMatchObject({ status: "resolved", value: { slug } });
  });

  it("does not take another chapter for the one named when no chapter has that name", () => {
    for (const named of ["存在しない", "Несуществующая", "Μια άλλη πόλη", "ميناء آخر"]) {
      expect(resolveChapterTarget(`evaluate chapter "${named}"`, chinese, null), named).toMatchObject({ status: "missing", value: null });
      expect(resolveChapterTarget(`evaluate chapter "${named}"`, russian, null), named).toMatchObject({ status: "missing", value: null });
    }
    const alone = [chinese[0]];
    expect(resolveChapterTarget('delete chapter "夜の港"', alone, null)).toMatchObject({ status: "missing", value: null });
  });

  it("tells chapters that differ only in a number apart", () => {
    const numbered = [chapter("001-a", "Глава 1", []), chapter("002-b", "Сцена 1", []), chapter("003-c", "Глава 2", [])];
    expect(resolveChapterTarget('read chapter "Глава 1"', numbered, null)).toMatchObject({ status: "resolved", value: { slug: "001-a" } });
    expect(resolveChapterTarget('read chapter "Сцена 1"', numbered, null)).toMatchObject({ status: "resolved", value: { slug: "002-b" } });
  });

  it("says a name is ambiguous only when two chapters really have it", () => {
    const twins = [chapter("001-a", "海辺の朝", []), chapter("002-b", "海辺の朝", []), chapter("003-c", "夜の港", [])];
    expect(resolveChapterTarget('evaluate chapter "海辺の朝"', twins, null).status).toBe("ambiguous");
    expect(resolveChapterTarget('evaluate chapter "夜の港"', twins, null)).toMatchObject({ status: "resolved", value: { slug: "003-c" } });
  });

  it("finds a scene by its Chinese or Russian title, and never another scene when the title is not there", () => {
    const inChinese = resolveChapterTarget("chapter 1", chinese, null);
    expect(resolveParagraphTarget('read scene "漁師の家"', inChinese, null, null)).toMatchObject({ status: "resolved", value: { paragraph: { number: "002" } } });
    expect(resolveParagraphTarget('read scene "海"', inChinese, null, null)).toMatchObject({ status: "missing", value: null });
    expect(resolveParagraphTarget('read scene "存在しない"', inChinese, null, null)).toMatchObject({ status: "missing", value: null });

    const inRussian = resolveChapterTarget("chapter 2", russian, null);
    expect(resolveParagraphTarget('read paragraph "Ночной порт"', inRussian, null, null)).toMatchObject({ status: "resolved", value: { paragraph: { number: "001" } } });
    expect(resolveParagraphTarget('read paragraph "Тихая гавань"', inRussian, null, null)).toMatchObject({ status: "missing", value: null });
  });

  it("keeps finding Latin names the way it always did, ignoring case, accents and punctuation", () => {
    const latin = [chapter("001-the-gate", "The Gate", ["Arrival"]), chapter("002-citta", "Città di sale", ["Deep Water"])];
    expect(resolveChapterTarget('review chapter "THE GATE!"', latin, null)).toMatchObject({ status: "resolved", value: { slug: "001-the-gate" } });
    expect(resolveChapterTarget("review chapter citta di sale", latin, null)).toMatchObject({ status: "resolved", value: { slug: "002-citta" } });
    expect(resolveChapterTarget('review chapter "The Crossing"', latin, null).status).toBe("missing");
    expect(resolveParagraphTarget('read paragraph "deep-water"', resolveChapterTarget("chapter 2", latin, null), null, null)).toMatchObject({ status: "resolved", value: { paragraph: { number: "001" } } });
  });
});

describe("matching what was typed to what is in the book, in any script", () => {
  it("reduces Latin text exactly as the matching rules always did", () => {
    expect(matchKey("  Città di SALE!  ")).toBe("citta di sale");
    expect(matchKey("Don't Stop")).toBe("don t stop");
    expect(matchKey("The Gate—and Beyond")).toBe("the gate and beyond");
    expect(matchKey("Zoë D’Angelo")).toBe("zoe d angelo");
    expect(matchKey("research/2026-11-21-roman.md", true)).toBe("research/2026-11-21-roman.md");
    expect(matchKey("Roman: aqueducts?", true)).toBe("roman aqueducts");
    expect(matchKey("")).toBe("");
    expect(matchKey("???")).toBe("");
  });

  it("reduces any Latin text the way the rules written before it did, for thousands of texts", () => {
    const before = {
      target: (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      artifact: (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/^\d{3}(?:-|\s+)?/, "").replace(/[^a-z0-9]+/g, " ").trim(),
      path: (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9/.-]+/g, " ").trim(),
    };
    const pieces = ["The", "Gate", "città", "Crème", "brûlée", "Zoë", "D’Angelo", "Don't", "Øresund", "straße", "łódź", "Đà", "İstanbul", "ı", "æther", "œuvre", "naïve", "ÅNGSTRÖM", "001", "123", "2026-11-21", "a/b", "x.md", "—", "…", "«q»", "“quoted”", "(paren)", "no.5", "🎉", "®", "½", "Ⅷ", "ＡＢＣ", "０１２", "ﬁne", "e\u0301", " ", "\n", "-", "_", "!", "?", "ª"];
    let seed = 20261121;
    const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let index = 0; index < 5000; index += 1) {
      let text = "";
      for (let count = 1 + Math.floor(random() * 6); count > 0; count -= 1) text += pieces[Math.floor(random() * pieces.length)] + (random() < 0.5 ? " " : "");
      expect(matchKey(text), JSON.stringify(text)).toBe(before.target(text));
      expect(matchKey(text, true), JSON.stringify(text)).toBe(before.path(text));
      expect(matchKey(text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/^\d{3}(?:-|\s+)?/, "")), JSON.stringify(text)).toBe(before.artifact(text));
    }
  });

  it("keeps the letters of other scripts, so two different titles are never both reduced to nothing", () => {
    expect(matchKey("海辺の朝")).toBe("海辺の朝");
    expect(matchKey("海辺の朝")).not.toBe(matchKey("夜の港"));
    expect(matchKey("  Тихая, ГАВАНЬ! ")).toBe("тихая гавань");
    expect(matchKey("Η μικρή πόλη")).toBe("η μικρη πολη");
    expect(matchKey("الميناء الصغير")).toBe("الميناء الصغير");
    expect(matchKey("Глава 1")).not.toBe(matchKey("Сцена 1"));
    expect(matchKey("शांत बंदरगाह")).toBe("शांत बंदरगाह");
    expect(matchKey("ท่าเรือ  เงียบ")).toBe("ท่าเรือ เงียบ");
  });

  it("tells two Hindi words apart that differ only in a vowel sign", () => {
    expect(matchKey("कि")).not.toBe(matchKey("की"));
  });
});

describe("finding the draft or the script of a scene again by its title, in any script", () => {
  const target = (path: string, title: string) => ({ path, chapterSlug: "001-chapter", paragraphSlug: path.split("/").pop()!.replace(/\.md$/, ""), title });

  it("matches a draft kept under another number when its title is the same Chinese or Russian title", () => {
    for (const title of ["朝の港", "Тихая гавань", "Η μικρή πόλη", "الميناء"]) {
      const scene = target("chapters/001-chapter/002-scene.md", title);
      const other = target("chapters/001-chapter/003-scene.md", "Another title");
      const draft = "drafts/001-chapter/009-old.md";
      const resolved = resolveParagraphArtifactPaths("draft", [scene.path, other.path, draft], [scene, other], { [draft]: { title } });
      expect(resolved.get(scene.path), title).toBe(draft);
      expect(resolved.has(other.path), title).toBe(false);
    }
  });

  it("does not guess when two scenes have the same title, or when the titles differ", () => {
    const first = target("chapters/001-chapter/001-scene.md", "朝の港");
    const second = target("chapters/001-chapter/002-scene.md", "朝の港");
    const draft = "drafts/001-chapter/009-old.md";
    expect(resolveParagraphArtifactPaths("draft", [first.path, second.path, draft], [first, second], { [draft]: { title: "朝の港" } }).size).toBe(0);

    const a = target("chapters/001-chapter/001-scene.md", "Глава 1");
    const b = target("chapters/001-chapter/002-scene.md", "Сцена 1");
    const stale = "drafts/001-chapter/009-old.md";
    const resolved = resolveParagraphArtifactPaths("draft", [a.path, b.path, stale], [a, b], { [stale]: { title: "Сцена 1" } });
    expect(resolved.get(b.path)).toBe(stale);
    expect(resolved.has(a.path)).toBe(false);
  });

  it("matches a draft named by a Unicode title that has no frontmatter title", () => {
    const scene = target("chapters/001-chapter/001-тихая-гавань.md", "Тихая гавань");
    const next = target("chapters/001-chapter/002-ночной-порт.md", "Ночной порт");
    const draft = "drafts/001-chapter/007-тихая-гавань.md";
    const others = ["drafts/001-chapter/008-другое.md", "drafts/001-chapter/009-ещё.md"];
    const resolved = resolveParagraphArtifactPaths("draft", [scene.path, next.path, draft, ...others], [scene, next], {});
    expect(resolved.get(scene.path)).toBe(draft);
    expect(resolved.has(next.path)).toBe(false);
  });
});

describe("naming a research document in the assistant, in any script", () => {
  const files = [
    { path: "research/2026-11-21-research-0crj2m.md", slug: "2026-11-21-research-0crj2m", title: "罗马水道的建造" },
    { path: "research/2026-11-20-research-1abcde.md", slug: "2026-11-20-research-1abcde", title: "Тихая гавань" },
    { path: "research/2026-11-19-roman-aqueducts.md", slug: "2026-11-19-roman-aqueducts", title: "Roman aqueducts" },
  ];

  it("finds the document by its title", () => {
    expect(resolveResearchTarget("create a character from the research 罗马水道的建造", files)).toEqual({ status: "resolved", file: files[0] });
    expect(resolveResearchTarget("crea un luogo dalla ricerca «Тихая гавань»", files)).toEqual({ status: "resolved", file: files[1] });
  });

  it("does not take every document with a title in another script for the one named", () => {
    expect(resolveResearchTarget("create an item from the research on Victorian engines", files).status).toBe("missing");
    expect(resolveResearchTarget("create an item from the research Roman aqueducts", files)).toEqual({ status: "resolved", file: files[2] });
  });

  it("finds the document by an explicit path, even when the author named the file with Unicode letters", () => {
    expect(resolveResearchTarget("create a character from research/2026-11-21-research-0crj2m.md", files)).toEqual({ status: "resolved", file: files[0] });
    const named = [{ path: "research/海辺の町.md", slug: "海辺の町", title: "Harbor" }, ...files];
    expect(resolveResearchTarget("create a character from research/海辺の町.md", named)).toEqual({ status: "resolved", file: named[0] });
  });
});

describe("telling which chapter or scene a name given to cancel an operation refers to, in any script", () => {
  it("matches a name to a folder the author named with Unicode letters", () => {
    expect(targetReferenceMatchesSlug("глава первая", "001-глава-первая")).toBe(true);
    expect(targetReferenceMatchesSlug("Глава Первая", "001-глава-первая")).toBe(true);
    expect(targetReferenceMatchesSlug("海辺の朝", "002-海辺の朝")).toBe(true);
    expect(targetReferenceMatchesSlug("海辺の朝", "003-夜の港")).toBe(false);
    expect(targetReferenceMatchesSlug("Глава вторая", "001-глава-первая")).toBe(false);
  });

  it("never matches a name to a folder just because both are written in another script", () => {
    expect(targetReferenceMatchesSlug("海辺の朝", "001-chapter")).toBe(false);
    expect(targetReferenceMatchesSlug("存在しない", "002-夜の港")).toBe(false);
  });

  it("keeps matching Latin names the way it always did", () => {
    expect(targetReferenceMatchesSlug("First Light", "001-first-light")).toBe(true);
    expect(targetReferenceMatchesSlug("001 first light", "001-first-light")).toBe(true);
    expect(targetReferenceMatchesSlug("Elsewhere", "001-first-light")).toBe(false);
    expect(targetReferenceMatchesSlug(undefined, "001-first-light")).toBe(false);
    expect(targetReferenceMatchesSlug("First Light", undefined)).toBe(false);
  });
});

describe("finding a canon file by what a prompt says, when some files have no name of their own", () => {
  const files = [
    { path: "characters/character-0crj2m.md", name: "Character" },
    { path: "characters/anna.md", name: "Anna" },
    { path: "characters/character-1abcde.md", name: "李明" },
    { path: "secrets/secret-0crj2m.md", name: "Secret" },
  ];

  it("never takes a file that is only listed as 'Character' for the one the prompt names", () => {
    expect(findCanonFileByPrompt(files, "describe the character Anna")?.path).toBe("characters/anna.md");
    expect(findCanonFileByPrompt(files, "tell me about the secret")?.path ?? null).toBeNull();
    expect(findCanonFileByPrompt(files, "who is the character")?.path ?? null).toBeNull();
  });

  it("still finds a nameless file by its file name, and a named one by its name", () => {
    expect(findCanonFileByPrompt(files, "open character 0crj2m")?.path).toBe("characters/character-0crj2m.md");
    expect(findCanonFileByPrompt(files, "who is anna?")?.path).toBe("characters/anna.md");
    expect(findCanonFileByPrompt(files, "who is character 1abcde?")?.path).toBe("characters/character-1abcde.md");
  });
});

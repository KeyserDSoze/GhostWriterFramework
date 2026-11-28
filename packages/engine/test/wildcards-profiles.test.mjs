import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// Wildcards («Fuori dal coro»): fourteen built-in figures that propose (the provocateurs) and check (the sentinels), in English and Italian; a book's file or
// the author's account changes one or adds one; nothing they give is a score, and only a sentinel may know the secrets as the author does.

const {
  BUILTIN_WILDCARD_SLUGS, WILDCARD_PRESETS, WILDCARD_FORMAT_VERSION, WILDCARD_MAX_VOICES, builtinWildcards, emptyWildcard, isValidWildcardSlug, mergeWildcards,
  parseWildcard, pickWildcardVoices, serializeWildcard, wildcardFilePaths, wildcardPath, wildcardPersonaPrompt,
} = engine;

const PROVOCATEURS = ["subversive", "devils-advocate", "cliche-hunter", "twist-engineer", "genre-guest", "naive", "antagonist", "chaos-maker", "poet"];
const SENTINELS = ["ledger-keeper", "continuity-keeper", "secrets-guardian", "domain-expert", "moral-stress-test"];

test("fourteen built-in wildcards in two groups, each with a mandate, a temperament, an audacity, a respect of the canon and an output format, in both languages", () => {
  assert.deepEqual([...BUILTIN_WILDCARD_SLUGS], [...PROVOCATEURS, ...SENTINELS]);
  for (const language of ["en", "it"]) {
    const panel = builtinWildcards(language);
    assert.equal(panel.length, 14);
    assert.deepEqual(panel.filter((profile) => profile.group === "provocateur").map((profile) => profile.slug), PROVOCATEURS);
    assert.deepEqual(panel.filter((profile) => profile.group === "sentinel").map((profile) => profile.slug), SENTINELS);
    for (const profile of panel) {
      assert.equal(profile.id, `wildcard:${profile.slug}`);
      assert.ok(profile.name && profile.mandate && profile.temperament && profile.body, `${language} ${profile.slug}`);
      assert.ok(profile.audacity >= 1 && profile.audacity <= 10);
      assert.ok(["faithful", "flexible", "subversive"].includes(profile.canonRespect));
      assert.equal(profile.builtin, true);
      assert.equal(profile.enabled, true);
      assert.equal(profile.language, language);
      if (profile.group === "sentinel") assert.equal(profile.outputFormat, "findings");
      assert.equal(profile.secrets, profile.slug === "secrets-guardian" ? "author" : "threshold");
    }
  }
  const [en, it] = [builtinWildcards("en"), builtinWildcards("it-IT")];
  assert.equal(en[0].name, "The Subversive");
  assert.equal(it[0].name, "Il Sovversivo");
  assert.notEqual(en.find((profile) => profile.slug === "poet").body, it.find((profile) => profile.slug === "poet").body);
  assert.equal(en.find((profile) => profile.slug === "chaos-maker").outputFormat, "constraints");
  assert.equal(en.find((profile) => profile.slug === "naive").outputFormat, "questions");
  assert.equal(en.find((profile) => profile.slug === "devils-advocate").outputFormat, "objections");
});

test("the presets name three or four built-in voices each: a creative room, a pre-mortem and a check of the narrative quality", () => {
  assert.deepEqual(WILDCARD_PRESETS.map((preset) => preset.id), ["creative-room", "pre-mortem", "quality-check"]);
  for (const preset of WILDCARD_PRESETS) {
    assert.ok(preset.slugs.length >= 3 && preset.slugs.length <= 4, preset.id);
    for (const slug of preset.slugs) assert.ok(BUILTIN_WILDCARD_SLUGS.includes(slug), slug);
  }
  assert.ok(WILDCARD_PRESETS.find((preset) => preset.id === "quality-check").slugs.every((slug) => SENTINELS.includes(slug)));
});

test("a wildcard file round-trips: every field, the persona prompt, and the keys this version does not know", () => {
  const profile = { ...emptyWildcard("en", "provocateur"), id: "wildcard:custom:hacker", slug: "hacker", name: "The Hacker", mandate: "Finds the exploit in every plot.", temperament: "Laconic.", audacity: 8, canonRespect: "subversive", outputFormat: "ideas", domain: "computer security", body: "Think like an attacker.", extra: { mood: "nocturnal", future_key: { nested: [1, 2] } } };
  const text = serializeWildcard(profile);
  assert.match(text, /^---\ntype: wildcard\n/);
  assert.match(text, /canon_respect: subversive/);
  assert.match(text, /mood: nocturnal/);
  const read = parseWildcard("hacker", text);
  assert.deepEqual(read.warnings, []);
  for (const key of ["id", "slug", "name", "group", "mandate", "temperament", "audacity", "canonRespect", "outputFormat", "domain", "secrets", "enabled", "body"]) assert.deepEqual(read[key], profile[key], key);
  assert.deepEqual(read.extra, { mood: "nocturnal", future_key: { nested: [1, 2] } });
  assert.equal(read.version, WILDCARD_FORMAT_VERSION);
  // Written again, the unknown keys are still there.
  assert.equal(serializeWildcard(read), text);
});

test("a file read tolerantly: values out of range or unknown are warnings naming the file, both spellings of the keys are read, and only a sentinel may know the secrets as the author does", () => {
  const read = parseWildcard("odd", "---\nname: Odd\ngroup: Provocateur\naudacity: '12'\ncanonRespect: wild\noutputFormat: questions\nsecrets: author\nenabled: maybe\n---\n\nBody.\n");
  assert.equal(read.group, "provocateur");
  assert.equal(read.audacity, 10);
  assert.equal(read.canonRespect, "flexible");
  assert.equal(read.outputFormat, "questions");
  assert.equal(read.secrets, "threshold");
  assert.equal(read.enabled, true);
  assert.equal(read.warnings.length, 3);
  assert.ok(read.warnings.every((warning) => warning.startsWith("wildcards/odd.md:")));
  assert.ok(read.warnings.some((warning) => /secrets: author is for a sentinel only/.test(warning)));
  const sentinel = parseWildcard("spoilers", "---\nname: Spoilers\ngroup: sentinel\nsecrets: author\n---\n");
  assert.equal(sentinel.secrets, "author");
  assert.equal(sentinel.outputFormat, "findings");
  const broken = parseWildcard("broken", "---\nname: [unclosed\n---\nBody");
  assert.equal(broken.warnings.length, 1);
  assert.match(broken.warnings[0], /not valid YAML/);
});

test("the built-in ones, then the account's, then the book's: a layer changes a wildcard by its id and adds its own, a built-in one stays built-in", () => {
  const account = [
    { ...builtinWildcards("en").find((profile) => profile.slug === "poet"), name: "My Poet", audacity: 9, builtin: false },
    { ...emptyWildcard("en"), id: "wildcard:custom:hacker", slug: "hacker", name: "The Hacker", order: 5 },
  ];
  const book = [
    { ...builtinWildcards("en").find((profile) => profile.slug === "poet"), enabled: false, builtin: false },
    { ...emptyWildcard("en", "sentinel"), id: "wildcard:custom:lawyer", slug: "lawyer", name: "The Lawyer", domain: "criminal law" },
  ];
  const merged = mergeWildcards("en", { account, book });
  assert.equal(merged.length, 16);
  const poet = merged.find((profile) => profile.slug === "poet");
  assert.equal(poet.builtin, true);
  assert.equal(poet.enabled, false);
  assert.equal(poet.source, "book");
  assert.equal(merged.find((profile) => profile.slug === "hacker").source, "account");
  assert.equal(merged.find((profile) => profile.slug === "lawyer").builtin, false);
  // Provocateurs first, then sentinels.
  const firstSentinel = merged.findIndex((profile) => profile.group === "sentinel");
  assert.ok(merged.slice(firstSentinel).every((profile) => profile.group === "sentinel"));
  assert.deepEqual(mergeWildcards("en").map((profile) => profile.slug), [...BUILTIN_WILDCARD_SLUGS]);
});

test("a short file named after a built-in wildcard changes only what it says: two lines turn the Poet off and keep its name, its mandate and its prompt", () => {
  const off = parseWildcard("poet", "---\nenabled: false\n---\n");
  assert.equal(off.id, "wildcard:poet");
  assert.deepEqual(off.fields, ["enabled"]);
  const expert = parseWildcard("domain-expert", "---\ndomain: maritime law\n---\n\nAlso check the insurance of the ships.\n");
  const merged = mergeWildcards("en", { book: [off, expert] });
  const poet = merged.find((profile) => profile.slug === "poet");
  const builtinPoet = builtinWildcards("en").find((profile) => profile.slug === "poet");
  assert.equal(poet.enabled, false);
  assert.equal(poet.name, builtinPoet.name);
  assert.equal(poet.mandate, builtinPoet.mandate);
  assert.equal(poet.body, builtinPoet.body);
  assert.equal(poet.source, "book");
  const domain = merged.find((profile) => profile.slug === "domain-expert");
  assert.equal(domain.domain, "maritime law");
  assert.equal(domain.body, "Also check the insurance of the ships.");
  assert.equal(domain.group, "sentinel");
  assert.equal(domain.name, "The Domain Expert");
  // A file of another name without an id is one of the author's own.
  assert.equal(parseWildcard("hacker", "---\nname: The Hacker\n---\n").id, "wildcard:custom:hacker");
});

test("the voices of a consultation: a preset or the author's choice, enabled ones only, in the order asked, each once, never more than the cap", () => {
  const panel = builtinWildcards("en").map((profile) => (profile.slug === "poet" ? { ...profile, enabled: false } : profile));
  assert.deepEqual(pickWildcardVoices(panel, { preset: "creative-room" }).map((profile) => profile.slug), ["subversive", "cliche-hunter", "twist-engineer"]);
  assert.deepEqual(pickWildcardVoices(panel, { slugs: ["naive", "naive", "antagonist", "unknown"] }).map((profile) => profile.slug), ["naive", "antagonist"]);
  assert.equal(pickWildcardVoices(panel, { group: "sentinel" }).length, 4);
  assert.ok(pickWildcardVoices(panel, { group: "sentinel" }).every((profile) => profile.group === "sentinel"));
  assert.equal(pickWildcardVoices(panel, { slugs: BUILTIN_WILDCARD_SLUGS, max: 50 }).length, WILDCARD_MAX_VOICES);
  // A file with warnings is never asked.
  const warned = panel.map((profile) => (profile.slug === "naive" ? { ...profile, warnings: ["wildcards/naive.md: bad"] } : profile));
  assert.deepEqual(pickWildcardVoices(warned, { slugs: ["naive", "antagonist"] }).map((profile) => profile.slug), ["antagonist"]);
});

test("the persona's part of a prompt says who it is, how far it goes and what it gives; the paths of the files are file names", () => {
  const subversive = builtinWildcards("en")[0];
  const prompt = wildcardPersonaPrompt(subversive);
  assert.match(prompt, /«The Subversive»/);
  assert.match(prompt, /a provocateur/);
  assert.match(prompt, /Audacity: 9\/10/);
  assert.match(prompt, /change the canon itself/);
  assert.match(wildcardPersonaPrompt(builtinWildcards("en").find((profile) => profile.slug === "domain-expert")), /a sentinel/);
  assert.equal(wildcardPath({ slug: "hacker", name: "x" }), "wildcards/hacker.md");
  assert.equal(wildcardPath({ slug: "../evil", name: "The Hacker" }), "wildcards/the-hacker.md");
  assert.equal(isValidWildcardSlug("a/b"), false);
  assert.deepEqual(wildcardFilePaths(["wildcards/b.md", "wildcards/a.md", "wildcards/sub/c.md", "bible/ideas.yml", "personas/x.md"]), ["wildcards/a.md", "wildcards/b.md"]);
});

import { parseDocument, stringify } from "yaml";
import { slugify } from "@/narrarium/canon";

export type ReaderPersonaType = "standard" | "genre" | "custom";
export type ReaderEvaluationDepth = "brief" | "normal" | "deep";

export interface ReaderPersonaProfile {
  id: string;
  slug: string;
  name: string;
  description: string;
  language: string;
  readerType: ReaderPersonaType;
  profile: string;
  aspects: string[];
  preferredGenres: string[];
  dislikedGenres: string[];
  experienceLevel: string;
  severity: number;
  audienceAge: string;
  interests: string[];
  appreciatedElements: string[];
  frequentCriticisms: string[];
  customPrompt: string;
  enabled: boolean;
  order: number;
  builtin: boolean;
  version: number;
  body: string;
  path?: string;
}

interface LocalizedPreset {
  name: string;
  description: string;
  profile: string;
  aspects: string[];
}

const STANDARD_PRESETS: Array<{ id: string; severity: number; en: LocalizedPreset; it: LocalizedPreset }> = [
  { id: "standard.general", severity: 5, en: { name: "General Reader", description: "An accessible average reader focused on clarity, flow, interest, and engagement.", profile: "A broadly read non-specialist who reacts like the intended general audience.", aspects: ["clarity", "interest", "flow", "comprehension", "engagement", "pacing"] }, it: { name: "Lettore generalista", description: "Un lettore medio accessibile, attento a chiarezza, scorrevolezza, interesse e coinvolgimento.", profile: "Un lettore non specialista ma abituato a leggere, rappresentativo del pubblico generale.", aspects: ["chiarezza", "interesse", "scorrevolezza", "comprensione", "coinvolgimento", "ritmo"] } },
  { id: "standard.emotional", severity: 5, en: { name: "Emotional Reader", description: "Measures empathy, emotional authenticity, tension, and lasting impact.", profile: "A reader who notices whether a scene genuinely creates feeling rather than merely naming it.", aspects: ["empathy", "emotional intensity", "authentic reactions", "tension", "lasting impression"] }, it: { name: "Lettore emotivo", description: "Misura empatia, autenticità emotiva, tensione e impatto duraturo.", profile: "Un lettore attento a ciò che la scena fa provare davvero, non soltanto alle emozioni dichiarate.", aspects: ["empatia", "intensità emotiva", "reazioni autentiche", "tensione", "impressione lasciata"] } },
  { id: "standard.critical", severity: 9, en: { name: "Critical Reader", description: "A demanding reader who actively seeks logical, structural, pacing, and prose weaknesses.", profile: "A severe but evidence-based reader who never offers generic criticism or comfort praise.", aspects: ["inconsistencies", "repetition", "logic", "artificial dialogue", "exposition", "predictability", "pacing"] }, it: { name: "Lettore critico", description: "Un lettore esigente che cerca attivamente debolezze logiche, strutturali, ritmiche e stilistiche.", profile: "Un lettore severo ma basato su prove testuali, che evita critiche generiche e complimenti di cortesia.", aspects: ["incoerenze", "ripetizioni", "logica", "dialoghi artificiali", "esposizione", "prevedibilità", "ritmo"] } },
  { id: "standard.characters", severity: 7, en: { name: "Character Reader", description: "Focuses on motivation, behavioral consistency, voice, relationships, conflict, and emotional credibility.", profile: "A character-driven reader especially attentive to dialogue and personal development.", aspects: ["characterization", "motivation", "behavior", "voice", "dialogue differentiation", "relationships", "arc"] }, it: { name: "Lettore orientato ai personaggi", description: "Si concentra su motivazioni, coerenza comportamentale, voce, relazioni, conflitto e credibilità emotiva.", profile: "Un lettore character-driven particolarmente attento ai dialoghi e allo sviluppo personale.", aspects: ["caratterizzazione", "motivazioni", "comportamento", "voce", "differenziazione dialoghi", "relazioni", "arco"] } },
  { id: "standard.plot", severity: 7, en: { name: "Plot Reader", description: "Judges story movement, scene purpose, causality, conflict, promises, openings, and endings.", profile: "A plot-oriented reader who distinguishes pleasant prose from material that serves the story.", aspects: ["story advancement", "scene goal", "conflict", "cause and effect", "narrative tension", "promises", "opening", "closing"] }, it: { name: "Lettore orientato alla trama", description: "Valuta avanzamento della storia, funzione della scena, causalità, conflitto, promesse, aperture e chiusure.", profile: "Un lettore orientato alla trama che distingue la prosa piacevole dal materiale realmente utile alla storia.", aspects: ["avanzamento", "obiettivo scena", "conflitto", "causa ed effetto", "tensione narrativa", "promesse", "apertura", "chiusura"] } },
  { id: "standard.style", severity: 7, en: { name: "Style Reader", description: "Evaluates narrative voice, diction, sentence flow, precision, tone, repetition, and writing-style adherence.", profile: "A prose-sensitive reader who evaluates writing quality without rewriting unless asked.", aspects: ["narrative voice", "diction", "sentence construction", "repetition", "precision", "tone", "style consistency"] }, it: { name: "Lettore orientato allo stile", description: "Valuta voce narrativa, lessico, fluidità, precisione, tono, ripetizioni e aderenza allo stile di scrittura.", profile: "Un lettore sensibile alla prosa che valuta la qualità senza riscrivere, salvo richiesta.", aspects: ["voce narrativa", "lessico", "costruzione frasi", "ripetizioni", "precisione", "tono", "coerenza stilistica"] } },
  { id: "standard.worldbuilding", severity: 6, en: { name: "Worldbuilding Reader", description: "Tests world credibility, internal rules, settings, exposition, originality, and integration with plot and characters.", profile: "A reader who wants the world to feel coherent and alive without being delivered as an infodump.", aspects: ["world credibility", "internal rules", "setting", "information integration", "infodump", "originality", "continuity"] }, it: { name: "Lettore orientato al worldbuilding", description: "Verifica credibilità del mondo, regole interne, ambientazioni, esposizione, originalità e integrazione con trama e personaggi.", profile: "Un lettore che vuole un mondo coerente e vivo, senza infodump.", aspects: ["credibilità del mondo", "regole interne", "ambientazione", "integrazione informazioni", "infodump", "originalità", "continuità"] } },
  { id: "standard.continuity", severity: 8, en: { name: "Continuity Reader", description: "Checks names, chronology, knowledge boundaries, objects, facts, and consistency with structured canon.", profile: "A continuity-focused reader who uses only the supplied context and identifies precise contradictions.", aspects: ["contradictions", "timeline", "character knowledge", "objects", "names", "canon continuity"] }, it: { name: "Lettore orientato alla continuità", description: "Controlla nomi, cronologia, limiti di conoscenza, oggetti, fatti e coerenza con il canone strutturato.", profile: "Un lettore focalizzato sulla continuità che usa soltanto il contesto fornito e segnala contraddizioni precise.", aspects: ["contraddizioni", "timeline", "conoscenze dei personaggi", "oggetti", "nomi", "continuità canonica"] } },
];

const GENRE_PRESETS: Array<{ id: string; en: [string, string]; it: [string, string]; aspects: string[] }> = [
  { id: "fantasy", en: ["Fantasy Reader", "Genre reader for worldbuilding, magic rules, wonder, concepts, and exposition/action balance."], it: ["Lettore Fantasy", "Lettore di genere per worldbuilding, regole della magia, meraviglia, concetti ed equilibrio esposizione/azione."], aspects: ["worldbuilding", "magic rules", "sense of wonder", "concept clarity", "exposition"] },
  { id: "science-fiction", en: ["Science Fiction Reader", "Genre reader for speculative credibility, technology, social consequences, and concept clarity."], it: ["Lettore Science Fiction", "Lettore di genere per credibilità speculativa, tecnologia, conseguenze sociali e chiarezza concettuale."], aspects: ["speculative idea", "technology", "science", "social consequences", "clarity"] },
  { id: "romance", en: ["Romance Reader", "Genre reader for chemistry, romantic tension, emotional authenticity, relationship progression, and conflict."], it: ["Lettore Romance", "Lettore di genere per chimica, tensione romantica, autenticità emotiva, progressione della relazione e conflitto."], aspects: ["chemistry", "romantic tension", "relationship progression", "emotional authenticity"] },
  { id: "thriller", en: ["Thriller Reader", "Genre reader for tension, urgency, risk, escalation, and pace."], it: ["Lettore Thriller", "Lettore di genere per tensione, urgenza, rischio, escalation e ritmo."], aspects: ["tension", "urgency", "risk", "escalation", "pace"] },
  { id: "mystery", en: ["Mystery Reader", "Genre reader for clues, fair play, suspicion, misdirection, mystery, and solution predictability."], it: ["Lettore Mystery / Giallo", "Lettore di genere per indizi, correttezza narrativa, sospetti, depistaggi, mistero e prevedibilità della soluzione."], aspects: ["clues", "fair play", "mystery", "suspects", "misdirection", "predictability"] },
  { id: "crime", en: ["Crime Reader", "Genre reader for criminal logic, investigation, stakes, realism, and moral tension."], it: ["Lettore Crime", "Lettore di genere per logica criminale, indagine, posta in gioco, realismo e tensione morale."], aspects: ["crime logic", "investigation", "stakes", "realism", "moral tension"] },
  { id: "horror", en: ["Horror Reader", "Genre reader for atmosphere, dread, fear construction, originality, and explicit or implied horror."], it: ["Lettore Horror", "Lettore di genere per atmosfera, inquietudine, costruzione della paura, originalità e orrore esplicito o implicito."], aspects: ["atmosphere", "dread", "fear", "originality", "horror impact"] },
  { id: "historical-fiction", en: ["Historical Fiction Reader", "Genre reader for historical plausibility, language, cultural detail, anachronisms, and narrative balance."], it: ["Lettore Romanzo storico", "Lettore di genere per plausibilità storica, linguaggio, dettagli culturali, anacronismi ed equilibrio narrativo."], aspects: ["historical plausibility", "language", "setting", "culture", "anachronisms"] },
  { id: "adventure", en: ["Adventure Reader", "Genre reader for momentum, discovery, danger, goals, obstacles, and payoff."], it: ["Lettore Adventure", "Lettore di genere per slancio, scoperta, pericolo, obiettivi, ostacoli e payoff."], aspects: ["momentum", "discovery", "danger", "goals", "obstacles", "payoff"] },
  { id: "young-adult", en: ["Young Adult Reader", "Genre reader for accessibility, voice, authentic characters, themes, pace, and target-audience engagement."], it: ["Lettore Young Adult", "Lettore di genere per accessibilità, voce, autenticità dei personaggi, temi, ritmo e coinvolgimento del pubblico."], aspects: ["accessibility", "voice", "authenticity", "themes", "pace"] },
  { id: "dystopian", en: ["Dystopian Reader", "Genre reader for social systems, oppression, consequences, credibility, resistance, and thematic force."], it: ["Lettore Distopico", "Lettore di genere per sistemi sociali, oppressione, conseguenze, credibilità, resistenza e forza tematica."], aspects: ["social system", "oppression", "consequences", "resistance", "theme"] },
  { id: "literary-fiction", en: ["Literary Fiction Reader", "Genre reader for language, ambiguity, character depth, theme, structure, and resonance."], it: ["Lettore Narrativa letteraria", "Lettore di genere per linguaggio, ambiguità, profondità dei personaggi, tema, struttura e risonanza."], aspects: ["language", "ambiguity", "character depth", "theme", "structure"] },
  { id: "comedy", en: ["Comedy Reader", "Genre reader for timing, setup, payoff, character comedy, tone, and repetition."], it: ["Lettore Commedia", "Lettore di genere per timing, preparazione, payoff, comicità dei personaggi, tono e ripetizioni."], aspects: ["timing", "setup", "payoff", "comic voice", "tone"] },
  { id: "drama", en: ["Drama Reader", "Genre reader for conflict, stakes, emotional truth, relationships, and escalation."], it: ["Lettore Drama", "Lettore di genere per conflitto, posta in gioco, verità emotiva, relazioni ed escalation."], aspects: ["conflict", "stakes", "emotional truth", "relationships", "escalation"] },
  { id: "action", en: ["Action Reader", "Genre reader for choreography, spatial clarity, stakes, tempo, impact, and escalation."], it: ["Lettore Action", "Lettore di genere per coreografia, chiarezza spaziale, posta in gioco, tempo, impatto ed escalation."], aspects: ["choreography", "spatial clarity", "stakes", "tempo", "impact"] },
  { id: "paranormal", en: ["Paranormal Reader", "Genre reader for supernatural rules, atmosphere, mystery, character reaction, and internal consistency."], it: ["Lettore Paranormal", "Lettore di genere per regole soprannaturali, atmosfera, mistero, reazioni dei personaggi e coerenza interna."], aspects: ["supernatural rules", "atmosphere", "mystery", "character reaction"] },
  { id: "urban-fantasy", en: ["Urban Fantasy Reader", "Genre reader for modern-world integration, hidden systems, magic, voice, pace, and genre balance."], it: ["Lettore Urban Fantasy", "Lettore di genere per integrazione col mondo moderno, sistemi nascosti, magia, voce, ritmo ed equilibrio."], aspects: ["modern setting", "hidden world", "magic", "voice", "pace"] },
  { id: "dark-fantasy", en: ["Dark Fantasy Reader", "Genre reader for darkness, moral complexity, horror/fantasy balance, atmosphere, and consequence."], it: ["Lettore Dark Fantasy", "Lettore di genere per oscurità, complessità morale, equilibrio horror/fantasy, atmosfera e conseguenze."], aspects: ["darkness", "moral complexity", "atmosphere", "consequence"] },
  { id: "epic-fantasy", en: ["Epic Fantasy Reader", "Genre reader for scale, lore, multiple arcs, world coherence, stakes, and payoff."], it: ["Lettore Epic Fantasy", "Lettore di genere per scala, lore, archi multipli, coerenza del mondo, posta in gioco e payoff."], aspects: ["scale", "lore", "multiple arcs", "world coherence", "stakes"] },
  { id: "childrens-fiction", en: ["Children's Fiction Reader", "Genre reader for age-appropriate clarity, wonder, rhythm, emotional safety, and engagement."], it: ["Lettore Narrativa per ragazzi", "Lettore di genere per chiarezza adeguata all'età, meraviglia, ritmo, sicurezza emotiva e coinvolgimento."], aspects: ["age suitability", "clarity", "wonder", "rhythm", "engagement"] },
];

function localizedLanguage(language?: string): "it" | "en" {
  return language?.toLowerCase().startsWith("it") ? "it" : "en";
}

function baseProfile(input: { id: string; name: string; description: string; profile: string; aspects: string[]; type: ReaderPersonaType; severity: number; order: number; language: string }): ReaderPersonaProfile {
  const slug = input.id.replace(/\./g, "-");
  return {
    id: `reader:${input.id}`,
    slug,
    name: input.name,
    description: input.description,
    language: input.language,
    readerType: input.type,
    profile: input.profile,
    aspects: input.aspects,
    preferredGenres: input.type === "genre" ? [input.id.replace(/^genre\./, "")] : [],
    dislikedGenres: [],
    experienceLevel: "experienced",
    severity: input.severity,
    audienceAge: "adult",
    interests: [],
    appreciatedElements: [],
    frequentCriticisms: [],
    customPrompt: "",
    enabled: input.type === "standard",
    order: input.order,
    builtin: true,
    version: 1,
    body: input.description,
  };
}

export function builtinReaderPersonas(language?: string): ReaderPersonaProfile[] {
  const lang = localizedLanguage(language);
  const standard = STANDARD_PRESETS.map((preset, index) => {
    const localized = preset[lang];
    return baseProfile({ id: preset.id, ...localized, type: "standard", severity: preset.severity, order: index, language: lang });
  });
  const genres = GENRE_PRESETS.map((preset, index) => {
    const localized = preset[lang];
    return baseProfile({ id: `genre.${preset.id}`, name: localized[0], description: localized[1], profile: localized[1], aspects: preset.aspects, type: "genre", severity: 6, order: 100 + index, language: lang });
  });
  return [...standard, ...genres];
}

export function emptyReaderPersona(language = "en", order = 1000): ReaderPersonaProfile {
  return {
    id: `reader:custom:${crypto.randomUUID()}`,
    slug: "new-reader",
    name: "",
    description: "",
    language: localizedLanguage(language),
    readerType: "custom",
    profile: "",
    aspects: [],
    preferredGenres: [],
    dislikedGenres: [],
    experienceLevel: "average",
    severity: 5,
    audienceAge: "adult",
    interests: [],
    appreciatedElements: [],
    frequentCriticisms: [],
    customPrompt: "",
    enabled: true,
    order,
    builtin: false,
    version: 1,
    body: "",
  };
}

export function parseReaderPersona(slug: string, raw: string): ReaderPersonaProfile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const frontmatter = match ? ((parseDocument(match[1]).toJSON() as Record<string, unknown> | null) ?? {}) : {};
  const list = (key: string) => Array.isArray(frontmatter[key]) ? (frontmatter[key] as unknown[]).map(String) : [];
  const text = (key: string, fallback = "") => typeof frontmatter[key] === "string" ? String(frontmatter[key]) : fallback;
  return {
    id: text("id", `reader:custom:${slug}`),
    slug,
    name: text("name", slug),
    description: text("description"),
    language: text("language", "en"),
    readerType: (text("reader_type", "custom") as ReaderPersonaType),
    profile: text("profile"),
    aspects: list("aspects"),
    preferredGenres: list("preferred_genres"),
    dislikedGenres: list("disliked_genres"),
    experienceLevel: text("experience_level", "average"),
    severity: typeof frontmatter.severity === "number" ? frontmatter.severity : 5,
    audienceAge: text("audience_age", "adult"),
    interests: list("interests"),
    appreciatedElements: list("appreciated_elements"),
    frequentCriticisms: list("frequent_criticisms"),
    customPrompt: text("custom_prompt"),
    enabled: frontmatter.enabled !== false,
    order: typeof frontmatter.order === "number" ? frontmatter.order : 1000,
    builtin: frontmatter.builtin === true,
    version: typeof frontmatter.version === "number" ? frontmatter.version : 1,
    body: match?.[2]?.trim() ?? raw.trim(),
    path: `personas/${slug}.md`,
  };
}

export function serializeReaderPersona(profile: ReaderPersonaProfile): string {
  const frontmatter = {
    type: "reader-persona",
    id: profile.id,
    name: profile.name,
    description: profile.description,
    language: profile.language,
    reader_type: profile.readerType,
    profile: profile.profile,
    aspects: profile.aspects,
    preferred_genres: profile.preferredGenres,
    disliked_genres: profile.dislikedGenres,
    experience_level: profile.experienceLevel,
    severity: profile.severity,
    audience_age: profile.audienceAge,
    interests: profile.interests,
    appreciated_elements: profile.appreciatedElements,
    frequent_criticisms: profile.frequentCriticisms,
    custom_prompt: profile.customPrompt,
    enabled: profile.enabled,
    order: profile.order,
    builtin: profile.builtin,
    version: profile.version,
  };
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${profile.body.trim()}\n`;
}

export function mergeReaderPersonas(language: string | undefined, overrides: ReaderPersonaProfile[]): ReaderPersonaProfile[] {
  const byId = new Map(overrides.map((profile) => [profile.id, profile]));
  const builtins = builtinReaderPersonas(language).map((profile) => byId.get(profile.id) ? { ...profile, ...byId.get(profile.id), builtin: true } : profile);
  const builtinIds = new Set(builtins.map((profile) => profile.id));
  return [...builtins, ...overrides.filter((profile) => !builtinIds.has(profile.id))].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function readerPersonaPath(profile: ReaderPersonaProfile): string {
  const slug = profile.slug || slugify(profile.name) || `reader-${crypto.randomUUID().slice(0, 8)}`;
  return `personas/${slug}.md`;
}

export function readerPersonaSystemPrompt(profile: ReaderPersonaProfile, outputLanguage: string, depth: ReaderEvaluationDepth): string {
  const length = depth === "brief" ? "Keep each section to one or two concise bullets/sentences." : depth === "deep" ? "Provide a thorough but focused evaluation with textual evidence." : "Keep the evaluation concise and useful.";
  return [
    `You are simulating the point of view of this reader: ${profile.name}.`,
    profile.description,
    profile.profile,
    `Severity: ${profile.severity}/10. Experience: ${profile.experienceLevel}. Indicative audience: ${profile.audienceAge}.`,
    profile.aspects.length ? `Focus especially on: ${profile.aspects.join(", ")}.` : "",
    profile.preferredGenres.length ? `Genres appreciated: ${profile.preferredGenres.join(", ")}.` : "",
    profile.dislikedGenres.length ? `Genres usually disliked: ${profile.dislikedGenres.join(", ")}. Do not penalize genre mixing automatically.` : "",
    profile.interests.length ? `Interests: ${profile.interests.join(", ")}.` : "",
    profile.appreciatedElements.length ? `Often appreciates: ${profile.appreciatedElements.join(", ")}.` : "",
    profile.frequentCriticisms.length ? `Often criticizes: ${profile.frequentCriticisms.join(", ")}.` : "",
    profile.customPrompt,
    "Evaluate from this reader's viewpoint, not as an absolute critic. Motivate observations with evidence. Avoid generic feedback. Do not rewrite the source text unless explicitly requested.",
    length,
    `Return the feedback in ${outputLanguage}.`,
  ].filter(Boolean).join("\n\n");
}

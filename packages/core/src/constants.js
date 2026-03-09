export const SKILL_NAME = "narrarium-book";
export const BOOK_DIRECTORIES = [
    "guidelines",
    "characters",
    "items",
    "locations",
    "factions",
    "timelines",
    "timelines/events",
    "secrets",
    "chapters",
    "resumes",
    "resumes/chapters",
    "evaluations",
    "evaluations/chapters",
    "research",
    "research/wikipedia",
    "research/wikipedia/en",
    "research/wikipedia/it",
    "assets",
    ".opencode/skills",
    ".claude/skills",
];
export const ENTITY_TYPE_TO_DIRECTORY = {
    character: "characters",
    item: "items",
    location: "locations",
    faction: "factions",
    secret: "secrets",
    "timeline-event": "timelines/events",
};
export const ENTITY_TYPES = Object.keys(ENTITY_TYPE_TO_DIRECTORY);
export const DEFAULT_CANON = "draft";
export const BOOK_FILE = "book.md";
export const GUIDELINE_FILES = {
    style: "guidelines/style.md",
    chapterRules: "guidelines/chapter-rules.md",
    voices: "guidelines/voices.md",
    structure: "guidelines/structure.md",
};
export const TIMELINE_MAIN_FILE = "timelines/main.md";
export const TOTAL_RESUME_FILE = "resumes/total.md";
export const TOTAL_EVALUATION_FILE = "evaluations/total.md";
export const CONTENT_GLOB = [
    "book.md",
    "guidelines/**/*.md",
    "characters/**/*.md",
    "items/**/*.md",
    "locations/**/*.md",
    "factions/**/*.md",
    "timelines/**/*.md",
    "secrets/**/*.md",
    "chapters/**/*.md",
    "resumes/**/*.md",
    "evaluations/**/*.md",
    "research/**/*.md",
];
//# sourceMappingURL=constants.js.map
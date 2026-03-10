export const SKILL_NAME = "narrarium-book";

export const BOOK_DIRECTORIES = [
  "guidelines",
  "guidelines/styles",
  "characters",
  "items",
  "locations",
  "factions",
  "timelines",
  "timelines/events",
  "secrets",
  "chapters",
  "drafts",
  "conversations",
  "conversations/sessions",
  "resumes",
  "resumes/chapters",
  "state",
  "state/chapters",
  "evaluations",
  "evaluations/chapters",
  "research",
  "research/wikipedia",
  "research/wikipedia/en",
  "research/wikipedia/it",
  "assets",
  "assets/book",
  "assets/characters",
  "assets/items",
  "assets/locations",
  "assets/factions",
  "assets/timelines",
  "assets/timelines/events",
  "assets/secrets",
  "assets/chapters",
  ".opencode/skills",
  ".opencode/commands",
  ".opencode/plugins",
  ".claude/skills",
] as const;

export const ENTITY_TYPE_TO_DIRECTORY = {
  character: "characters",
  item: "items",
  location: "locations",
  faction: "factions",
  secret: "secrets",
  "timeline-event": "timelines/events",
} as const;

export const ENTITY_TYPES = Object.keys(ENTITY_TYPE_TO_DIRECTORY) as Array<
  keyof typeof ENTITY_TYPE_TO_DIRECTORY
>;

export const DEFAULT_CANON = "draft";

export const BOOK_FILE = "book.md";
export const PLOT_FILE = "plot.md";

export const GUIDELINE_FILES = {
  prose: "guidelines/prose.md",
  style: "guidelines/style.md",
  chapterRules: "guidelines/chapter-rules.md",
  voices: "guidelines/voices.md",
  structure: "guidelines/structure.md",
  images: "guidelines/images.md",
} as const;

export const TIMELINE_MAIN_FILE = "timelines/main.md";
export const TOTAL_RESUME_FILE = "resumes/total.md";
export const TOTAL_EVALUATION_FILE = "evaluations/total.md";
export const STORY_STATE_STATUS_FILE = "state/status.md";
export const STORY_STATE_CURRENT_FILE = "state/current.md";

export const CONTENT_GLOB = [
  "book.md",
  "plot.md",
  "guidelines/**/*.md",
  "characters/**/*.md",
  "items/**/*.md",
  "locations/**/*.md",
  "factions/**/*.md",
  "timelines/**/*.md",
  "secrets/**/*.md",
  "chapters/**/*.md",
  "drafts/**/*.md",
  "resumes/**/*.md",
  "state/**/*.md",
  "evaluations/**/*.md",
  "research/**/*.md",
  "assets/**/*.md",
];

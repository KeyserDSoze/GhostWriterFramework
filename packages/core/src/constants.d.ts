export declare const SKILL_NAME = "narrarium-book";
export declare const BOOK_DIRECTORIES: readonly ["guidelines", "characters", "items", "locations", "factions", "timelines", "timelines/events", "secrets", "chapters", "resumes", "resumes/chapters", "evaluations", "evaluations/chapters", "research", "research/wikipedia", "research/wikipedia/en", "research/wikipedia/it", "assets", ".opencode/skills", ".claude/skills"];
export declare const ENTITY_TYPE_TO_DIRECTORY: {
    readonly character: "characters";
    readonly item: "items";
    readonly location: "locations";
    readonly faction: "factions";
    readonly secret: "secrets";
    readonly "timeline-event": "timelines/events";
};
export declare const ENTITY_TYPES: Array<keyof typeof ENTITY_TYPE_TO_DIRECTORY>;
export declare const DEFAULT_CANON = "draft";
export declare const BOOK_FILE = "book.md";
export declare const GUIDELINE_FILES: {
    readonly style: "guidelines/style.md";
    readonly chapterRules: "guidelines/chapter-rules.md";
    readonly voices: "guidelines/voices.md";
    readonly structure: "guidelines/structure.md";
};
export declare const TIMELINE_MAIN_FILE = "timelines/main.md";
export declare const TOTAL_RESUME_FILE = "resumes/total.md";
export declare const TOTAL_EVALUATION_FILE = "evaluations/total.md";
export declare const CONTENT_GLOB: string[];
//# sourceMappingURL=constants.d.ts.map
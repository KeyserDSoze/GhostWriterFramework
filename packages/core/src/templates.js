import YAML from "yaml";
function frontmatterBlock(frontmatter) {
    const yaml = YAML.stringify(frontmatter).trimEnd();
    return `---\n${yaml}\n---\n`;
}
export function renderMarkdown(frontmatter, body) {
    return `${frontmatterBlock(frontmatter)}\n${body.trim()}\n`;
}
export function defaultBodyForType(type) {
    switch (type) {
        case "book":
            return [
                "# Premise",
                "",
                "Describe the book in one paragraph.",
                "",
                "# Core Promise",
                "",
                "What kind of experience should the reader expect?",
            ].join("\n");
        case "guideline":
            return [
                "# Rules",
                "",
                "- Add clear rules here.",
                "",
                "# Notes",
                "",
                "Capture examples, anti-patterns, and edge cases.",
            ].join("\n");
        case "character":
            return [
                "# Overview",
                "",
                "# Role In Story",
                "",
                "# Relationships",
                "",
                "# Public Knowledge",
                "",
                "# Private Knowledge",
                "",
                "# Open Questions",
            ].join("\n");
        case "item":
            return [
                "# Overview",
                "",
                "# Properties",
                "",
                "# Ownership",
                "",
                "# Story Use",
            ].join("\n");
        case "location":
            return [
                "# Overview",
                "",
                "# Atmosphere",
                "",
                "# Key Details",
                "",
                "# Story Use",
            ].join("\n");
        case "faction":
            return [
                "# Overview",
                "",
                "# Goals",
                "",
                "# Resources",
                "",
                "# Allies And Enemies",
            ].join("\n");
        case "secret":
            return [
                "# What Is Hidden",
                "",
                "# Who Knows",
                "",
                "# Reveal Strategy",
                "",
                "# Consequences",
            ].join("\n");
        case "timeline-event":
            return [
                "# Event",
                "",
                "# Participants",
                "",
                "# Consequences",
            ].join("\n");
        case "chapter":
            return [
                "# Purpose",
                "",
                "# Beats",
                "",
                "# Notes",
            ].join("\n");
        case "paragraph":
            return [
                "# Scene",
                "",
                "Write the paragraph or scene here.",
            ].join("\n");
        case "research-note":
            return [
                "# Summary",
                "",
                "# Key Facts",
                "",
                "# Relevance To Book",
            ].join("\n");
        default:
            return "# Notes\n";
    }
}
//# sourceMappingURL=templates.js.map
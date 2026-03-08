import YAML from "yaml";

function frontmatterBlock(frontmatter: Record<string, unknown>): string {
  const yaml = YAML.stringify(frontmatter).trimEnd();
  return `---\n${yaml}\n---\n`;
}

export function renderMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  return `${frontmatterBlock(frontmatter)}\n${body.trim()}\n`;
}

export function defaultBodyForType(type: string): string {
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
        "# Voice",
        "",
        "# Backstory",
        "",
        "# Role In Story",
        "",
        "# Function In Book",
        "",
        "# Motivations And Fears",
        "",
        "# Relationships",
        "",
        "# Public Knowledge",
        "",
        "# Private Knowledge",
        "",
        "# Arc Notes",
        "",
        "# Open Questions",
      ].join("\n");
    case "item":
      return [
        "# Overview",
        "",
        "# Appearance",
        "",
        "# Properties",
        "",
        "# Function In Book",
        "",
        "# Ownership",
        "",
        "# Origin Story",
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
        "# Function In Book",
        "",
        "# Landmarks And Risks",
        "",
        "# Story Use",
      ].join("\n");
    case "faction":
      return [
        "# Overview",
        "",
        "# Goals",
        "",
        "# Ideology",
        "",
        "# Function In Book",
        "",
        "# Resources",
        "",
        "# Allies And Enemies",
      ].join("\n");
    case "secret":
      return [
        "# What Is Hidden",
        "",
        "# Function In Book",
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

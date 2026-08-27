import YAML from "yaml";
import { marked, Renderer } from "marked";

function frontmatterBlock(frontmatter: Record<string, unknown>): string {
  const yaml = YAML.stringify(frontmatter)
    .trimEnd()
    .replace(/^aspect_ratio:\s+([0-9]+:[0-9]+)$/m, 'aspect_ratio: "$1"');
  return `---\n${yaml}\n---\n`;
}

export function renderMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  return `${frontmatterBlock(frontmatter)}\n${body.trim()}\n`;
}

/** Render repository-authored Markdown without allowing raw HTML or unsafe URLs. */
export function renderSafeMarkdownHtml(markdown: string): string {
  return renderMarkdownHtml(markdown, () => true);
}

/** Render Markdown for EPUB content, where only in-document fragment links are packaged. */
export function renderEpubMarkdownHtml(markdown: string): string {
  return renderMarkdownHtml(markdown, (href) => href.startsWith("#"));
}

function renderMarkdownHtml(markdown: string, allowLink: (href: string) => boolean): string {
  const renderer = new Renderer();
  renderer.html = () => "";
  renderer.link = function ({ href, tokens }) {
    const safeHref = safeMarkdownUrl(href);
    const text = this.parser.parseInline(tokens);
    return safeHref && allowLink(safeHref) ? `<a href="${escapeHtmlAttribute(safeHref)}">${text}</a>` : text;
  };
  renderer.image = ({ text }) => escapeHtml(text);

  return marked.parse(markdown, { async: false, renderer }) as string;
}

function safeMarkdownUrl(value: string): string | null {
  const normalized = value.replace(/[\u0000-\u0020\u007f]+/g, "").trim();
  if (!normalized || /^(?:javascript|data|vbscript|file):/i.test(normalized) || normalized.startsWith("//")) {
    return null;
  }

  return /^(?:https?:|mailto:|#|\/|\.{0,2}(?:\/|$)|[^\s:]+(?:[/?#]|$))/i.test(normalized) ? normalized : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
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
        "# Identity And Change",
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
    case "chapter-draft":
      return [
        "# Rough Intent",
        "",
        "What should this chapter accomplish before prose gets polished?",
        "",
        "# Rough Beats",
        "",
        "List the chapter's provisional movements, reveals, and emotional turns.",
        "",
        "# Continuity Checks",
        "",
        "Note what earlier chapters, secrets, or guidelines must be respected.",
      ].join("\n");
    case "paragraph":
      return [
        "# Scene",
        "",
        "Write the paragraph or scene here.",
      ].join("\n");
    case "paragraph-draft":
      return [
        "# Rough Scene",
        "",
        "Capture the raw version of the scene, including fragments, beats, and dialogue ideas.",
        "",
        "# Intent",
        "",
        "State what this scene must change, reveal, or pressure.",
        "",
        "# Carry Into Final Prose",
        "",
        "List the lines, images, or subtext that should survive into the finished paragraph.",
      ].join("\n");
    case "research-note":
      return [
        "# Summary",
        "",
        "# Key Facts",
        "",
        "# Relevance To Book",
      ].join("\n");
    case "asset":
      return [
        "# Intent",
        "",
        "Describe what this image should communicate in the book.",
        "",
        "# Prompt",
        "",
        "Write the exact generation prompt here.",
        "",
        "# Notes",
        "",
        "Capture style constraints, continuity notes, and variation guidance.",
      ].join("\n");
    default:
      return "# Notes\n";
  }
}

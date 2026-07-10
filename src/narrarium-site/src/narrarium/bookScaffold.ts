import { stringify } from "yaml";

export interface InitialBookFile {
  path: string;
  content: string;
}

export interface InitialBookInput {
  title: string;
  author?: string;
  language?: string;
}

export function buildInitialBookFiles(input: InitialBookInput): InitialBookFile[] {
  const title = input.title.trim() || "Untitled Book";
  const language = input.language?.trim() || "en";
  const author = input.author?.trim();
  return [
    {
      path: "README.md",
      content: `# ${title}\n\nNarrarium book repository.\n`,
    },
    {
      path: "book.md",
      content: renderMarkdown(clean({ type: "book", id: "book", title, author, language, canon: "draft" }), "# Book\n\nDescribe the book here.\n"),
    },
    {
      path: "context.md",
      content: renderMarkdown(
        { type: "context", id: "context:book", title: "Book Context" },
        [
          "# Historical And Temporal Frame",
          "",
          "- Record the time period, historical pressures, and what people in this world can plausibly know or do.",
          "",
          "# Geographic Frame",
          "",
          "- Describe the core places, distances, climate, routes, and spatial constraints that should stay stable across the book.",
          "",
          "# Social And Political Frame",
          "",
          "- Note class pressure, institutions, factions, religion, law, trade, or any background power that shapes scenes before plot-specific events do.",
          "",
          "# Writing Implications",
          "",
          "- Translate the context above into concrete prose reminders for chapter and paragraph writing.",
        ].join("\n"),
      ),
    },
    {
      path: "ideas.md",
      content: renderMarkdown({ type: "note", id: "note:ideas", title: "Book Ideas", scope: "book", bucket: "ideas" }, "# Ideas\n\n- Add raw book ideas here.\n"),
    },
    {
      path: "notes.md",
      content: renderMarkdown({ type: "note", id: "note:book", title: "Book Notes", scope: "book", bucket: "notes" }, "# Notes\n\n- Add working notes here.\n"),
    },
    {
      path: "promoted.md",
      content: renderMarkdown({ type: "note", id: "note:promoted", title: "Promoted Items", scope: "book", bucket: "promoted" }, "# Promoted Items\n\nTrack ideas promoted into canon or manuscript work.\n"),
    },
    {
      path: "story-design.md",
      content: renderMarkdown({ type: "note", id: "note:story-design", title: "Story Design", scope: "story-design", bucket: "story-design" }, "# Story Design\n\n## Premise\n\n## Main Conflict\n\n## Character Arcs\n\n## Structure\n"),
    },
    {
      path: "writing-style.md",
      content: renderMarkdown(
        { type: "guideline", id: "guideline:writing-style", title: "Writing Style", scope: "writing-style" },
        [
          "# Voice Contract",
          "",
          "- Define narrative distance, tense, rhythm, imagery, and dialogue rules for this book.",
          "",
          "# Prose Rules",
          "",
          "- Keep scene prose consistent with this contract unless a chapter-specific style overrides it.",
          "",
          "# Revision Watchpoints",
          "",
          "- Track recurring issues to avoid during drafting and rewriting.",
        ].join("\n"),
      ),
    },
    {
      path: "guidelines/images.md",
      content: renderMarkdown(
        { type: "guideline", id: "guideline:images", title: "Image Style", scope: "visuals" },
        [
          "# Visual Direction",
          "",
          "- Default orientation: portrait",
          "- Default aspect ratio: 2:3",
          "- Keep recurring characters visually consistent across assets.",
          "",
          "# Recommended Prompts",
          "",
          "## Book Cover",
          "",
          "Template: <title>, cover illustration, <main subject>, <setting>, <mood>, portrait orientation, 2:3 ratio.",
        ].join("\n"),
      ),
    },
    {
      path: "timelines/main.md",
      content: renderMarkdown({ type: "timeline", id: "timeline:main", title: "Main Timeline", canon: "draft" }, "# Timeline\n\nList major chronological anchors here.\n"),
    },
    {
      path: "plot.md",
      content: renderMarkdown({ type: "plot", id: "plot:main", title: "Story Plot" }, "# Plot Overview\n\nNo chapters yet. Keep this file in sync as the book grows.\n\n# Chapter Map\n\nAdd chapters, then refresh this file so it tracks progression, reveals, and timeline anchors.\n"),
    },
    {
      path: "resumes/total.md",
      content: renderMarkdown({ type: "resume", id: "resume:total", title: "Total Resume" }, "# Book So Far\n\nKeep an up-to-date summary of the entire book here.\n"),
    },
    {
      path: "evaluations/total.md",
      content: renderMarkdown({ type: "evaluation", id: "evaluation:total", title: "Total Evaluation" }, "# Global Evaluation\n\nTrack continuity, pacing, style, and unresolved issues here.\n"),
    },
    {
      path: "evaluation-guidelines.md",
      content: [
        "# Evaluation Guidelines",
        "",
        "Customize this file to control how Copilot writes chapter and paragraph evaluations.",
        "If you leave it unchanged, the default contract stays concise, editorial, and action-oriented.",
        "",
        "## Core principles",
        "",
        "- Evaluate only what is present in the text and visible canon.",
        "- Be concrete and editorial, not generic.",
        "- Distinguish strengths, risks, canon/continuity issues, and next actions.",
        "",
        "## Chapter evaluation output",
        "",
        "Use these sections:",
        "- `## Verdict`",
        "- `## Strengths`",
        "- `## Risks`",
        "- `## Canon And Continuity`",
        "- `## Next Actions`",
        "",
        "## Paragraph evaluation output",
        "",
        "Use these sections:",
        "- `## Verdict`",
        "- `## What Works`",
        "- `## What To Improve`",
        "- `## Canon And Continuity`",
        "- `## Rewrite Priorities`",
        "",
      ].join("\n"),
    },
    {
      path: "state/status.md",
      content: renderMarkdown({ type: "story-state-status", id: "story-state:status", title: "Story State Status" }, "# Story State Status\n\n- Chapters tracked: 0\n- Last updated: not yet\n"),
    },
    {
      path: "state/current.md",
      content: renderMarkdown({ type: "story-state", id: "story-state:current", title: "Current Story State" }, "# Current Story State\n\nNo chapters yet.\n"),
    },
    {
      path: "state/script-ledger.md",
      content: renderMarkdown({ type: "script-ledger", id: "script-ledger:main", title: "Script Ledger" }, "# Script Ledger\n\nNo script files yet.\n"),
    },
    {
      path: "conversations/README.md",
      content: "# Conversations\n\nSaved assistant sessions and exported conversation context live here.\n",
    },
    {
      path: "conversations/config.json",
      content: JSON.stringify({ saveSessionFiles: true }, null, 2) + "\n",
    },
    {
      path: "deepresearches/README.md",
      content: "# Deep Research\n\nDeep research outputs can be saved here and promoted into canon.\n",
    },
  ];
}

function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.replace(/^\n+/, "").trimEnd()}\n`;
}

function clean(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    output[key] = value;
  }
  return output;
}

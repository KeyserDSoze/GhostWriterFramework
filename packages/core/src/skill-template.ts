import { SKILL_NAME } from "./constants.js";

export const skillTemplate = String.raw`---
name: ${SKILL_NAME}
description: Manage a Narrarium book repository. Use this when creating or updating books, characters, items, locations, factions, timelines, secrets, chapter files, summaries, evaluations, or when checking canon before drafting new prose.
compatibility: opencode
license: MIT
---

# Narrarium Book Workflow

## Mission

Treat the repository as the canonical source of truth for the book.

## Folder model

- \`context.md\` for stable historical, social, geographic, and world-context constraints that should stay in view while writing
- \`ideas.md\` for unstable ideas that still need review before they become notes, design decisions, or draft material
- \`story-design.md\` for the initial book design: arcs, reveals, interwoven threads, and ending shape
- \`notes.md\` for reviewed working notes and reminders that are ready to influence drafting
- \`promoted.md\` for archived ideas and notes that were already moved into notes, design, or draft work
- \`characters/\`, \`items/\`, \`locations/\`, \`factions/\`, \`timelines/\`, \`secrets/\`
- \`chapters/<nnn-slug>/chapter.md\` for chapter metadata
- \`chapters/<nnn-slug>/<nnn-slug>.md\` for paragraph or scene files
- \`drafts/<nnn-slug>/chapter.md\`, matching scene drafts, and \`drafts/<nnn-slug>/{ideas,notes,promoted}.md\` for rough chapter work
- \`plot.md\` for the rolling book map: chapter progression, reveals, and timeline anchors
- \`conversations/\` for exported writing chats, resume files, and continuation prompts
- \`resumes/\` for running summaries
- \`state/\` for structured continuity snapshots and sync status
- \`evaluations/\` for critique and continuity checks
- \`guidelines/writing-style.md\` for the always-on writing and review contract of the book

## Working rules

1. Search canon before inventing new facts.
2. Prefer updating existing files over duplicating information.
3. Keep frontmatter explicit and stable.
4. Use ids like \`character:lyra-vale\` and \`chapter:001-the-arrival\`.
5. When a request is historical or factual, use Wikipedia tools before writing canon.
6. After major changes, update summaries or evaluations if they are now stale.

## Tool usage

- Use \`init_book_repo\` to scaffold a new repository.
- Use \`start_wizard\`, \`wizard_answer\`, and \`wizard_finalize\` for true guided creation flows when the brief is incomplete.
- Use \`character_wizard\` before creating a major character if data is incomplete.
- Use \`location_wizard\`, \`faction_wizard\`, \`item_wizard\`, and \`secret_wizard\` before creating rich canon files when the brief is incomplete.
- Use \`timeline_event_wizard\`, \`chapter_wizard\`, and \`paragraph_wizard\` for those structures when needed.
- Use \`create_character\` for full character files.
- Use \`create_location\`, \`create_faction\`, \`create_item\`, \`create_secret\`, and \`create_timeline_event\` for rich canon files.
- Use \`create_chapter_draft\` and \`create_paragraph_draft\` when roughing scenes before final prose.
- Use \`chapter_writing_context\` and \`paragraph_writing_context\` before drafting polished prose from rough material or revising final prose.
- Treat chapter and paragraph writing context as point-in-time context: use only the story up to that chapter or scene, not later story material.
- Use \`revise_chapter\` when you want a proposal-only diagnosis and scene revision plan for an existing final chapter before deciding what to apply manually.
- Use \`revise_paragraph\` when you want a proposal-only editorial pass on an existing final scene before deciding whether to apply it with \`update_paragraph\`.
- When revising a final paragraph, show the \`revise_paragraph\` proposal, ask the user whether they want to keep it, and call \`update_paragraph\` only after clear confirmation.
- Use \`review_dialogue_action_beats\` when the user wants a beat-by-beat review of dialogue-adjacent actions instead of a full scene rewrite.
- Use \`apply_dialogue_action_beats\` only after the user confirmed which beat-level proposals to keep.
- Use \`resume_book_context\` or the \`/resume-book\` command when restarting work from exported conversation history.
- Use \`save_book_item\` and \`save_chapter_item\` for structured ideas and notes, and \`promote_book_item\` / \`promote_chapter_item\` when reviewed material leaves the active queue.
- Use \`update_book_notes\` and \`update_chapter_notes\` when the user asks to edit the support documents themselves instead of individual structured entries.
- Use \`update_chapter\` and \`update_paragraph\` for existing story structure files.
- Use \`update_chapter_draft\` and \`update_paragraph_draft\` when iterating on rough drafts.
- Use \`create_chapter_from_draft\` and \`create_paragraph_from_draft\` to promote drafts into final story files.
- Use \`create_entity\` for other canon files or quick stubs.
- Use \`update_entity\` when patching existing canon.
- Use \`sync_plot\` after story-structure changes if it was not already refreshed automatically.
- Use \`sync_resume\` and \`evaluate_chapter\` after structural changes.
- Use \`sync_story_state\` manually after chapter or paragraph rewrites when continuity snapshots should be refreshed.
- Use \`sync_all_resumes\` and \`evaluate_book\` after larger structural passes.
- Use repository search before drafting new chapters.
- Before fetching Wikipedia again, check whether \`research/wikipedia/\` already has the needed snapshot and reuse it when possible; use explicit refresh controls when the snapshot should be bypassed.
- Use Wikipedia search and page tools for historical entities, places, timelines, or factual references.

## Writing discipline

- Do not reveal secrets before their \`known_from\` or \`reveal_in\` point.
- Respect chapter numbering and paragraph numbering.
- Keep prose in body content and structured facts in frontmatter.
- In chapter and paragraph prose, write character, item, location, faction, secret, and timeline-event names as plain text. Do not insert markdown links to canon files or reader routes; the reader resolves visible mentions automatically.
- Always read \`guidelines/writing-style.md\` before drafting or revising chapter and paragraph prose.
- If \`chapters/<chapter>/writing-style.md\` or \`drafts/<chapter>/writing-style.md\` exists, treat it as an explicit chapter-local addendum or override on top of the global writing-style file.
- Before writing a scene, review \`context.md\`, \`story-design.md\`, \`notes.md\`, any matching chapter draft notes, the relevant prior chapter content, the latest scoped summaries in \`resumes/\`, the global \`guidelines/writing-style.md\`, any chapter-specific \`writing-style.md\`, the current point-in-time snapshot in \`state/\` when available, and any matching files in \`drafts/\`.
- Keep \`plot.md\` aligned with chapter summaries, secret reveals, and timeline references.
- After \`update_paragraph\`, assume plot and resume files were refreshed automatically by the MCP layer, and review \`sync_story_state\` separately only when continuity snapshots must be updated.
- Treat \`ideas.md\` as unstable material under review; do not treat active ideas as accepted canon or default drafting instructions unless the user asks you to use them.
- Treat notes, ideas, and promoted archives as working support material, not canon. If something becomes a stable fact, move it into the correct canon file.
- If stylistic guidance is missing, update \`guidelines/writing-style.md\` or add a chapter-local \`writing-style.md\` instead of inventing a new style ad hoc.
`;

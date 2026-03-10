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

- \`characters/\`, \`items/\`, \`locations/\`, \`factions/\`, \`timelines/\`, \`secrets/\`
- \`chapters/<nnn-slug>/chapter.md\` for chapter metadata
- \`chapters/<nnn-slug>/<nnn-slug>.md\` for paragraph or scene files
- \`drafts/<nnn-slug>/chapter.md\` and matching files for rough chapter and scene drafts
- \`plot.md\` for the rolling book map: chapter progression, reveals, and timeline anchors
- \`conversations/\` for exported writing chats, resume files, and continuation prompts
- \`resumes/\` for running summaries
- \`state/\` for structured continuity snapshots and sync status
- \`evaluations/\` for critique and continuity checks
- \`guidelines/\` for prose defaults, style, structure, and voices

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
- Use \`chapter_writing_context\` and \`paragraph_writing_context\` before drafting polished prose from rough material.
- Use \`revise_chapter\` when you want a proposal-only diagnosis and scene revision plan for an existing final chapter before deciding what to apply manually.
- Use \`revise_paragraph\` when you want a proposal-only editorial pass on an existing final scene before deciding whether to apply it with \`update_paragraph\`.
- Use \`resume_book_context\` or the \`/resume-book\` command when restarting work from exported conversation history.
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
- Before fetching Wikipedia again, check whether \`research/wikipedia/\` already has the needed snapshot and reuse it when possible.
- Use Wikipedia search and page tools for historical entities, places, timelines, or factual references.

## Writing discipline

- Do not reveal secrets before their \`known_from\` or \`reveal_in\` point.
- Respect chapter numbering and paragraph numbering.
- Keep prose in body content and structured facts in frontmatter.
- Always read \`guidelines/prose.md\` before drafting new chapter or paragraph prose.
- If a chapter declares \`style_refs\`, \`narration_person\`, \`narration_tense\`, or \`prose_mode\`, treat that as an explicit chapter-level override; otherwise follow the book-level default prose, style, and voice guides.
- Before writing a scene, review the relevant prior chapter content, the latest summaries in \`resumes/\`, the current snapshot in \`state/\` when available, and any matching files in \`drafts/\`.
- Keep \`plot.md\` aligned with chapter summaries, secret reveals, and timeline references.
- If stylistic guidance is missing, inspect the rest of \`guidelines/\` before choosing a default.
`;

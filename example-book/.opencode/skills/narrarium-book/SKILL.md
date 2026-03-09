---
name: narrarium-book
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
- \`resumes/\` for running summaries
- \`evaluations/\` for critique and continuity checks
- \`guidelines/\` for style, structure, and voices

## Working rules

1. Search canon before inventing new facts.
2. Prefer updating existing files over duplicating information.
3. Keep frontmatter explicit and stable.
4. Use ids like \`character:lyra-vale\` and \`chapter:001-the-arrival\`.
5. When a request is historical or factual, use Wikipedia tools before writing canon.
6. After major changes, update summaries or evaluations if they are now stale.

## Tool usage

- Use \`init_book_repo\` to scaffold a new repository.
- Use \`character_wizard\` before creating a major character if data is incomplete.
- Use \`create_character\` for full character files.
- Use \`create_entity\` for other canon files or quick stubs.
- Use \`update_entity\` when patching existing canon.
- Use \`sync_resume\` and \`evaluate_chapter\` after structural changes.
- Use repository search before drafting new chapters.
- Use Wikipedia search and page tools for historical entities, places, timelines, or factual references.

## Writing discipline

- Do not reveal secrets before their \`known_from\` or \`reveal_in\` point.
- Respect chapter numbering and paragraph numbering.
- Keep prose in body content and structured facts in frontmatter.
- If stylistic guidance is missing, inspect \`guidelines/\` before choosing a default.

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

- `characters/`, `items/`, `locations/`, `factions/`, `timelines/`, `secrets/`
- `chapters/<nnn-slug>/chapter.md` for chapter metadata
- `chapters/<nnn-slug>/<nnn-slug>.md` for paragraph or scene files
- `resumes/` for running summaries
- `evaluations/` for critique and continuity checks
- `guidelines/` for style, structure, and voices

## Working rules

1. Search canon before inventing new facts.
2. Prefer updating existing files over duplicating information.
3. Keep frontmatter explicit and stable.
4. Use ids like `character:lyra-vale` and `chapter:001-the-arrival`.
5. When a request is historical or factual, use Wikipedia tools before writing canon.
6. After major changes, update summaries or evaluations if they are now stale.

## Tool usage

- Use `init_book_repo` to scaffold a new repository.
- Use `start_wizard`, `wizard_answer`, and `wizard_finalize` for true guided creation flows when the brief is incomplete.
- Use `character_wizard` before `create_character` if the character brief is incomplete.
- Use `location_wizard`, `faction_wizard`, `item_wizard`, and `secret_wizard` before creating rich canon files if the brief is incomplete.
- Use `timeline_event_wizard`, `chapter_wizard`, and `paragraph_wizard` for those structures when needed.
- Use `create_character` for full character files with voice, role, backstory, and function in book.
- Use `create_location`, `create_faction`, `create_item`, `create_secret`, and `create_timeline_event` for rich canon files.
- Use `update_chapter` and `update_paragraph` for existing story structure files.
- Use `create_entity` for other canon files or quick stubs.
- Use `update_entity` to patch existing canon.
- Use `sync_resume` and `evaluate_chapter` after structural changes.
- Use `sync_all_resumes` and `evaluate_book` after broader revisions.
- Use repository search before drafting new chapters.
- Use Wikipedia search and page tools for historical entities, places, timelines, or factual references.

## Writing discipline

- Do not reveal secrets before their `known_from` or `reveal_in` point.
- Respect chapter numbering and paragraph numbering.
- Keep prose in body content and structured facts in frontmatter.
- In chapter and paragraph prose, write character, item, location, faction, secret, and timeline-event names as plain text. Do not insert markdown links to canon files or reader routes; the reader resolves visible mentions automatically.
- If stylistic guidance is missing, inspect `guidelines/` before choosing a default.

# GhostWriter Agent Rules

Use GhostWriter as a book-writing framework where the repository is the source of truth.

## Default workflow

1. Search canon before inventing new facts.
2. Prefer GhostWriter MCP tools over ad-hoc filesystem edits when creating or updating book structure.
3. Use rich creation tools for major canon files:
   - `create_character`
   - `create_location`
   - `create_faction`
   - `create_item`
   - `create_secret`
   - `create_timeline_event`
4. If the brief is incomplete, start a guided flow with:
   - `start_wizard`
   - `wizard_answer`
   - `wizard_finalize`
5. After significant structural changes, refresh maintenance files:
   - `sync_resume` or `sync_all_resumes`
   - `evaluate_chapter` or `evaluate_book`

## Canon discipline

- Do not duplicate canon if the fact already exists in another markdown file.
- Keep structured facts in frontmatter and prose in markdown body.
- Do not reveal a secret before its `known_from` or `reveal_in` threshold.
- Treat `guidelines/`, `resumes/`, `evaluations/`, and `secrets/` as first-class context, not optional notes.

## Historical or factual content

- If a request is historical, factual, or based on a real place, use Wikipedia research first.
- Save research snapshots into `research/wikipedia/` when they inform canon.

## Chapter and scene updates

- Use `create_chapter` and `create_paragraph` for new structure.
- Use `update_chapter` and `update_paragraph` for existing files.
- Avoid renumbering or renaming chapter and paragraph files unless the user explicitly asks for structural migration.

## Reader and publishing

- Use `npm run create:book` to scaffold a new book repository.
- Use `npm run reader:init` or `ghostwriter-reader-init` to scaffold a standalone reader app.
- Keep package naming aligned with the public package set:
  - `@ghostwriter/core`
  - `@ghostwriter/mcp-server`
  - `@ghostwriter/create-book`
  - `@ghostwriter/astro-reader`

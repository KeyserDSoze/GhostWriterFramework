# Narrarium Agent Rules

Use Narrarium as a book-writing framework where the repository is the source of truth.

## Default workflow

1. Search canon before inventing new facts.
2. Prefer Narrarium MCP tools over ad-hoc filesystem edits when creating or updating book structure.
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
   - `sync_plot`
   - `sync_resume` or `sync_all_resumes`
   - `evaluate_chapter` or `evaluate_book`

Narrarium MCP already auto-refreshes `plot.md` and the resume files after final chapter or paragraph mutations. Evaluations remain manual unless explicitly requested.

## Versioning and patch notes

- Every application change that is committed and pushed must bump `src/narrarium-site/package.json` and the root lockfile version according to the repository release workflow.
- Before the version bump is committed, add a matching entry to `src/narrarium-site/src/content/patch-notes.json`.
- Every patch-note entry must contain a title, summary, and non-empty change list in both English (`en`) and Italian (`it`).
- Patch notes must describe user-visible behavior and navigation, not only internal implementation details.
- Never commit or push a Narrarium site version without a matching bilingual patch note. `npm run bms:build` enforces this rule.
- After each versioned commit, push `main` and monitor the `Deploy Narrarium Site` GitHub Actions workflow until completion, unless the user explicitly requests otherwise.

## Canon discipline

- Do not duplicate canon if the fact already exists in another markdown file.
- Keep structured facts in frontmatter and prose in markdown body.
- In chapter and scene prose, write character, item, location, faction, secret, and timeline-event names as plain text. Do not insert markdown links to canon files or reader routes; the reader will link visible canon mentions.
- Do not reveal a secret before its `known_from` or `reveal_in` threshold.
- Treat `guidelines/`, `drafts/`, `plot.md`, `conversations/`, `resumes/`, `evaluations/`, and `secrets/` as first-class context, not optional notes.

## Historical or factual content

- If a request is historical, factual, or based on a real place, use Wikipedia research first.
- Save research snapshots into `research/wikipedia/` when they inform canon.

## Chapter and scene updates

- Use `create_chapter` and `create_paragraph` for new structure.
- After creating or updating any file in `scripts/**/*.md`, run `sync_script_ledger` or `npm run sync:script-ledger -- <book-root>` and inspect reported errors or warnings.
- Use `create_chapter_draft` and `create_paragraph_draft` for rough scaffolding before final prose.
- Use `chapter_writing_context` and `paragraph_writing_context` before drafting polished prose from rough material.
- Use `resume_book_context` when restarting work from exported conversation history or a fresh session.
- Use `update_chapter` and `update_paragraph` for existing files.
- Use `update_chapter_draft` and `update_paragraph_draft` when refining rough material.
- Use `create_chapter_from_draft` and `create_paragraph_from_draft` when turning rough drafts into final story files.
- Avoid renumbering or renaming chapter and paragraph files unless the user explicitly asks for structural migration.
- Before writing new chapter or paragraph prose, read `guidelines/writing-style.md`, any chapter-specific `writing-style.md`, the relevant prior story context, and any matching draft files.
- Keep `plot.md` updated whenever chapter progression, timeline anchors, or reveal timing changes.

## Reader and publishing

- Use `npm run create:book` to scaffold a new book repository.
- Use `npm run reader:init` or `narrarium-reader-init` to scaffold a standalone reader app.
- Keep package naming aligned with the public package set:
  - `narrarium`
  - `narrarium-sdk`
  - `narrarium-mcp-server`
  - `create-narrarium-book`
  - `narrarium-astro-reader`

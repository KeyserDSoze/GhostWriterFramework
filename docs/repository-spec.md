# Repository Spec

Narrarium treats a repository as the source of truth for a book project.

## Root structure

```text
book.md
plot.md
guidelines/
  prose.md
  style.md
  chapter-rules.md
  voices.md
  structure.md
  images.md
characters/
items/
locations/
factions/
timelines/
  main.md
  events/
secrets/
chapters/
  001-chapter-title/
    chapter.md
    001-paragraph-title.md
    002-paragraph-title.md
drafts/
  001-chapter-title/
    chapter.md
    001-paragraph-title.md
    002-paragraph-title.md
conversations/
  README.md
  RESUME.md
  CONTINUATION.md
  sessions/
.opencode/
  commands/
    resume-book.md
  plugins/
    conversation-export.js
resumes/
  total.md
  chapters/
evaluations/
  total.md
  chapters/
research/
  wikipedia/
    en/
    it/
assets/
  book/
  characters/
  items/
  locations/
  factions/
  timelines/events/
  secrets/
  chapters/
.opencode/skills/narrarium-book/SKILL.md
.claude/skills/narrarium-book/SKILL.md
```

## Naming rules

- directories and filenames use lowercase slugs
- chapter directories begin with a three-digit ordinal, for example `001-the-arrival`
- paragraph files begin with a three-digit ordinal inside each chapter directory
- entities use stable ids in frontmatter such as `character:lyra-vale`

## Markdown frontmatter

All content files should start with YAML frontmatter.

### Common keys

- `type`: semantic type such as `character`, `location`, `chapter`, `paragraph`
- `id`: stable internal id
- `name` or `title`: human label
- `status`: optional lifecycle state
- `canon`: usually `draft`, `canon`, or `deprecated`
- `tags`: optional tag list
- `refs`: optional ids related to this file
- `secret_refs`: optional linked secret ids for hidden canon tied to the entity
- `private_notes`: optional author-facing hidden canon note
- `known_from`: optional threshold for when the reader can safely know the hidden canon
- `reveal_in`: optional chapter or milestone where hidden canon should fully surface
- `sources`: optional research sources
- `historical`: marks content that should be checked against external sources

The generated reader uses `known_from` and `reveal_in` for spoiler-safe search, canon popups, public atlas pages, and backlink filtering.

### Character example

```md
---
type: character
id: character:lyra-vale
name: Lyra Vale
aliases:
  - The Glass Fox
role_tier: main
story_role: protagonist
speaking_style: Controlled, observant, exact. She uses short sentences when pressured.
background_summary: Raised in trade politics and covert exchanges around Gray Harbor.
function_in_book: Primary viewpoint anchor for the opening movement and reader entry into the world.
occupation: Broker of information
origin: Gray Harbor
first_impression: Competent, composed, difficult to read
traits:
  - observant
  - guarded
  - adaptable
desires:
  - protect her leverage
  - uncover the truth behind the missing archive
fears:
  - becoming predictable
  - failing the few people she trusts
internal_conflict: She wants intimacy but trusts control more than honesty.
external_conflict: Several factions want the same information she is trying to bury and decode.
arc: Moves from strategic distance toward costly emotional commitment.
relationships:
  - Has unfinished history with the Night Syndicate.
factions:
  - faction:night-syndicate
home_location: location:gray-harbor
introduced_in: chapter:001-the-arrival
status: alive
canon: draft
historical: false
tags:
  - spy
  - diplomat
timeline_ages:
  chapter:001-the-arrival: 29
secret_refs:
  - secret:lyra-is-the-heir
private_notes: Lyra already suspects the missing archive was hidden by her own bloodline.
known_from: chapter:006-blood-in-ledgers
reveal_in: chapter:008-crown-of-ashes
---
```

### Secret example

```md
---
type: secret
id: secret:lyra-is-the-heir
title: Lyra is the lost heir
holders:
  - character:lyra-vale
reveal_in: chapter:008-crown-of-ashes
known_from: chapter:008-crown-of-ashes
status: hidden
---
```

## Operational rules for the agent

- search the repository before inventing canon
- use `start_wizard` for guided creation when the brief is incomplete and multiple fields still need collecting
- use `character_wizard` before `create_character` when character information is incomplete
- use `create_chapter_draft` and `create_paragraph_draft` when roughing a scene before writing final prose
- use `chapter_writing_context` and `paragraph_writing_context` before drafting polished prose from rough material
- use `resume_book_context` or `/resume-book` when restarting from exported conversation history
- use `create_chapter_from_draft` and `create_paragraph_from_draft` when promoting rough material into final story files
- use `sync_plot` to refresh the root plot map after story progression, reveal timing, or timeline changes
- use `location_wizard`, `faction_wizard`, `item_wizard`, and `secret_wizard` before creating rich canon files when briefs are incomplete
- use `resumes/` to keep running summaries stable
- use `evaluations/` for structural critique, continuity checks, and quality notes
- use `conversations/` for portable exported chat history, resume files, and continuation prompts; treat it as support material, not canon
- use `npm run doctor` or `doctorBook()` to catch broken references, stale maintenance files, missing asset descriptions, and spoiler-threshold problems
- if content is historical or factual, fetch research before writing canon
- prefer updating existing canon files over duplicating similar facts elsewhere
- before writing final chapter or paragraph prose, read `guidelines/prose.md`, relevant prior story files, and any matching files in `drafts/`
- keep `plot.md` aligned with chapter summaries, reveals, and dated timeline anchors
- final chapter and paragraph mutations through Narrarium MCP auto-refresh `plot.md` plus the chapter and total resumes; evaluations remain explicit/manual

## Reader behavior

Generated readers default to a spoiler-safe public mode.

- secret pages stay hidden from the public atlas and nav
- direct canon pages may render as teaser or locked views instead of full dossiers
- search, canon popups, and story backlinks only surface lore that is safe for the current chapter threshold

For author-only or spoiler-friendly deployments, enable full canon mode with `NARRARIUM_READER_CANON_MODE=full` or `NARRARIUM_READER_ALLOW_FULL_CANON=true` before running the reader build.

## Asset conventions

- keep binary images under `assets/`, not beside canon markdown files
- mirror canon structure inside `assets/`, for example `assets/characters/lyra-vale/primary.png`
- keep asset metadata and prompt history in sibling markdown files such as `assets/characters/lyra-vale/primary.md`
- asset markdown may include `alt_text` and `caption` so reader and EPUB output can reuse consistent descriptions
- default image orientation is portrait and default aspect ratio is `2:3`
- chapter scene assets live under `assets/chapters/<chapter-slug>/paragraphs/<paragraph-slug>/`
- store the book-level visual language in `guidelines/images.md`

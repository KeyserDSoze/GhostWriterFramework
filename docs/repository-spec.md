# Repository Spec

GhostWriter treats a repository as the source of truth for a book project.

## Root structure

```text
book.md
guidelines/
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
.opencode/skills/ghostwriter-book/SKILL.md
.claude/skills/ghostwriter-book/SKILL.md
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
- `sources`: optional research sources
- `historical`: marks content that should be checked against external sources

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
- use `location_wizard`, `faction_wizard`, `item_wizard`, and `secret_wizard` before creating rich canon files when briefs are incomplete
- use `resumes/` to keep running summaries stable
- use `evaluations/` for structural critique, continuity checks, and quality notes
- if content is historical or factual, fetch research before writing canon
- prefer updating existing canon files over duplicating similar facts elsewhere

## Asset conventions

- keep binary images under `assets/`, not beside canon markdown files
- mirror canon structure inside `assets/`, for example `assets/characters/lyra-vale/primary.png`
- keep asset metadata and prompt history in sibling markdown files such as `assets/characters/lyra-vale/primary.md`
- default image orientation is portrait and default aspect ratio is `2:3`
- chapter scene assets live under `assets/chapters/<chapter-slug>/paragraphs/<paragraph-slug>/`
- store the book-level visual language in `guidelines/images.md`

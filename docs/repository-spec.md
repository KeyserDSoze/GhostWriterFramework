# Repository Spec

Narrarium treats a repository as the source of truth for a book project.

## Root structure

```text
book.md
context.md
ideas.md
story-design.md
notes.md
promoted.md
plot.md
guidelines/
  prose.md
  style.md
  chapter-rules.md
  voices.md
  structure.md
  images.md
  styles/
    README.md
    first-person-show.md
    third-person-descriptive.md
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
    ideas.md
    notes.md
    promoted.md
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
state/
  current.md
  status.md
  chapters/
evaluations/
  total.md
  chapters/
  paragraphs/
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

### Chapter and draft style keys

- `style_refs`: explicit chapter-level style profile ids such as `style:first-person-show`
- `narration_person`: explicit narration person for the chapter, such as `first` or `third`
- `narration_tense`: explicit narration tense for the chapter, such as `past` or `present`
- `prose_mode`: chapter-specific prose behaviors such as `show-dont-tell`, `tight-interiority`, or `descriptive-wide-lens`

The generated reader uses `known_from` and `reveal_in` for spoiler-safe search, canon popups, public atlas pages, and backlink filtering.

If these chapter-level style keys are absent, Narrarium falls back to the book-level prose, style, and voice guides.

### Resume and state-specific keys

- `state_changes`: optional structured continuity delta stored in chapter resume frontmatter
- `dirty`: used in `state/status.md` to mark whether continuity snapshots are stale
- `last_story_mutation_at`: when final story prose last changed
- `last_story_state_sync_at`: when `sync_story_state` last rebuilt structured state
- `changed_paths`: final story files that changed since the last story-state sync
- `reason`: brief machine-readable reason such as `paragraph-updated` or `chapter-renamed`

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

### Chapter resume with state delta example

```md
---
type: resume
id: resume:chapter:001-the-arrival
title: Resume 001-the-arrival
chapter: chapter:001-the-arrival
state_changes:
  locations:
    "character:lyra-vale": "location:gray-harbor"
  knowledge_gain:
    "character:lyra-vale":
      - guards-are-on-a-new-rotation
  inventory_add:
    "character:lyra-vale":
      - item:brass-key
  relationship_updates:
    "character:lyra-vale":
      "character:taren-dane": wary-trust
  open_loops_add:
    - find-the-ledger
---

# Chapter Summary

Lyra returns to Gray Harbor and realizes the city is already watching for her.
```

### Chapter style override example

```md
---
type: chapter
id: chapter:012-blood-ledger
number: 12
title: Blood Ledger
pov:
  - character:lyra-vale
style_refs:
  - style:first-person-show
narration_person: first
narration_tense: past
prose_mode:
  - show-dont-tell
  - tight-interiority
---

# Purpose

Confessional chapter with close interior pressure.
```

## Story state snapshots

Narrarium now distinguishes between narrative summaries and structured continuity state.

### Why both exist

- `resumes/` is for humans and LLM prose context: what happened, what matters, what tone and movement the chapter has
- `state/` is for structured continuity: where characters are, what they know, what they carry, who trusts whom, and what loops remain open

This avoids forcing every continuity fact into a single prose summary while still keeping the repository readable.

### Files in `state/`

- `state/status.md`: persistent dirty flag and sync metadata
- `state/current.md`: consolidated latest snapshot after all known chapter deltas
- `state/chapters/<slug>.md`: snapshot after each chapter in reading order

### Manual sync model

Story-state sync is intentionally manual.

After final chapter or paragraph mutations Narrarium does this automatically:

- refreshes `plot.md`
- refreshes `resumes/chapters/*.md`
- refreshes `resumes/total.md`
- marks `state/status.md` as dirty

It does **not** automatically rebuild `state/current.md`. The author decides when continuity is stable enough.

When ready, run:

```text
sync_story_state
```

That command reads `state_changes` from chapter resumes in order and rebuilds all structured story-state snapshots.

### Recommended `state_changes` shape

Use these keys when they help continuity:

- `locations`
- `knowledge_gain`
- `knowledge_loss`
- `inventory_add`
- `inventory_remove`
- `relationship_updates`
- `conditions`
- `wounds`
- `open_loops_add`
- `open_loops_resolved`

Treat `state_changes` as the chapter delta, not as a full-world snapshot.

### Context and diagnostics

- `chapter_writing_context`, `paragraph_writing_context`, and `resume_book_context` read `state/current.md` when present
- if `state/status.md` is dirty, those contexts also surface the stale-state warning
- `doctorBook()` warns about missing or stale `state/` files so continuity drift is visible in CI and reader scaffolds

## Operational rules for the agent

- search the repository before inventing canon
- use `start_wizard` for guided creation when the brief is incomplete and multiple fields still need collecting
- use `character_wizard` before `create_character` when character information is incomplete
- use `create_chapter_draft` and `create_paragraph_draft` when roughing a scene before writing final prose
- use `save_book_item` and `save_chapter_item` for structured active idea and note entries
- use `promote_book_item` and `promote_chapter_item` to move reviewed items out of active queues while preserving them in promoted archives
- use `update_book_notes` for freeform edits to `notes.md` or `story-design.md`, and `update_chapter_notes` for freeform chapter-local note edits when you are editing the documents themselves instead of managing structured entries
- use `chapter_writing_context` and `paragraph_writing_context` before drafting polished prose from rough material
- use `resume_book_context` or `/resume-book` when restarting from exported conversation history
- use `create_chapter_from_draft` and `create_paragraph_from_draft` when promoting rough material into final story files
- use `sync_plot` to refresh the root plot map after story progression, reveal timing, or timeline changes
- use `location_wizard`, `faction_wizard`, `item_wizard`, and `secret_wizard` before creating rich canon files when briefs are incomplete
- use `query_canon` when the agent needs an answer like where someone is, what they know, who holds a secret, when something first appears, or how a relationship/condition/open loop changes across a chapter range
- see `docs/query-canon.md` for a dedicated guide with examples, scope controls, and limits
- use `revise_paragraph` for proposal-only editorial passes on final scene files when you want a rewrite suggestion without mutating the repo yet
- see `docs/revise-paragraph.md` for revision modes, continuity review behavior, and the manual apply flow
- use `revise_chapter` for proposal-only chapter diagnosis and scene-by-scene revision plans before deciding what to apply manually
- see `docs/revise-chapter.md` for the chapter-level workflow and output model
- use `resumes/` to keep running summaries stable
- use `state/` for structured continuity snapshots and refresh it manually with `sync_story_state` after stable rewrites
- use `evaluations/` for structural critique, continuity checks, and quality notes
- chapter and paragraph evaluations should be saved files, not just transient chat output
- use `conversations/` for portable exported chat history, resume files, and continuation prompts; treat it as support material, not canon
- use `npm run doctor` or `doctorBook()` to catch broken references, stale maintenance files, missing asset descriptions, and spoiler-threshold problems
- if content is historical or factual, fetch research before writing canon
- before fetching Wikipedia again, reuse a matching snapshot from `research/wikipedia/` when one already exists; use explicit refresh controls when the snapshot is stale or should be bypassed
- prefer updating existing canon files over duplicating similar facts elsewhere
- before writing final chapter or paragraph prose, read `guidelines/prose.md`, relevant prior story files, and any matching files in `drafts/`
- write character, item, location, faction, secret, and timeline-event names as plain text in chapter and paragraph prose; do not insert markdown links to canon files or reader routes because the reader resolves visible mentions automatically
- treat `ideas.md`, `notes.md`, `story-design.md`, `promoted.md`, and their chapter-draft variants as working support material, not canon; move stable facts into canon files when they become true in the book
- keep `plot.md` aligned with chapter summaries, reveals, and dated timeline anchors
- final chapter and paragraph mutations through Narrarium MCP auto-refresh `plot.md` plus the chapter and total resumes, but story-state sync stays manual; evaluations remain explicit/manual

## Reader behavior

Generated readers default to a spoiler-safe public mode.

- secret pages stay hidden from the public atlas and nav
- direct canon pages may render as teaser or locked views instead of full dossiers
- search, canon popups, and story backlinks only surface lore that is safe for the current chapter threshold
- plain-text canon mentions in chapter and paragraph prose are upgraded by the reader into spoiler-safe popups and links when they are visible at the current threshold

For author-only or spoiler-friendly deployments, enable full canon mode with `NARRARIUM_READER_CANON_MODE=full` or `NARRARIUM_READER_ALLOW_FULL_CANON=true` before running the reader build.

## Asset conventions

- keep binary images under `assets/`, not beside canon markdown files
- mirror canon structure inside `assets/`, for example `assets/characters/lyra-vale/primary.png`
- keep asset metadata and prompt history in sibling markdown files such as `assets/characters/lyra-vale/primary.md`
- asset markdown may include `alt_text` and `caption` so reader and EPUB output can reuse consistent descriptions
- default image orientation is portrait and default aspect ratio is `2:3`
- chapter scene assets live under `assets/chapters/<chapter-slug>/paragraphs/<paragraph-slug>/`
- store the book-level visual language in `guidelines/images.md`

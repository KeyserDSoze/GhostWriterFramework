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
  images.md
ghostwriters/
  default.md
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
audit/
  book.md
  chapters/
    001-chapter-title/
      chapter.md
      paragraphs/
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
operations/
  rewrite-from-reader-feedback/
    chapters/<chapter-slug>/<operation-id>/
      manifest.md
      snapshots/<paragraph-slug>-before.md
      snapshots/<paragraph-slug>-generated.md
    paragraphs/<chapter-slug>/<paragraph-slug>/<operation-id>/
      manifest.md
      snapshots/<paragraph-slug>-before.md
      snapshots/<paragraph-slug>-generated.md
research/
  wikipedia/
    en/
    it/
annotations/
  tags.yml
  chapters/
    001-chapter-title.yml
outline/
  book.md
  _brief.md
  chapters/
    001.md
bible/
  themes.md
  world.md
  decisions.md
  threads.md
  ideas.yml
wildcards/
  <slug>.md
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

## Audit companions

The `audit/` tree stores the current author-facing Audit companion for a canonical source file. Audit documents are support content, not chapter or paragraph prose.

Mappings are deterministic:

- `book.md` maps to `audit/book.md`
- `chapters/<chapter>/chapter.md` maps to `audit/chapters/<chapter>/chapter.md`
- `chapters/<chapter>/<paragraph>.md` maps to `audit/chapters/<chapter>/paragraphs/<paragraph>.md`

Keep at most one current Audit companion at each mapped path. Source renames move the corresponding Audit file or chapter subtree and rewrite `chapter:` and `paragraph:` references. Do not retain timestamped copies or old-path duplicates in `audit/`; Git history is the history of prior Audit results.

Core does not currently expose semantic `deleteChapter`, `deleteParagraph`, `deleteEntity`, or `deleteBook` operations. `NarrariumBookWorkspace.deleteDocument(path)` is a generic single-document change and does not cascade. A caller deleting source files directly must also delete their mapped Audit companions; `doctorBook()` reports malformed and orphan Audit files but never removes them automatically.

## Reader-feedback rewrite operations

Generated prose drafts use the canonical path `drafts/<chapter-slug>/<paragraph-slug>.md`. Implementations may read the legacy `chapters/<chapter-slug>/drafts/<paragraph-slug>.md` path as a fallback, but all new writes use the canonical path.

Every applied rewrite has a regular Git-tracked operation directory under `operations/rewrite-from-reader-feedback/`. The manifest records the target ids, base remote head, progress, full LLM run metadata, aggregate token/cost data, source hashes, and every modified draft. Before any draft changes, the operation commits and pushes its manifest plus a `before` snapshot for each target file. An absent original draft is represented in the manifest with `existedBefore: false` and an empty marker snapshot.

Each successfully generated paragraph is committed and pushed with its `generated` snapshot and updated manifest. Chapter rewrites make one routed generation call per paragraph in chapter order; incomplete operations remain `failed`, `cancelled`, or `conflict` and retain the list of successfully modified files.

Rollback is targeted, never a branch reset. A draft is restored only when its current SHA-256 matches the operation's applied hash, unless the caller explicitly selects force-restore for that file. Conflicts may instead keep the current file or cancel rollback. Restored files and the final manifest status are written in one commit and push. Chapter and paragraph renames/reorders move these operation trees and rewrite stored target references; `doctorBook()` reports malformed paths, missing manifests, and operations whose source target no longer exists.

## Annotations

The reader of the app lets the author mark a passage, tag it and add a note. The annotations are saved in the book, so they work offline in the working copy and travel with the book's sync like any other file:

- `annotations/chapters/<chapter-slug>.yml`: the annotations of one chapter, one entry per marked passage
- `annotations/tags.yml`: the tags made for this book (the built-in tags live in the app, the tags for every book in the author's account settings)

They are the author's notes about the book, not the book: plain YAML without frontmatter, outside every folder `validateBook()`, `doctorBook()` and `searchBook()` read, never published by the online reader (public or protected), and not part of the context the engine builds for the autopilot. The autopilot reads them only when the author asks it to answer them (`AutopilotSession.reviseAnnotations`, the campaign of reason `annotations`): the open notes of the chapters it closed are rewritten as they ask, and each note it answered is closed with a `resolution` by `autopilot`. A book whose repository is public on GitHub makes its annotations public there; the app says so once per book.

```yaml
# Annotations of this chapter, written by Narrarium: one entry per marked passage, sorted by id. Do not rename this file by hand.

version: 1
chapter: chapter:001-the-gate
annotations:
  - id: a-mi4k2x1a-7f3k9q
    paragraph: paragraph:001-the-gate:001-opening
    quote: the color of old steel
    prefix: "The gate stood open beneath a sky "
    suffix: . Mara waited by the wall, countin
    offset: 34
    tag: rewrite
    comment: Too familiar an image.
    status: open
    createdAt: 2026-11-25T10:00:00.000Z
    updatedAt: 2026-11-25T10:00:00.000Z
    createdOnDevice: d-1a2b3c4d
  - id: a-mi4k3abc-zz9q1x
    deletedAt: 2026-11-26T09:00:00.000Z
    updatedAt: 2026-11-26T09:00:00.000Z
```

- `id`: stable for the life of the annotation, `a-<creation time in base 36>-<random>`; entries are sorted by id, so the file lists them in the order they were made and an edit changes only the lines of its entry
- `paragraph`: the scene, as the canonical reference `paragraph:<chapter>:<scene>`, which renaming and reordering scenes and chapters rewrite like every other reference of the book; reordering chapters moves the file with its chapter
- `quote`, `prefix`, `suffix`, `offset`: where the passage is, in the plain text of the scene as the reader shows it (every run of white space one space, blocks separated by a space): the exact text, up to 32 characters before and after it, and where it started (the W3C Web Annotation TextQuoteSelector and TextPositionSelector)
- `tag`: the id of a tag: `rewrite`, `dislike`, `inconsistency`, `expand`, `keep` (built-in), or of a tag of `annotations/tags.yml` or of the account; an annotation whose tag no longer exists keeps its passage and note and shows as a removed tag
- `comment`: the author's note (may be empty); `status`: `open`, `later`, `handled` or `dismissed`
- `resolution` (optional, only with `status: handled`): how it was handled: `by` (`author`, `ai` or `autopilot`; another value is kept as it is), `at` (ISO 8601 UTC), an optional short `summary` of what was done. Changing the status to anything but `handled` drops it
- `createdAt`, `updatedAt`: ISO 8601 UTC; `createdOnDevice`: an opaque short tag of the device that made it (never the device's own id)

When the scene changes, the app finds the passage again: verbatim at its place (exact), verbatim elsewhere in the scene or in another scene of the chapter, chosen by its surroundings when it is there more than once (moved), approximately or between its unchanged surroundings (edited), or not at all (orphaned: the annotation keeps its quote and stays listed; it is never dropped). The file is not rewritten to follow the text: an annotation found elsewhere is written at its new place the next time the author changes it.

Two devices can change the same file between two syncs: the sync merges the two copies entry by entry instead of asking which one to keep. Every entry of either copy is kept; of an entry changed on both, the one with the later `updatedAt` wins, a deletion winning a tie. A deleted annotation leaves a tombstone (its id and dates, none of its text) so that the other device does not bring it back; tombstones older than 90 days are dropped when the app writes the file. Fields a version does not know are kept as they are, at every level, and a file with a `version` higher than the app knows is read and never written.

`annotations/tags.yml` lists the tags of the book with the same rules (sorted by id, `updatedAt`, tombstones with `deletedAt`):

```yaml
version: 1
tags:
  - id: slow-pace-k3x9
    name: Slow pace
    description: The scene slows down here. Cut what does not move it forward, keep the voice.
    mark:
      underline: dotted
      color: sky
      icon: clock
    createdAt: 2026-11-25T10:00:00.000Z
    updatedAt: 2026-11-25T10:00:00.000Z
```

The `description` of a tag says what it means and is also the instruction for the AI when it works on an annotation with that tag. The `mark` is how the reader draws it: an underline (`wavy`, `double`, `dashed`, `dotted`, `solid`), an icon and a colour, never the colour alone. A value of the mark that a version does not know (one that a newer version added) is drawn as the mark of a removed tag and written back as it was while the author does not change that part of the mark.

## The Synopsis and the Story Bible

The Story Bible is the book's own files composed, plus `bible/` for what has no other home. Nothing is copied: the app's Bible reads the description and the Synopsis (`outline/`), `story-design.md`, `context.md`, the canon and the secrets, and edits each part where it lives.

- `outline/chapters/<NNN>.md` may carry `design:`, the design of the chapter (what a writer needs to write it, never its prose): `goal`, `pov`, `characters`, `setting`, `time`, `events`, `scenes`, `conflicts`, `emotions`, `reveals`, `withholds`, `clues`, `previous`, `next`, `ending`, `cliffhanger` (true or false), `notes` (for the ghostwriter). Texts, lists of lines, all optional; a key the engine does not know is kept. An entry without `design:` is an entry as it always was, with the same `digest`.
- `outline/book.md` may carry `design_approved: { at, run }`: the author approved the design run that started at `run` (the autopilot's `state.design.startedAt`). The writing autopilot reads it (`readDesignApproval`): the design of an entry the design run wrote binds the chapter once it is approved, and is a proposal to follow until then; the design of an entry of the author's always binds.
- «Review and complete» never writes an entry by itself: the proposals it makes wait in `autopilot/state.json` (`design.completion`) until the author applies the chosen ones, in one commit that writes only the design fields an entry still lacks, appends the chosen findings to its `design.notes` («Review (the director): …»), creates the chosen canon entries as drafts (`canon: draft`), and records the entries written as a series of `outline/changes.yml` by `autopilot`; the entry stays the author's (`origin: author`), with its title and its text as they were.
- `secrets/<slug>.md` may carry the ledger of the secret, chapters as numbers (0: before the book begins): `learned_by` (`- { character: character:<slug>, chapter: 7 }`), `reader_knows`, `clues`, `red_herrings` (`- { chapter: 3, note: … }`) and `consequences` (a list of lines), beside `holders` (who knows it from the start), `known_from` and `reveal_in`.
- `bible/themes.md` (`type: bible`, `id: bible:themes`): `themes` (a list), `tone` and `audience` (who the book is for); `bible/world.md` (`type: bible`, `id: bible:world`): `rules`, the rules of the world the story never breaks. The body of each is free notes.

- `bible/decisions.md` (`type: bible`, `id: bible:decisions`) is the log of the decisions of the book and its open questions, in the frontmatter, oldest first; the body is free notes. `decisions` is a list of `{ id: d-001, date, decision, reason, by, status, chapters, files, secrets, avoid }`: `by` is `author`, `brainstorming`, `copilot`, `director` or `autopilot`; `status` is `locked` or `open`; `chapters` (numbers or `chapter:<slug>`), `files` and `secrets` (slugs) say what the decision covers, `avoid` the phrases it forbids. `questions` is a list of `{ id: q-001, date, question, by, status: open|answered, answer, chapters, ref }` (`ref` is the question of the autopilot that a `director` question mirrors). Ids are never reused. **Only the author locks a decision**: a decision another agent captures is always `open`.
- A LOCKED decision binds every agent: the design run and the writing autopilot carry it in every request as the author's instruction (the open questions as not theirs to settle), Brainstorming and the Copilot are told it, and a change that contradicts one is held and put to the author instead of being applied. The check needs no model: a change is held when it touches what a locked decision covers (the entry of its `chapters` in the Synopsis, its `files`, the file of one of its `secrets`), when its new text has a phrase in `avoid` (case, accents and spacing do not matter; also in the prose of a chapter, which is otherwise never held for being written), or when it alters a locked decision in the log. The autopilot repeats the step once with the reason and then stops and says which decision; the Copilot and Brainstorming ask «apply it anyway, or leave it». A change that leaves an entry as it was (only its digest) is no change.
- `bible/threads.md` (`type: bible`, `id: bible:threads`): `threads`, a list of `{ id: t-001, title, setup: { chapter, note }, payoff: { chapter, note }, status: open|paid|dropped }`: what the story plants and has to pay off later. A thread that is open and never paid, paid before it is planted, or beyond the last chapter is a finding; `dropped` says the author gave it up on purpose. A secret keeps its own clues and reveal in its own file.
- The checks of the design need no model and are findings, never blockers (the design run tells them to the director, the Bible and the Studio show them with their severity and chapter, the director's review of a written chapter gets the spoiler check as evidence): a secret told too early (`reveal-too-early`), a clue or an event that names the secret before its reveal (`hint-too-explicit`), a character acting on a secret, or speaking of it, in any chapter before learning it (`character-acts-on-secret`; also the point-of-view case, `knowledge-before-learning`), threads (`thread-without-payoff`, `thread-payoff-before-setup`, `thread-out-of-range`), the timeline (`timeline-date-mismatch`: an event of `timelines/events/` anchored to a chapter by `reveal_in` or `known_from` whose date differs from the `time` of that chapter's design; `timeline-order`: dates against the order of the chapters, a flashback is allowed), a character at the same time in two places (`character-in-two-places`: two chapters with the same `time` and different `setting`), names the canon does not have (`unknown-character` also in the holders and learners of a secret and in the participants of an event, `unknown-secret`, `unknown-location`), and `spoiler-in-prose` (a sentence of a WRITTEN chapter that states a secret, by its id, its title or the words particular to its truth, before the chapter from which the reader may know it). Dates are read only in forms that cannot be misread: `1348-03-12`, `1348-03`, `12/03/1348`, or a year from 100 to 2999.
- `bible/ideas.yml`: the journal of the room of the wildcards (Fuori dal coro): every consultation on which something was decided, what each voice proposed and what was decided of it (adopted, adapted or rejected, why, by the Director or the author). Append-only, merged by the sync without a conflict, never a source of decisions. See [Wildcards](wildcards-spec.md).
- `wildcards/<slug>.md` (`type: wildcard`): a wildcard of the book, the frontmatter saying who it is and the body its prompt; one whose `id` is a built-in one (`wildcard:<slug>`) changes it. See [Wildcards](wildcards-spec.md).

```md
---
type: outline-chapter
id: outline-chapter:003
number: 3
title: The Lighthouse
origin: author
design:
  goal: Mara learns the keeper lied about the wreck.
  pov:
    - Mara
  events:
    - Mara climbs to the lamp room.
    - She finds the logbook torn out.
  clues:
    - The keeper's boots are wet on a dry day.
  ending: The lamp goes out.
  cliffhanger: true
---

Mara climbs to the lamp room at dusk and finds the logbook torn out.
```

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

### Ghostwriter profiles

- `book.md` selects the default profile with `ghostwriter: default`
- `ghostwriters/<slug>.md` contains one complete prose contract: style and punctuation frontmatter plus detailed body instructions
- chapter, paragraph, draft, and script frontmatter can select another profile with `ghostwriter`
- resolution uses the closest explicit selection, then paragraph, chapter, and book

The generated reader uses `known_from` and `reveal_in` for spoiler-safe search, canon popups, public atlas pages, and backlink filtering.

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

### Ghostwriter selection example

```md
---
type: chapter
id: chapter:002-glass-confession
number: 2
title: Glass Confession
ghostwriter: intimate-confession
---
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

After final entity, chapter, or paragraph mutations Narrarium does this automatically:

- refreshes `plot.md`
- refreshes `resumes/chapters/*.md`
- refreshes `resumes/total.md`
- marks `state/status.md` as dirty

It does **not** automatically rebuild `state/current.md`. The author decides when continuity is stable enough.

Draft files, scripts, notes, and evaluations are working support material and do not mark story state dirty. They are not part of the canonical continuity snapshot until promoted into final canon or final prose.

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
- use `evaluations/` for structural critique, continuity checks, quality notes, editorial reading against selected ghostwriter profiles, canon coherence checks against active characters, locations, factions, items, and timelines, plus an explicit explanation of why the weighted verdict landed where it did
- chapter and paragraph evaluations should be saved files, not just transient chat output
- use `conversations/` for portable exported chat history, resume files, and continuation prompts; treat it as support material, not canon
- use `npm run doctor` or `doctorBook()` to catch broken references, stale maintenance files, missing asset descriptions, and spoiler-threshold problems
- if content is historical or factual, fetch research before writing canon
- before fetching Wikipedia again, reuse a matching snapshot from `research/wikipedia/` when one already exists; use explicit refresh controls when the snapshot is stale or should be bypassed
- prefer updating existing canon files over duplicating similar facts elsewhere
- before writing final chapter or paragraph prose, read the selected `ghostwriters/<slug>.md` profile, relevant prior story files, and any matching files in `drafts/`
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

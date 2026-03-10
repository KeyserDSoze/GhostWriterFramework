# narrarium

Core Narrarium helpers for local-first book repositories.

## Includes

- repository scaffolding and managed book structure
- markdown frontmatter schemas and rich canon templates
- canon search, related-link discovery, and validation
- draft promotion, plot sync, and resume or evaluation helpers
- manual story-state sync helpers built from chapter resume deltas
- `doctorBook()` checks for broken references, spoiler thresholds, asset metadata, and stale maintenance files
- EPUB export helpers with opening matter, scene navigation, and optional canon index generation

## Install

```bash
npm install narrarium
```

## What it does

- scaffold the canonical book repository structure
- validate markdown frontmatter and file placement
- create rich canon files for characters, locations, factions, items, secrets, and timeline events
- create and update chapters, scenes, chapter drafts, and paragraph drafts
- sync `plot.md`, chapter resumes, and total resume files
- sync `state/current.md`, `state/status.md`, and `state/chapters/` from `state_changes`
- export the book to EPUB
- diagnose repository drift with `doctorBook()`

## Quick example

```js
import {
  initializeBookRepo,
  createCharacterProfile,
  createChapter,
  createParagraph,
  doctorBook,
} from "narrarium";

await initializeBookRepo("my-book", {
  title: "My Book",
  author: "Author Name",
  language: "en",
});

await createCharacterProfile("my-book", {
  name: "Lyra Vale",
  roleTier: "main",
  speakingStyle: "Measured and observant.",
  backgroundSummary: "Raised in covert trade circles.",
  functionInBook: "Primary viewpoint anchor.",
});

await createChapter("my-book", {
  number: 1,
  title: "The Arrival",
});

await createParagraph("my-book", {
  chapter: "chapter:001-the-arrival",
  number: 1,
  title: "At The Gate",
});

const report = await doctorBook("my-book");
console.log(report.ok, report.issues);
```

## Hidden canon and assets

- use `known_from` and `reveal_in` to mark when canon is safe for public reader views
- use `secret_refs` and `private_notes` for author-facing hidden canon
- store asset metadata in markdown beside images and prefer `alt_text` plus `caption` so web and EPUB output stay accessible

## Story state and continuity

Narrarium keeps structured continuity separate from the narrative summaries:

- `resumes/chapters/*.md` stays readable and can include a `state_changes` frontmatter block
- `state/current.md` stores the latest consolidated continuity snapshot
- `state/chapters/*.md` stores the snapshot after each chapter
- `state/status.md` tracks whether story state is stale and why

Story mutations mark the state as stale, but they do not auto-sync the snapshots. That is deliberate: you decide when a rewrite is stable enough to refresh continuity state.

Typical flow:

```js
import {
  syncAllResumes,
  syncStoryState,
  updateParagraph,
} from "narrarium";

await updateParagraph("my-book", {
  chapter: "chapter:001-the-arrival",
  paragraph: "001-at-the-gate",
  body: "# Scene\n\nThe harbor watches before it welcomes.",
});

await syncAllResumes("my-book");
await syncStoryState("my-book");
```

Recommended `state_changes` keys inside chapter resumes:

- `locations`
- `knowledge_gain` and `knowledge_loss`
- `inventory_add` and `inventory_remove`
- `relationship_updates`
- `conditions`
- `wounds`
- `open_loops_add` and `open_loops_resolved`

See the root `README.md` and `docs/repository-spec.md` for the full repo model.

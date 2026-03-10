# narrarium

Core Narrarium helpers for local-first book repositories.

## Includes

- repository scaffolding and managed book structure
- markdown frontmatter schemas and rich canon templates
- canon search, related-link discovery, and validation
- draft promotion, plot sync, and resume or evaluation helpers
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

See the root `README.md` and `docs/repository-spec.md` for the full repo model.

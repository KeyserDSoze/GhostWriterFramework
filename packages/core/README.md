# narrarium

Core Narrarium helpers for local-first book repositories.

## Includes

- repository scaffolding
- markdown frontmatter schemas
- canon search and validation
- resume and evaluation sync helpers
- EPUB export helpers

## Install

```bash
npm install narrarium
```

## What it does

- scaffold the canonical book repository structure
- validate markdown frontmatter and file placement
- create rich canon files for characters, locations, factions, items, secrets, and timeline events
- create and update chapters and scene files
- sync summaries and evaluation files
- export the book to EPUB

## Quick example

```js
import {
  initializeBookRepo,
  createCharacterProfile,
  createChapter,
  createParagraph,
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
```

See the root `README.md` and `docs/repository-spec.md` for the full repo model.

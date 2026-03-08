# @ghostwriter/astro-reader

Astro reader and reader scaffolding CLI for GhostWriter book repositories.

## Install

```bash
npm install @ghostwriter/astro-reader
```

## Scaffold a reader app

```bash
npx ghostwriter-reader-init reader --book-root ..
```

Or directly from the published package:

```bash
npx @ghostwriter/astro-reader reader --book-root .. --package-name my-book-reader
```

## What the reader includes

- book landing page
- chapter index and chapter reading pages
- character index and detail pages
- location index and detail pages
- faction index and detail pages
- item index and detail pages
- secret index and detail pages
- timeline index and event detail pages
- automatic rendering of canonical book, entity, chapter, and scene images when matching assets exist

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

The generated reader expects `GHOSTWRITER_BOOK_ROOT` to point at a GhostWriter book repository.

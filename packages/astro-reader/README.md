# narrarium-astro-reader

Astro reader and reader scaffolding CLI for Narrarium book repositories.

## Install

```bash
npm install narrarium-astro-reader
```

## Scaffold a reader app

```bash
npx narrarium-reader-init reader --book-root ..
```

Or directly from the published package:

```bash
npx narrarium-astro-reader reader --book-root .. --package-name my-book-reader
```

## What the reader includes

- book landing page
- chapter index and chapter reading pages
- previous, next, and jump chapter navigation
- live search across canon, chapters, and scenes
- character index and detail pages
- location index and detail pages
- faction index and detail pages
- item index and detail pages
- secret index and detail pages
- timeline index and event detail pages
- automatic rendering of canonical book, entity, chapter, and scene images when matching assets exist
- automatic EPUB export for `public/downloads/book.epub`
- live watcher for book markdown, canon, and assets during `npm run dev`
- web-only canon mention popups and light or dark theme toggle
- popup tabs for overview, notes, metadata, and image previews
- starter GitHub Pages deployment workflow when scaffolded into a standalone app

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

The generated reader expects `NARRARIUM_BOOK_ROOT` to point at a Narrarium book repository.
`npm run dev` now watches the linked book repo, regenerates the EPUB on changes, and triggers a full browser reload.
`npm run build` also refreshes the EPUB automatically before Astro builds.

You can also pass `--pages-domain example.com` when scaffolding to emit `public/CNAME` and a Pages workflow already pointed at that domain.

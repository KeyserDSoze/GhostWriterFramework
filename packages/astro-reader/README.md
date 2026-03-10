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

- book landing page plus chapter-by-chapter reading
- previous, next, and jump chapter navigation
- reading preferences, bookmark, and continue-reading state stored locally
- live search across canon, chapters, and scenes
- character, location, faction, item, secret, and timeline indexes
- canon mention popups, backlinks, and asset rendering for book, entity, chapter, and scene art
- automatic EPUB export to `public/downloads/book.epub`
- live watcher for book markdown, canon, and assets during `npm run dev`
- `npm run doctor` for broken references, spoiler thresholds, asset metadata, and stale `plot.md` or `resumes/`
- optional EPUBCheck validation during export or build
- starter GitHub Pages deployment workflow when scaffolded into a standalone app

## Reader modes

The generated reader defaults to a spoiler-safe public mode.

In public mode:

- secrets stay hidden from the public atlas and nav
- direct canon pages fall back to teaser or locked views when `known_from` or `reveal_in` say a dossier is not safe yet
- search, canon popups, and backlinks follow the same thresholds

If you want an author-only or spoiler-friendly deployment, enable full canon mode:

```bash
NARRARIUM_READER_CANON_MODE=full
# or
NARRARIUM_READER_ALLOW_FULL_CANON=true
```

## Local development

Create `.env` from the example and point it at your book repo:

```bash
cp .env.example .env
npm install
npm run dev
```

Typical `.env` values:

```bash
NARRARIUM_BOOK_ROOT=..
# NARRARIUM_READER_CANON_MODE=full
# EPUBCHECK_CMD=epubcheck
# EPUBCHECK_JAR=/absolute/path/to/epubcheck.jar
```

`npm run dev` watches the linked book repo, regenerates the EPUB on changes, and triggers a full browser reload.
`npm run build` refreshes the EPUB automatically before Astro builds the site.

## Validation and export

```bash
npm run doctor
npm run export:epub
npm run build
```

If `EPUBCHECK_CMD` or `EPUBCHECK_JAR` is set, EPUB export and build also run EPUBCheck.

## GitHub Pages

You can pass `--pages-domain example.com` when scaffolding to emit `public/CNAME` and a Pages workflow already pointed at that domain.

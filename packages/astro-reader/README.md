# narrarium-astro-reader

Astro reader and reader scaffolding CLI for Narrarium book repositories.

Requires Node.js 22.12 or newer.

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

- the published reader at the root of the site: a full-page e-reader whose shell holds no content, fetches `version.json` on every open (never a stale publication, no service worker) and reads the book from one bundle, public or encrypted. Mobile first and desktop: contents, progress in the book, a scrolling column or pages (keyboard: arrows, Page Up/Down, Space, Home/End; a finger swipe turns the page), light, sepia and dark themes (or the device's), font, text size, line spacing, margins, line width and alignment, several bookmarks, highlights and notes anchored to the chapter, the scene and the paragraph (with the quoted text, so that they find their place again when the text changes); everything is kept in the browser under the id of the book (on GitHub Pages, the repository's numeric id). The labels follow the language of the book (Italian or English). WCAG 2.2 AA: contrast checked by a test for every theme, visible focus, named controls and dialogs, 44px targets, reduced motion, no sideways scrolling at 320 CSS px with the largest text
- password protection with one or several passwords (key slots: AES-256-GCM, PBKDF2-SHA256 600,000 iterations), kept as repository secrets and listed in the `READER_PASSWORD_SECRETS` variable; see `docs/reader-password.md`
- the canon pages of a public book under `book/`: landing page plus chapter-by-chapter reading
- previous, next, and jump chapter navigation
- reading preferences, bookmark, and continue-reading state stored locally
- live search across canon, chapters, and scenes
- character, location, faction, item, secret, and timeline indexes
- canon mention popups, backlinks, and asset rendering for book, entity, chapter, and scene art
- a Full read chapter mode that opens an immersive browser-fullscreen reading view with continuous prose, auto-hiding minimal previous/jump/next navigation, a small ghost hint for rediscovering controls, and canon popups still available
- dismissible Read Aloud controls that can be reopened from a subtle masthead speaker button and stay out of the way during Full read mode
- automatic EPUB export to `public/downloads/book.epub`
- live watcher for book markdown, canon, and assets during `npm run dev`
- `npm run doctor` for broken references, spoiler thresholds, asset metadata, and stale `plot.md`, `resumes/`, or `state/`
- optional EPUBCheck validation during export or build
- starter GitHub Pages deployment workflow when scaffolded into a standalone app

## Reader modes

The generated reader defaults to a spoiler-safe public mode.

In public mode:

- secrets stay hidden from the public atlas and nav
- direct canon pages fall back to teaser or locked views when `known_from` or `reveal_in` say a dossier is not safe yet
- search, canon popups, and backlinks follow the same thresholds
- chapter and scene prose should keep canon names as plain text; the reader upgrades visible mentions into canon popups and also rewrites legacy internal canon links at runtime

If you want an author-only or spoiler-friendly deployment, enable full canon mode:

```bash
NARRARIUM_READER_CANON_MODE=full
# or
NARRARIUM_READER_ALLOW_FULL_CANON=true
```

## Local development

The scaffold creates `.env` with the computed book root already filled in. Update it if the reader should point somewhere else:

```bash
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

`npm run doctor` also reports if the linked book repository has stale or missing structured story-state snapshots, so author-facing continuity drift shows up before deployment.

## Password protection

A build is public unless passwords are configured. On GitHub the passwords are repository secrets and the repository variable `READER_PASSWORD_SECRETS` lists their names (`READER_PASSWORD_001,READER_PASSWORD_002`); the Pages workflow passes `${{ toJSON(secrets) }}` to the build step only and the build reads only the listed names. Locally, set `NARRARIUM_READER_PASSWORD` (one password) or `READER_PASSWORD_SECRETS` with `NARRARIUM_READER_SECRETS` (a JSON object of name → password).

A protected build publishes only `index.html`, `version.json` and encrypted files under `content/`: the canon pages and `downloads/book.epub` are left out, and the build stops if anything in clear would remain.

## GitHub Pages

You can pass `--pages-domain example.com` when scaffolding to emit `public/CNAME` and a Pages workflow already pointed at that domain.

In a book repository the workflow GitHub runs is the root `.github/workflows/deploy-reader-pages.yml`, written by `create-narrarium-book`. `narrarium-astro-reader/scaffold` (and, without any Node import, `narrarium-astro-reader/github-pages`) exports what a host needs to manage it:

- `buildPagesWorkflow(options)`: the workflow text;
- `planPagesWorkflowUpgrade(existingText, options)`: what to commit to bring an existing repository's workflow to this version. It recognizes the workflows Narrarium wrote, keeps the `NARRARIUM_READER_PASSWORD` secret line of an older protected book, and reports a file with edits it cannot merge as `customized` (never `safe`);
- `enablePagesSite`, `disablePagesSite`, `readPagesSite`, `readPagesWorkflowState`, `dispatchPagesWorkflow`, `readLatestPagesRun`, `readReaderPasswordNames`, `writeReaderPasswordNames`: Pages on and off and the password list, through any Octokit-style `request(route, parameters)`. Turning Pages off keeps the workflow file, the variable and the secrets and pauses the workflow; `removePasswords: true` also deletes the variable and the password secrets.

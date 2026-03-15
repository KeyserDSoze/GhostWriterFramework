# create-narrarium-book

Starter CLI for scaffolding and upgrading Narrarium book repositories.

## Install

```bash
npm install -g create-narrarium-book
```

## Use

```bash
create-narrarium-book my-book --title "My Book" --language en
```

You can also use the published package directly with `npx`:

```bash
npx create-narrarium-book my-book --title "My Book" --language en
```

By default the starter:

- scaffolds a reader app in `reader/`
- installs the reader dependencies automatically
- writes root convenience scripts for `npm run dev`, `npm run build`, `npm run export:epub`, and `npm run doctor`
- prepares OpenCode config, portable conversation exports, `/resume-book`, and GitHub Pages wiring

The generated reader starts in spoiler-safe public mode by default. For an author-only or spoiler-friendly atlas, set `NARRARIUM_READER_CANON_MODE=full` in the reader environment before `dev` or `build`.

If you already know the GitHub Pages custom domain, pass `--pages-domain your-domain.com` to preconfigure the generated reader and Pages workflow.

## Upgrade an existing book repo

Refresh the managed Narrarium scaffolding in an existing repo:

```bash
npx create-narrarium-book --upgrade .
```

If the repo has a generated reader and you also want to refresh it:

```bash
npx create-narrarium-book --upgrade . --with-reader
```

The upgrade command creates missing folders, refreshes managed OpenCode and skill files, updates root convenience scripts, and backs up overwritten scaffold files into `.narrarium-upgrade-backups/`.

## What it creates

- canonical book folders such as `characters/`, `locations/`, `factions/`, `chapters/`, `drafts/`, and `secrets/`
- `context.md`, `story-design.md`, `notes.md`, `plot.md`, `guidelines/`, `conversations/`, `resumes/`, `evaluations/`, and `research/wikipedia/`
- `opencode.jsonc` plus bundled Narrarium skills for OpenCode and Claude, including `instructions` that point to `.github/copilot-instructions.md` so the same book-writing rules are reused by both tools
- `conversations/README.md` plus automatic OpenCode exports, `RESUME.md`, `CONTINUATION.md`, and a `/resume-book` command for restarting from repo state globally or from a target chapter/paragraph
- optional sample content
- standalone Astro reader scaffold with spoiler-safe public mode, live reload while writing, EPUB export, doctor checks, and GitHub Pages workflow
- root-level convenience scripts that proxy to the generated reader app

## Useful flags

```bash
create-narrarium-book my-book --title "My Book" --language en --sample
create-narrarium-book my-book --title "My Book" --language en --with-reader
create-narrarium-book my-book --title "My Book" --language en --no-reader
create-narrarium-book my-book --title "My Book" --language en --no-install
create-narrarium-book my-book --title "My Book" --language en --pages-domain mybook.com
create-narrarium-book my-book --title "My Book" --language en --with-reader --reader-dir reader
create-narrarium-book --upgrade .
create-narrarium-book --upgrade . --with-reader
```

Run without arguments for the interactive prompt flow.

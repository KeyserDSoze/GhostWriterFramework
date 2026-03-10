# create-narrarium-book

Starter CLI for scaffolding a Narrarium book repository.

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

By default the starter now scaffolds a reader app in `reader/`, installs its dependencies automatically, and wires live book watching into `npm run dev`.
It also writes a root `package.json` so you can run the reader from the book root with `npm run dev`, `npm run build`, and `npm run export:epub`.
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

The upgrade command creates missing folders, updates managed OpenCode and skill files, and backs up overwritten scaffold files into `.narrarium-upgrade-backups/`.

## What it creates

- canonical book folders such as `characters/`, `locations/`, `factions/`, `chapters/`, `secrets/`
- `guidelines/`, `conversations/`, `resumes/`, `evaluations/`, and `research/wikipedia/`
- `opencode.jsonc` plus bundled Narrarium skills for OpenCode and Claude, with book-writing defaults for deeper reasoning and more detailed answers
- `conversations/README.md` plus automatic OpenCode exports, `RESUME.md`, `CONTINUATION.md`, and a `/resume-book` command for restarting from repo state
- optional sample content
- standalone Astro reader scaffold with theme toggle, live reload while writing, EPUB export, and GitHub Pages workflow
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

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

By default the starter now scaffolds a reader app in `reader/` and installs its dependencies automatically.
It also writes a root `package.json` so you can run the reader from the book root with `npm run dev`, `npm run build`, and `npm run export:epub`.
If you already know the GitHub Pages custom domain, pass `--pages-domain your-domain.com` to preconfigure the generated reader and Pages workflow.

## What it creates

- canonical book folders such as `characters/`, `locations/`, `factions/`, `chapters/`, `secrets/`
- `guidelines/`, `resumes/`, `evaluations/`, and `research/wikipedia/`
- `opencode.jsonc` plus bundled Narrarium skills for OpenCode and Claude
- optional sample content
- standalone Astro reader scaffold with theme toggle, EPUB export, and GitHub Pages workflow
- root-level convenience scripts that proxy to the generated reader app

## Useful flags

```bash
create-narrarium-book my-book --title "My Book" --language en --sample
create-narrarium-book my-book --title "My Book" --language en --with-reader
create-narrarium-book my-book --title "My Book" --language en --no-reader
create-narrarium-book my-book --title "My Book" --language en --no-install
create-narrarium-book my-book --title "My Book" --language en --pages-domain mybook.com
create-narrarium-book my-book --title "My Book" --language en --with-reader --reader-dir reader
```

Run without arguments for the interactive prompt flow.

# @ghostwriter/create-book

Starter CLI for scaffolding a GhostWriter book repository.

## Install

```bash
npm install -g @ghostwriter/create-book
```

## Use

```bash
create-ghostwriter-book my-book --title "My Book" --language en --with-reader
```

You can also use the published package directly with `npx`:

```bash
npx @ghostwriter/create-book my-book --title "My Book" --language en --with-reader
```

## What it creates

- canonical book folders such as `characters/`, `locations/`, `factions/`, `chapters/`, `secrets/`
- `guidelines/`, `resumes/`, `evaluations/`, and `research/wikipedia/`
- optional sample content
- optional standalone Astro reader scaffold

## Useful flags

```bash
create-ghostwriter-book my-book --title "My Book" --language en --sample
create-ghostwriter-book my-book --title "My Book" --language en --with-reader
create-ghostwriter-book my-book --title "My Book" --language en --with-reader --reader-dir reader
```

Run without arguments for the interactive prompt flow.

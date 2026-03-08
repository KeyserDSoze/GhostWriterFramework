# GhostWriter Framework

GhostWriter Framework is a local-first book writing framework built around three pieces:

- a strict but extensible repository convention where the repository *is* the book
- a local MCP server that teaches OpenCode or Claude how to create, search, validate, and enrich that repository
- an Astro-based reader package that turns the repository into a browsable website

## Packages

- `packages/core`: schemas, templates, repo scaffolding, search, validation, and EPUB export helpers
- `packages/mcp-server`: local stdio MCP server for OpenCode, Claude Desktop, and compatible clients
- `packages/create-ghostwriter-book`: starter CLI to scaffold a new book repository from the terminal
- `packages/astro-reader`: Astro reader that renders the repository chapter by chapter

## Local MCP workflow

The intended workflow is local-first:

1. OpenCode runs with the local GhostWriter MCP server enabled.
2. You ask for book tasks in natural language.
3. OpenCode calls GhostWriter MCP tools to scaffold the repository, create entities, create chapters, search canon, validate metadata, and optionally fetch Wikipedia research.
4. The same repository can then be rendered as a website or exported to EPUB.

This keeps the actual writing artifacts in your filesystem instead of hiding them inside a hosted app.

## Install

```bash
npm install
npm run build
```

Run the automated test suite with:

```bash
npm run test
```

For a publish-ready workspace check:

```bash
npm run release:check
```

## Create a new book repo

Build the framework once, then scaffold a new local-first book repo:

```bash
npm run create:book -- my-book --title "My Book" --language en --sample
```

You can scaffold the reader at the same time:

```bash
npm run create:book -- my-book --title "My Book" --language en --sample --with-reader
```

The starter also has an interactive mode:

```bash
npm run create:book
```

## Run the MCP server locally

```bash
npm run dev:mcp
```

Or after building:

```bash
node packages/mcp-server/dist/index.js
```

If you want the public HTTP version locally, for Vercel-style setup/research flows:

```bash
npm run dev:http -w @ghostwriter/mcp-server
```

This serves:

- `http://localhost:3000/mcp`
- `http://localhost:3000/health`

## Run the Astro reader

Set `GHOSTWRITER_BOOK_ROOT` to the path of a book repository created with GhostWriter.

```bash
set GHOSTWRITER_BOOK_ROOT=C:\path\to\my-book
npm run dev:site
```

## Scaffold an installable reader site

Create a standalone Astro reader app inside or beside a book repo:

```bash
npm run reader:init -- reader --book-root .. --package-name my-book-reader
```

The reader now includes dedicated indexes for chapters, characters, locations, factions, items, secrets, and timeline events.

## OpenCode config

An example project config lives in `opencode.jsonc` and points OpenCode to the local MCP server build output.

## Agent rules

Project-level OpenCode and agent rules live in `AGENTS.md`.

## Main MCP tools

- `init_book_repo`: scaffold a book repository in a target folder
- `setup_framework`: return the exact `npx` commands to bootstrap a new GhostWriter project
- `repository_spec`: return the repo model and canon rules
- `character_wizard`: return the checklist of fields needed for a full character
- `create_character`: create a rich character file with voice, role, backstory, and function in book
- `location_wizard`, `faction_wizard`, `item_wizard`, `secret_wizard`: return the checklist for each canon type
- `timeline_event_wizard`, `chapter_wizard`, `paragraph_wizard`: return the checklist for those creation flows
- `create_location`, `create_faction`, `create_item`, `create_secret`, `create_timeline_event`: create rich canonical files for those types
- `start_wizard`, `wizard_answer`, `wizard_status`, `wizard_finalize`, `wizard_cancel`: run a true multi-step guided creation session
- `create_entity`: create faster stubs for other canon files
- `update_chapter`, `update_paragraph`: update existing chapter and scene files without structural migration
- `update_entity`: patch frontmatter and body on existing canon files
- `search_book`: search the repository before inventing canon
- `list_related_canon`: find files that reference an id or concept
- `sync_resume`: refresh chapter or total summaries from current files
- `sync_all_resumes`: refresh all chapter resumes plus the total summary in one pass
- `evaluate_chapter`: refresh a deterministic evaluation scaffold
- `evaluate_book`: refresh the full-book evaluation scaffold and optionally all chapter evaluations
- `wikipedia_search` and `wikipedia_page`: research factual or historical material
- `export_epub`: turn the repository into an EPUB

## Repository spec

The current repository convention is documented in `docs/repository-spec.md`.

## Publishing

The final public package set is:

- `@ghostwriter/core`
- `@ghostwriter/mcp-server`
- `@ghostwriter/create-book`
- `@ghostwriter/astro-reader`

The initial public version is `0.1.0`.

Publishing notes and release order live in `docs/publishing.md`.

## GitHub Actions

Two workflows are included:

- `.github/workflows/ci.yml`: runs build, validation, and tests on pushes and pull requests
- `.github/workflows/publish-npm.yml`: publishes the npm packages on manual dispatch or GitHub Release publish
- `.github/workflows/deploy-vercel-mcp.yml`: deploys the public HTTP MCP endpoint to Vercel

To enable npm publishing from GitHub:

1. Add the repository secret `NPM_TOKEN`
2. Ensure the npm account behind the token can publish under the `@ghostwriter` scope
3. Create a GitHub Release tagged as `v0.1.0`, `v0.1.1`, and so on when you are ready to publish

The publish workflow runs `npm run release:check` first, then publishes in dependency order.

For the Vercel deploy workflow, add these repository secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

## Vercel MCP

This repository now includes a Vercel-ready public MCP endpoint:

- `api/mcp.ts`
- `api/health.ts`
- `vercel.json`

After deploying the repo to Vercel, the public endpoints are:

- `/mcp`
- `/health`

Important: the Vercel deployment is intended for setup guidance, repository spec guidance, and Wikipedia research. Actual local filesystem writing still belongs to the local stdio MCP server.

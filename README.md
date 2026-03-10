# Narrarium Framework

Narrarium Framework is a local-first book writing framework built around three pieces:

- a strict but extensible repository convention where the repository *is* the book
- a local MCP server that teaches OpenCode or Claude how to create, search, validate, and enrich that repository
- an Astro-based reader package that turns the repository into a browsable website

## Packages

- `packages/core`: schemas, templates, repo scaffolding, search, validation, and EPUB export helpers
- `packages/mcp-server`: local stdio MCP server for OpenCode, Claude Desktop, and compatible clients
- `packages/create-narrarium-book`: starter CLI to scaffold a new book repository from the terminal
- `packages/astro-reader`: Astro reader that renders the repository chapter by chapter

## Local MCP workflow

The intended workflow is local-first:

1. OpenCode runs with the local Narrarium MCP server enabled.
2. You ask for book tasks in natural language.
3. OpenCode calls Narrarium MCP tools to scaffold the repository, create entities, create chapters, search canon, validate metadata, and optionally fetch Wikipedia research.
4. The same repository can then be rendered as a website or exported to EPUB.

This keeps the actual writing artifacts in your filesystem instead of hiding them inside a hosted app.

## Quick start from npm

If you just want to use Narrarium, start from the published packages:

```bash
npx create-narrarium-book my-book --title "My Book" --language en
cd my-book
npm run dev
```

This scaffolds a book repo, creates `reader/` by default, installs the reader dependencies, prepares OpenCode config, and gives you a live reading site plus EPUB export while you write.

If you want sample content from the start:

```bash
npx create-narrarium-book my-book --title "My Book" --language en --sample
```

If you want a book repo without the reader scaffold:

```bash
npx create-narrarium-book my-book --title "My Book" --language en --no-reader
```

The starter also has an interactive mode:

```bash
npx create-narrarium-book
```

To refresh the managed Narrarium scaffolding inside an existing repo:

```bash
npx create-narrarium-book --upgrade .
```

Add `--with-reader` if you also want to refresh the generated reader scaffold and root convenience files.

## Run the MCP server from npm

```bash
npx narrarium-mcp-server
```

If the package is already installed in the project or globally, the binary is:

```bash
narrarium-mcp
```

## Scaffold a standalone reader from npm

Create a standalone Astro reader app inside or beside a book repo:

```bash
npx narrarium-astro-reader reader --book-root .. --package-name my-book-reader
cd reader
npm install
npm run dev
```

The reader includes dedicated indexes for chapters, characters, locations, factions, items, secrets, and timeline events, and `npm run dev` watches the linked book repo for live reload plus EPUB refresh.

## Develop this monorepo

These commands are for working on the Narrarium framework repository itself:

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

Build the GitHub Pages documentation site locally with:

```bash
npm run docs:build
```

Repo-only helper commands:

```bash
npm run create:book -- my-book --title "My Book" --language en --sample
npm run dev:mcp
npm run reader:init -- reader --book-root .. --package-name my-book-reader
```

If you want the public HTTP version locally, for Vercel-style setup and research flows:

```bash
npm run dev:http -w narrarium-mcp-server
```

This serves:

- `http://localhost:3000/mcp`
- `http://localhost:3000/health`

## OpenCode config

An example project config lives in `opencode.jsonc` and points OpenCode to the local MCP server build output.
It also tunes the default `build` and `plan` agents for book work with higher reasoning effort, detailed summaries, and more verbose responses while keeping temperature moderate for canon consistency.
Book repos also include `conversations/` as a portable place to keep exported writing chats.
The generated `.opencode/plugins/conversation-export.js` plugin updates `conversations/RESUME.md`, `conversations/CONTINUATION.md`, and per-session exports automatically when OpenCode sessions go idle.
The generated `/resume-book` command and MCP tool `resume_book_context` help you restart from repo state on a fresh machine or session.

## Agent rules

Project-level OpenCode and agent rules live in `AGENTS.md`.

## Main MCP tools

- `init_book_repo`: scaffold a book repository in a target folder
- `setup_framework`: return the exact `npx` commands to bootstrap a new Narrarium project
- `repository_spec`: return the repo model and canon rules
- `character_wizard`: return the checklist of fields needed for a full character
- `create_character`: create a rich character file with voice, role, backstory, and function in book
- `location_wizard`, `faction_wizard`, `item_wizard`, `secret_wizard`: return the checklist for each canon type
- `timeline_event_wizard`, `chapter_wizard`, `paragraph_wizard`: return the checklist for those creation flows
- `chapter_writing_context`, `paragraph_writing_context`, `resume_book_context`: assemble the context to resume or write book prose safely
- `create_location`, `create_faction`, `create_item`, `create_secret`, `create_timeline_event`: create rich canonical files for those types
- `start_wizard`, `wizard_answer`, `wizard_status`, `wizard_finalize`, `wizard_cancel`: run a true multi-step guided creation session
- `create_entity`: create faster stubs for other canon files
- `update_chapter`, `update_paragraph`: update existing chapter and scene files without structural migration
- `update_entity`: patch frontmatter and body on existing canon files
- `create_asset_prompt`, `register_asset`, `generate_asset_image`: manage canonical art prompts and image files
- `rename_entity`, `rename_chapter`, `rename_paragraph`: rename canon safely and move matching asset folders too
- `search_book`: search the repository before inventing canon
- `list_related_canon`: find files that reference an id or concept
- `sync_resume`: refresh chapter or total summaries from current files
- `sync_all_resumes`: refresh all chapter resumes plus the total summary in one pass
- `evaluate_chapter`: refresh a deterministic evaluation scaffold
- `evaluate_book`: refresh the full-book evaluation scaffold and optionally all chapter evaluations
- `wikipedia_search` and `wikipedia_page`: research factual or historical material
- `export_epub`: turn the repository into an EPUB

## Practical image examples

With the local MCP server and `OPENAI_API_KEY` configured, a typical image workflow looks like this.

| Use case | Subject | Asset path | Typical tool flow |
| --- | --- | --- | --- |
| Book cover | `book` | `assets/book/cover.*` | `register_asset` or `generate_asset_image` |
| Character portrait | `character:lyra-vale` | `assets/characters/lyra-vale/primary.*` | `create_asset_prompt` -> `generate_asset_image` |
| Chapter art | `chapter:001-the-arrival` | `assets/chapters/001-the-arrival/primary.*` | `create_asset_prompt` -> `generate_asset_image` |
| Scene art | `paragraph:001-the-arrival:001-at-the-gate` | `assets/chapters/001-the-arrival/paragraphs/001-at-the-gate/primary.*` | `generate_asset_image` directly or after `create_asset_prompt` |

Create a reusable character portrait prompt:

```json
{
  "tool": "create_asset_prompt",
  "arguments": {
    "rootPath": "C:/books/my-book",
    "subject": "character:lyra-vale",
    "body": "# Intent\n\nPrimary portrait for Lyra.\n\n# Prompt\n\nPortrait of Lyra Vale, guarded expression, harbor fog, muted cinematic palette, portrait composition, 2:3 ratio.\n\n# Notes\n\nKeep facial features consistent across future chapter and scene art.",
    "orientation": "portrait",
    "aspectRatio": "2:3"
  }
}
```

Generate the actual image into `assets/characters/lyra-vale/primary.png`:

```json
{
  "tool": "generate_asset_image",
  "arguments": {
    "rootPath": "C:/books/my-book",
    "subject": "character:lyra-vale",
    "provider": "openai",
    "model": "gpt-image-1"
  }
}
```

Generate a scene image directly for a paragraph:

```json
{
  "tool": "generate_asset_image",
  "arguments": {
    "rootPath": "C:/books/my-book",
    "subject": "paragraph:001-the-arrival:001-at-the-gate",
    "prompt": "Lyra arriving at Gray Harbor's gate in cold fog, suspicious guards, cinematic portrait framing, book-cover quality illustration, 2:3 ratio.",
    "provider": "openai",
    "model": "gpt-image-1"
  }
}
```

Import an image you created elsewhere into the canonical assets tree:

```json
{
  "tool": "register_asset",
  "arguments": {
    "rootPath": "C:/books/my-book",
    "subject": "book",
    "assetKind": "cover",
    "sourceFilePath": "C:/renders/my-book-cover.png",
    "body": "# Intent\n\nMain book cover.\n\n# Prompt\n\nFinal cover prompt used for the external render."
  }
}
```

Generate chapter art into `assets/chapters/001-the-arrival/primary.png`:

```json
{
  "tool": "generate_asset_image",
  "arguments": {
    "rootPath": "C:/books/my-book",
    "subject": "chapter:001-the-arrival",
    "prompt": "Lyra approaching Gray Harbor through cold fog, chapter-opening illustration, portrait orientation, dramatic negative space, consistent with the book's visual language.",
    "provider": "openai",
    "model": "gpt-image-1"
  }
}
```

The recommended place for reusable style rules and prompt templates is `guidelines/images.md`.

The Astro reader now auto-renders these canonical assets when present for:

- `book` cover on the home page
- entity detail pages such as characters, locations, factions, items, secrets, and timeline events
- chapter pages and paragraph or scene sections

If you later rename canon with `rename_entity`, `rename_chapter`, or `rename_paragraph`, Narrarium also moves the matching asset folders.

## Repository spec

The current repository convention is documented in `docs/repository-spec.md`.

## Publishing

The final public package set is:

- `narrarium`
- `narrarium-mcp-server`
- `create-narrarium-book`
- `narrarium-astro-reader`

The initial public version is `0.1.0`.

Publishing notes and release order live in `docs/publishing.md`.

## GitHub Actions

Two workflows are included:

- `.github/workflows/ci.yml`: runs build, validation, and tests on pushes and pull requests
- `.github/workflows/publish-npm.yml`: auto-publishes bumped package versions on `main`, with manual dispatch and GitHub Release as fallbacks
- `.github/workflows/deploy-vercel-mcp.yml`: deploys the public HTTP MCP endpoint to Vercel
- `.github/workflows/deploy-docs-pages.yml`: builds and publishes the documentation site to GitHub Pages

Current production domains:

- docs site: `https://narrarium.net`
- public MCP endpoint: `https://narrarium.space/mcp`
- public MCP health: `https://narrarium.space/health`

To enable npm publishing from GitHub:

1. Add the repository secret `NPM_TOKEN` using an npm Automation token
2. Ensure the npm account behind the token can publish the chosen unscoped package names
3. Bump the package versions and merge that change to `main`

On `main`, the publish workflow compares local package versions against npm and only publishes versions that are not already online.
When it finds unpublished versions, it runs `npm run release:check` first, then publishes in dependency order.

If GitHub Actions fails with `EOTP`, the token is not suitable for CI publish with 2FA enabled. Replace it with an npm Automation token or move this repo to npm Trusted Publishing.

If GitHub Actions fails with `E404` while publishing `narrarium` or the other public packages, double-check the package names, registry, and authenticated npm account.

For the Vercel deploy workflow, add this repository secret:

- `VERCEL_TOKEN`

The workflow is already pinned to:

- `VERCEL_ORG_ID=team_Jut3umUxSp1D1Z1sqmv4iUjc`
- `VERCEL_PROJECT_ID=prj_b9bxn0P4ilMmG40DiZoZ057qA1Zj`

For local or CI image generation with `generate_asset_image`, also set:

- `OPENAI_API_KEY`

## Vercel MCP

This repository now includes a Vercel-ready public MCP endpoint:

- `api/mcp.ts`
- `api/health.ts`
- `vercel.json`

After deploying the repo to Vercel, the public endpoints are:

- `/mcp`
- `/health`

Important: the Vercel deployment is intended for setup guidance, repository spec guidance, and Wikipedia research. Actual local filesystem writing still belongs to the local stdio MCP server.

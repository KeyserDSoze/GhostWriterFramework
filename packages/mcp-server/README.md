# narrarium-mcp-server

Local MCP server for Narrarium book repositories.

## Install

```bash
npm install narrarium-mcp-server
```

## Run

```bash
npx narrarium-mcp-server
```

If the package is already installed in the project or globally, the binary is:

```bash
narrarium-mcp
```

## Bootstrap help

The server exposes `setup_framework`, which returns the exact `npx` commands to start a new Narrarium project from scratch.

Typical starter command:

```bash
npx create-narrarium-book my-book --title "My Book" --language en --with-reader
```

## Public HTTP mode

You can also run the public HTTP version locally:

```bash
npm run dev:http
```

That serves:

- `/mcp`
- `/health`

## Vercel deployment

The repository root includes a Vercel-ready API route at `api/mcp.ts`.

The package also includes `packages/mcp-server/api/` and `packages/mcp-server/vercel.json`, so a Vercel project rooted at `packages/mcp-server` can deploy the same public MCP surface without requiring a separate static build output setup.

Use the Vercel deployment for:

- `setup_framework`
- `repository_spec`
- `wikipedia_search`
- `wikipedia_page`

Use the local stdio server for actual filesystem writing and repo mutations.

When a matching `research/wikipedia/` snapshot already exists, Narrarium now reuses it before fetching Wikipedia again. Use `forceWikipediaRefresh` to bypass reuse, or `maxWikipediaSnapshotAgeDays` to refresh old snapshots automatically.

## GitHub Actions and Vercel

The repository includes `.github/workflows/deploy-vercel-mcp.yml`.

To enable it, add this GitHub repository secret:

- `VERCEL_TOKEN`

The workflow already targets:

- `VERCEL_ORG_ID=team_Jut3umUxSp1D1Z1sqmv4iUjc`
- `VERCEL_PROJECT_ID=prj_b9bxn0P4ilMmG40DiZoZ057qA1Zj`

Production endpoint target:

- `https://narrarium.space/mcp`

If you want local image generation through `generate_asset_image`, also set:

- `OPENAI_API_KEY`

## Typical usage

Point OpenCode or another MCP client at the built server and use tools such as:

- `init_book_repo`
- `create_character`
- `create_location`
- `create_chapter`
- `create_paragraph`
- `create_asset_prompt`
- `register_asset`
- `generate_asset_image`
- `update_chapter`
- `update_paragraph`
- `query_canon`
- `revise_chapter`
- `revise_paragraph`
- `rename_entity`
- `rename_chapter`
- `rename_paragraph`
- `start_wizard` / `wizard_answer` / `wizard_finalize`
- `sync_all_resumes`
- `evaluate_chapter`
- `evaluate_paragraph`
- `sync_story_state`
- `evaluate_book`

## Continuity workflow

Narrarium now keeps continuity in two layers:

- `resumes/` for human-readable chapter and book summaries
- `state/` for structured continuity snapshots used by context builders and diagnostics

When you create, rename, promote, or rewrite final chapter or paragraph files through MCP:

- `plot.md`, chapter resumes, and `resumes/total.md` are refreshed automatically
- `state/status.md` is marked dirty
- the tool response reminds you to run `sync_story_state` manually

That manual sync regenerates:

- `state/current.md`
- `state/chapters/*.md`
- `state/status.md`

The structured input for that sync lives in chapter resume frontmatter under `state_changes`.

Typical pattern:

1. Use `update_paragraph`, `update_chapter`, `create_*_from_draft`, or rename tools.
2. Review the refreshed resume files.
3. Add or refine `state_changes` in the affected `resumes/chapters/<slug>.md` file.
4. Run `sync_story_state` when the rewrite is stable.

Recommended `state_changes` keys:

- `locations`
- `knowledge_gain` and `knowledge_loss`
- `inventory_add` and `inventory_remove`
- `relationship_updates`
- `conditions`
- `wounds`
- `open_loops_add` and `open_loops_resolved`

`query_canon` sits on top of this stack and answers natural-language questions such as:

- `Where is Lyra right now?`
- `What does Lyra know after chapter 4?`
- `What is Lyra's relationship with Taren?`
- `What condition is Lyra in?`
- `What open loops are still active?`
- `How does Lyra's relationship with Taren change between chapter 3 and chapter 8?`
- `How does Lyra's condition change between chapter 3 and chapter 8?`
- `What open loops change between chapter 3 and chapter 8?`
- `Who knows this secret?`
- `When does the brass key first appear?`

You can also pass `fromChapter`, `toChapter`, or `throughChapter` directly when you need exact scope control instead of relying on question parsing.

See `docs/query-canon.md` for a fuller guide with use cases, scope rules, output fields, and limitations.

`revise_paragraph` is the editorial counterpart to `update_paragraph`: it proposes a revision for a final scene, does not write files, and can suggest `state_changes` review if the scene touches continuity-sensitive beats. The intended flow is proposal first, user confirmation second, apply with `update_paragraph` third.

See `docs/revise-paragraph.md` for modes, examples, and the manual apply workflow.

`revise_chapter` is the broader version: it proposes a diagnosis, a revision plan, and scene-by-scene suggestions for a final chapter without mutating repository files.

See `docs/revise-chapter.md` for the chapter-level workflow and output structure.

Chapter style overrides are also supported explicitly through chapter frontmatter and style profiles in `guidelines/styles/`. If a chapter does not declare an override, writing context falls back to the book-level default prose and voice guides. Chapter and paragraph writing context now stay scoped to the story up to that point instead of pulling in later chapter material.

`resume_book_context` also accepts optional `chapter` and `paragraph` parameters when you want to restart from a specific writing point instead of the latest overall state.

Use `save_book_item` and `save_chapter_item` for structured active ideas and notes, `promote_book_item` and `promote_chapter_item` to archive promoted items out of the active queues, and `update_book_notes` / `update_chapter_notes` when you want to edit the supporting documents themselves.

See `docs/style-profiles.md` for the chapter style workflow.

## Practical asset examples

| Use case | Subject | Asset path |
| --- | --- | --- |
| Book cover | `book` | `assets/book/cover.*` |
| Character portrait | `character:lyra-vale` | `assets/characters/lyra-vale/primary.*` |
| Chapter art | `chapter:001-the-arrival` | `assets/chapters/001-the-arrival/primary.*` |
| Scene art | `paragraph:001-the-arrival:001-at-the-gate` | `assets/chapters/001-the-arrival/paragraphs/001-at-the-gate/primary.*` |

Create a portrait prompt for a character:

```json
{
  "tool": "create_asset_prompt",
  "arguments": {
    "rootPath": "C:/books/my-book",
    "subject": "character:lyra-vale",
    "body": "# Prompt\n\nPortrait of Lyra Vale, guarded expression, harbor fog, muted cinematic palette, portrait composition, 2:3 ratio."
  }
}
```

Generate the image with OpenAI into the canonical asset path:

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

Import an existing render as the book cover:

```json
{
  "tool": "register_asset",
  "arguments": {
    "rootPath": "C:/books/my-book",
    "subject": "book",
    "assetKind": "cover",
    "sourceFilePath": "C:/renders/my-book-cover.png"
  }
}
```

Generate chapter art directly:

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

If you later rename canon with `rename_entity`, `rename_chapter`, or `rename_paragraph`, the MCP moves matching asset folders too.

## OpenCode example

```json
{
  "default_agent": "build",
  "agent": {
    "build": {
      "temperature": 0.45,
      "top_p": 1,
      "options": {
        "reasoningEffort": "high",
        "reasoningSummary": "detailed",
        "textVerbosity": "high",
        "include": ["reasoning.encrypted_content", "usage"],
        "store": true
      }
    },
    "plan": {
      "temperature": 0.2,
      "top_p": 1,
      "options": {
        "reasoningEffort": "high",
        "reasoningSummary": "detailed",
        "textVerbosity": "high",
        "include": ["reasoning.encrypted_content", "usage"],
        "store": true
      }
    }
  },
  "mcp": {
    "narrarium": {
      "type": "local",
      "command": ["npx", "narrarium-mcp-server"]
    }
  }
}
```

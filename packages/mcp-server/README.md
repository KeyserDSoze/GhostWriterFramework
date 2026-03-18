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
- `rename_entity`
- `rename_chapter`
- `rename_paragraph`
- `start_wizard` / `wizard_answer` / `wizard_finalize`
- `sync_all_resumes`
- `evaluate_chapter`
- `evaluate_paragraph`
- `evaluate_book`

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
  "mcp": {
    "narrarium": {
      "type": "local",
      "command": ["npx", "narrarium-mcp-server"]
    }
  }
}
```

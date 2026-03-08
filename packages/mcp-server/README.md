# @ghostwriter/mcp-server

Local MCP server for GhostWriter book repositories.

## Install

```bash
npm install @ghostwriter/mcp-server
```

## Run

```bash
npx @ghostwriter/mcp-server
```

If the package is already installed in the project or globally, the binary is:

```bash
ghostwriter-mcp
```

## Bootstrap help

The server exposes `setup_framework`, which returns the exact `npx` commands to start a new GhostWriter project from scratch.

Typical starter command:

```bash
npx @ghostwriter/create-book my-book --title "My Book" --language en --with-reader
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

Use the Vercel deployment for:

- `setup_framework`
- `repository_spec`
- `wikipedia_search`
- `wikipedia_page`

Use the local stdio server for actual filesystem writing and repo mutations.

## GitHub Actions and Vercel

The repository includes `.github/workflows/deploy-vercel-mcp.yml`.

To enable it, add these GitHub repository secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

## Typical usage

Point OpenCode or another MCP client at the built server and use tools such as:

- `init_book_repo`
- `create_character`
- `create_location`
- `create_chapter`
- `create_paragraph`
- `update_chapter`
- `update_paragraph`
- `start_wizard` / `wizard_answer` / `wizard_finalize`
- `sync_all_resumes`
- `evaluate_book`

## OpenCode example

```json
{
  "mcp": {
    "ghostwriter": {
      "type": "local",
      "command": ["npx", "ghostwriter-mcp"]
    }
  }
}
```

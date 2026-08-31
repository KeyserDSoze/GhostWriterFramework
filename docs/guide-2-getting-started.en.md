# Getting started

> Start locally, then connect only the services you need.

## 1. Open Narrarium

Narrarium opens directly into a durable local workspace. No account or network connection is required.

Settings, the book registry, reader state, bookmarks, custom actions, clipboard, costs, chats, and chat archive segments are written locally first. Closing and reopening the browser does not require a provider login.

## 2. Create a book

The default storage mode is **This device only**. A local book uses the same file working copy, commits, recovery snapshots, and dirty tracking as a GitHub-backed book, but has no remote target.

You can later open Book Settings and attach the same working copy to a new private GitHub repository. A PAT is supported without OAuth.

## 3. Configure AI

Narrarium does not include a model. Open Settings → AI integrations and configure OpenAI, Azure OpenAI, GitHub Models, or another supported provider. Configuration and credentials are saved in the local account dataset.

## 4. Optional account replicas

Open **Account & Sync** to independently enable Google Drive, OneDrive, or GitHub. These are replicas of the same local account dataset, not login requirements.

- Connector credentials and enabled/disabled state remain on this device.
- Logical account data uses a UTC manifest, content hash, and vector clock.
- A remote error leaves the local copy safe and marks only that replica pending or in error.
- Divergent replicas require an explicit authoritative-copy decision.

GitHub PAT is the currently functional static-browser connection. The OAuth PKCE flow is implemented, but GitHub's token endpoint does not expose a browser-readable CORS response; see `docs/github-oauth-static-client.md`.

## 5. Start writing

- Open a chapter and add a paragraph.
- Use a script to plan a scene, generate a draft, then refine the final paragraph.
- Select text and use the contextual Improve or Synonym action.
- Use **Sync now** only when you want enabled remote replicas updated immediately.

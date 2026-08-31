# Local data, GitHub, Drive, and costs

> Where data lives in the offline-first architecture.

## Local source of truth

Narrarium writes every normal user action to durable browser storage first. The account dataset includes settings, the book registry, reader state, bookmarks, custom actions, AI routing and credentials, clipboard, costs, chats, and lossless chat segments.

Remote failures never roll back local changes. The global status distinguishes **Saved locally**, **Sync pending**, **needs login**, and confirmed remote replicas.

## Books

A book can be **local-only** or connected to GitHub. Local-only is the default and uses the same file working copy, local commits, dirty tracking, locks, diagnostics, and recovery snapshots without inventing a remote owner or repository.

A local book can later be attached to a new private GitHub repository. The existing local repository identity, files, pending history, and recovery records are retained. GitHub repository operations receive a resolved token and do not distinguish OAuth from PAT internally.

## Account replicas

Google Drive, OneDrive, and the private GitHub repository `narrarium.settings` are independent replicas of one logical account dataset. Any combination can be enabled on one browser.

The enabled providers, connector OAuth tokens, provider identities, retry state, folder IDs, and last connector errors are device-local and are never copied to another client.

Each remote copy has a manifest with:

- schema version;
- snapshot UUID;
- UTC ISO-8601 modification time;
- local device ID;
- vector clock;
- deterministic content hash.

Vector clocks classify replicas as same, ahead, behind, or diverged. Diverged copies are never overwritten automatically. Choosing an authoritative copy creates a recovery snapshot and a new reconciliation version that dominates every observed vector clock.

## GitHub account data

Account sync through GitHub uses exactly `narrarium.settings`. Missing repositories are created private. A public repository is rejected before account data is uploaded. Writes use one aggregate Git tree commit such as `Sync Narrarium account data`, not one commit per keystroke.

PAT is supported directly. GitHub OAuth with PKCE is prepared but disabled because a real Chromium verification confirmed that GitHub's token endpoint does not expose a browser-readable CORS response. No opaque `no-cors` workaround or backend was introduced. See `github-oauth-static-client.md`.

## Drive

Google Drive and OneDrive remain supported as optional account replicas and export destinations. Existing legacy settings, costs, clipboard, and chat files can be imported into the common local dataset. New account snapshots use conditional provider revisions where available so concurrent remote changes are not silently overwritten.

Disconnecting a provider leaves local and remote data intact. Remote deletion is a separate, explicitly confirmed action.

## Costs and exports

Cost counters are stored locally immediately and participate in account versioning. DOCX, PDF, EPUB, submission packages, and exported chat files remain generated artifacts that can be downloaded or uploaded to a selected Drive folder.

## Browser repository limits

- text or Markdown file: **2 MiB**;
- binary asset: **25 MiB**;
- one repository mutation: **50 MiB**;
- one clone, pull, or repair transfer: **250 MiB**, further constrained by available browser quota.

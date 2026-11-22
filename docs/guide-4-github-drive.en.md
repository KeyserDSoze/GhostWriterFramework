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

### Long-lived credentials

By default a Google or OneDrive connection holds an access token that lasts about an hour (Google) or up to 24 hours (Microsoft), and then the replica asks you to reconnect. With the Narrarium token service (the Cloudflare Worker that also proxies GitHub Models), Account & Sync can connect with **long-lived credentials** instead. They renew themselves quietly, with no window, so syncing keeps going; the Google Drive and OneDrive cards say which kind a connection has and offer **Switch to long-lived credentials** when the service is available. Without the service nothing changes.

- **Google:** no expiry until you revoke the access (the OAuth consent screen must be **In production**; in *Testing* they expire after 7 days). Google issues them only when you consent, so if a reconnect brings none, the card says so and tells you how to get them.
- **Microsoft:** 90 days, renewed at every use.
- They are kept on this device only, and only if **Remember connection on this device** is on: sealed with a key that cannot be exported, never in the synchronized account data, in exports or in logs. This guards the stored copy; it does not guard against a script running in the page.
- **Disconnect** forgets them on this device and revokes Google's. Microsoft offers no revocation to the service: revoke from the app-permissions page of your Microsoft account.
- A refused renewal moves the replica to **Login needed** and the header indicator asks you to reconnect. A broken connection or a busy service is only an error and is retried later.

## Costs and exports

Cost counters are stored locally immediately and participate in account versioning. DOCX, PDF, EPUB, submission packages, and exported chat files remain generated artifacts that can be downloaded or uploaded to a selected Drive folder.

## Browser repository limits

- text or Markdown file: **2 MiB**;
- binary asset: **25 MiB**;
- one repository mutation: **50 MiB**;
- one clone, pull, or repair transfer: **250 MiB**, further constrained by available browser quota.

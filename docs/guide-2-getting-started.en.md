# Getting started

> Start locally, then connect only the services you need.

## 1. Open Narrarium

Narrarium opens directly into a durable local workspace. No account or network connection is required.

Settings, the book registry, reader state, bookmarks, custom actions, clipboard, costs, chats, and chat archive segments are written locally first. Closing and reopening the browser does not require a provider login.

## 2. Create a book

The default storage mode is **This device only**. A local book uses the same file working copy, commits, recovery snapshots, and dirty tracking as a GitHub-backed book, but has no remote target.

You can later open Book Settings and attach the same working copy to a new private GitHub repository. A PAT is supported without OAuth.

## 3. Configure AI

Narrarium does not include a model. Open **Settings → AI Integrations** and add OpenAI, Azure OpenAI, GitHub Models, or another supported provider. Configuration and credentials are saved in the local account dataset. Then open **Settings → AI Router** to choose which model handles each task, with fallbacks.

## 4. Optional account replicas

Open **Account & Sync** to independently enable Google Drive, OneDrive, or GitHub. These are replicas of the same local account dataset, not login requirements.

- Connector credentials and enabled/disabled state remain on this device.
- Logical account data uses a UTC manifest, content hash, and vector clock.
- A remote error leaves the local copy safe and marks only that replica pending or in error.
- Divergent replicas require an explicit authoritative-copy decision.
- Google Drive and OneDrive can stay connected with **long-lived credentials** that renew themselves, so you do not have to sign in again every hour. The cards on **Account & Sync** show which kind each connection has and offer **Switch to long-lived credentials**. This needs the Narrarium token service (a Cloudflare Worker); without it, the usual one-hour (Google) or 24-hour (Microsoft) sign-in applies and nothing else changes. Google keeps them until you revoke access (the app must be published, not in testing: otherwise 7 days); Microsoft keeps them for 90 days, renewed at every use. **Disconnect** forgets them on this device and revokes Google's; Microsoft's can only be revoked from your Microsoft account.

GitHub can be connected two ways on **Account & Sync**: **Connect with GitHub** (Narrarium's GitHub app, through the Narrarium token service, no token to paste; the app is then installed on the repositories you choose) and a **personal access token** (advanced; the right one for books your personal server runs and for several accounts). Both can create a complete book repository wherever their permissions allow it. See `docs/github-oauth-static-client.md`.

## 5. Start writing

- Open a chapter and add a paragraph.
- Use a script to plan a scene, generate a draft, then refine the final paragraph.
- Select text and use the contextual Improve or Synonym action.
- Use **Sync now** only when you want enabled remote replicas updated immediately.

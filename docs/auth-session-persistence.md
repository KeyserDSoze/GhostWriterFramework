# Local workspace, connector credentials, and session persistence

Narrarium is a static, offline-first client. A local workspace exists independently from remote identities and connector credentials.

## Local lifecycle

Opening Narrarium never requires login and never validates a provider token. The same workspace remains usable after browser restarts, network loss, token expiry, or disconnecting every provider.

Provider validation is lazy and occurs only for an explicit or scheduled remote operation such as sync, push, pull, remote creation, export, or remote deletion. Invalid credentials move only that connector to `needs-auth`; local saves continue.

## Connections

Google, Microsoft, and GitHub connection records are device-local. Each may be enabled independently as an account replica. Enabling or disabling a connector does not change the logical account vector clock.

Without **Remember this connection**, bearer material stays in memory or provider session storage. With remember enabled, the minimum connector material needed for a later remote attempt is retained locally. The application still does not call the provider during ordinary local startup.

PAT credentials have no synthetic login expiry. They are attempted only when needed and become `needs-auth` after GitHub rejects them.

## Logout and deletion

Disconnecting or logging out removes connector credentials and leaves the local workspace and remote data intact. Deleting remote Narrarium data is a separate provider-specific operation. Deleting the local workspace is a separate destructive action guarded by a Data Safety Report and exact `DELETE` confirmation.

## Security boundaries

JavaScript-readable browser storage is exposed to a successful same-origin script injection. Private Drive storage and a private GitHub repository are not dedicated secret vaults. PATs and configured AI API credentials remain syncable for product continuity, but OAuth access tokens, provider session internals, connector enabled state, and the GitHub OAuth client secret are never included in the account dataset.

The GitHub OAuth client secret requested for the static build is triple-Base64 obfuscated only. This is explicitly not encryption. Browser token exchange is currently disabled after real Chromium testing confirmed GitHub's missing CORS grant; see `github-oauth-static-client.md`.

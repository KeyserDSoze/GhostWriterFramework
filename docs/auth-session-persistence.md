# Local workspace, connector credentials, and session persistence

Narrarium is a static, offline-first client. A local workspace exists independently from remote identities and connector credentials.

## Local lifecycle

Opening Narrarium never requires login and never validates a provider token. The same workspace remains usable after browser restarts, network loss, token expiry, or disconnecting every provider.

Provider validation is lazy and occurs only for an explicit or scheduled remote operation such as sync, push, pull, remote creation, export, or remote deletion. Invalid credentials move only that connector to `needs-auth`; local saves continue.

## Connections

Google, Microsoft, and GitHub connection records are device-local. Each may be enabled independently as an account replica. Enabling or disabling a connector does not change the logical account vector clock.

Without **Remember this connection**, bearer material stays in memory or provider session storage. With remember enabled, the minimum connector material needed for a later remote attempt is retained locally. The application still does not call the provider during ordinary local startup.

Long-lived credentials (see below) are the exception for Google Drive and OneDrive: with the token broker, the connection renews its access token by itself, and only a refused refresh token turns into `needs-auth`.

PAT credentials have no synthetic login expiry. They are attempted only when needed and become `needs-auth` after GitHub rejects them.

## Long-lived credentials for Google Drive and OneDrive

A connection made the usual way only holds an access token. It lasts about an hour for Google and up to 24 hours for Microsoft (the limit of the single-page-app platform that MSAL uses). After that the replica reports **Login needed** and asks to reconnect.

When the token broker is configured, **Account & Sync** connects with **long-lived credentials** instead, and renews them by itself, without a window and without asking. The Google Drive and OneDrive cards say which kind of credentials the connection has, and offer **Switch to long-lived credentials** for a connection that only has session ones.

- **The broker** is the Cloudflare Worker that also proxies GitHub Models (`src/auth-proxy`). It keeps the Google and Microsoft client secrets, swaps authorization codes and renews tokens, and stores nothing. The site looks for it at the origin of `VITE_GITHUB_MODELS_BASE`, or at `VITE_AUTH_BROKER_BASE` when that is set, and asks `GET /oauth/status` once per session. If there is no broker, or it is not configured for the provider, nothing changes and nothing is offered: Google keeps the implicit flow, Microsoft keeps MSAL. The owner's one-time steps (Google and Azure consoles, repository secrets) are in the Worker's README.
- **Google** uses the authorization code flow in a popup. Google issues a refresh token only when the user consents, so connecting again without a new consent keeps the one already stored for the same account; if Google issues none, the connection stays a session one and says so. A refresh token does not expire until the user revokes access, provided the OAuth consent screen is **In production** (in *Testing* it expires after 7 days); Google also expires one that was not used for 6 months.
- **Microsoft** uses the authorization code with PKCE in a popup that returns to `auth/microsoft-callback.html`. The refresh token lasts 90 days and is renewed at every use: Microsoft rotates it, and the site always keeps the newest one. The account identity (`homeAccountId`, `localAccountId`) is built from the `client_info` of the token response exactly as MSAL builds it, so a connection that is switched from MSAL keeps being the same account.
- **One renewal at a time.** The Web Lock `narrarium-token-refresh:<provider>` serializes renewals across tabs (without Web Locks, within the tab), and the connection is read again once the lock is held, because another tab may have renewed meanwhile.
- **What a failure means.** A refresh token that the provider refuses (`invalid_grant`) moves the replica to `needs-auth`, so the header indicator asks to reconnect. A broker that is unreachable, slow, rate-limiting or failing is a passing problem: the replica reports an error (or offline), nothing is deleted, and the next attempt tries again. A broker that is no longer configured also asks to reconnect, but keeps the token in case it comes back.
- **Ahead of time.** After start-up and whenever the tab becomes visible again, a connection whose access token has expired or is about to is renewed in the background and, if its replica had failed or was waiting for the login, the sync is retried. Never with a window; one attempt at a time per service, with a growing pause after each failure (30 seconds up to 15 minutes, or what the broker asked).

### Where the refresh token lives

The refresh token is the long-lived secret. It exists in memory and, only when **Remember connection on this device** is on, sealed in a database of its own (`narrarium-credential-vault`, apart from the account data): AES-GCM under a key that WebCrypto made once for this device and cannot export, bound to the provider and the account, with a fresh IV each time. Without WebCrypto it is kept in memory only, for the life of the tab. It is never written to the device configuration record, never part of the synchronized account data, an export, a log, an error report or the LLM debug history.

This protects the stored records, for instance a copy of the database or a casual look in the developer tools. It does **not** protect against code that runs in the page: a script injected into the page can ask WebCrypto to decrypt exactly as the application does, which is why PATs and tokens must still be treated as the secrets they are.

### Disconnecting and deleting

**Disconnect**, **Disconnect all accounts** and **Delete all local data** forget the refresh tokens and the key that sealed them. A Google refresh token is also revoked, through the broker (best effort: a revocation that fails never blocks the disconnection). Microsoft has no revocation the broker can use, so its token is only forgotten on this device; to revoke the access completely, use the app-permissions page of the Microsoft account. Google treats the authorization the user gave the application as one grant, so revoking it can also stop the long-lived credentials of other devices, which then ask to reconnect.

## Logout and deletion

Disconnecting or logging out removes connector credentials and leaves the local workspace and remote data intact. Deleting remote Narrarium data is a separate provider-specific operation. Deleting the local workspace is a separate destructive action guarded by a Data Safety Report and exact `DELETE` confirmation.

## Security boundaries

JavaScript-readable browser storage is exposed to a successful same-origin script injection. Private Drive storage and a private GitHub repository are not dedicated secret vaults. PATs and configured AI API credentials remain syncable for product continuity, but OAuth access tokens, refresh tokens, provider session internals, connector enabled state, and the GitHub OAuth client secret are never included in the account dataset.

The site holds no GitHub client secret: the earlier triple-Base64 obfuscated secret was removed. Signing in with GitHub uses a GitHub App whose client secret lives only in the Cloudflare Worker (the token broker); the site keeps the app's access token in memory and the device database (when the connection is remembered) and the rotating refresh token sealed in the credential vault, and none of the three is ever part of the synced account dataset (the projection also empties any synced token field that holds the app's token). See `github-oauth-static-client.md`.

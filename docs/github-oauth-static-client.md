# Signing in with GitHub from the static Narrarium client

Narrarium offers two ways to reach GitHub, and both can create a complete book repository wherever their permissions allow it:

- a **personal access token** (PAT), which works as it always did;
- **Connect with GitHub**: Narrarium's **GitHub App**, through the token broker (the Cloudflare Worker, `infra/models-github-proxy`), so there is no token to paste.

## Why the broker

GitHub's token endpoint (`https://github.com/login/oauth/access_token`) does not answer the browser's CORS preflight and sends no `Access-Control-Allow-Origin` (verified in Chromium on 2026-08-31 and again on 2026-11-23), and the web flow's code exchange needs the app's **client secret**. A static site cannot do either safely: a secret bundled in JavaScript is a published secret. The earlier version of this client carried a triple-Base64 obfuscated secret and a disabled browser-only exchange; **both were removed**. The site now has only the app's public **Client ID** (`VITE_GITHUB_APP_CLIENT_ID`) and its URL name (`VITE_GITHUB_APP_SLUG`), and the Worker holds the client secret.

## The flow

1. **Availability.** The button appears only when `GET /oauth/status` says `github: true` (a Worker that answers two booleans means `github: false`) **and** the build has the app's client id. Otherwise the card says in one line that sign-in with GitHub is not enabled on this site yet and offers the PAT.
2. **Authorize.** The page goes to `https://github.com/login/oauth/authorize` with the client id, the callback `/auth/github/callback`, a one-time `state`, a one-time `code_verifier` and its SHA-256 `code_challenge` (`S256`). A GitHub App asks for no scopes: what the token can do is the app's permissions, the user's rights and the repositories the app is installed on. The attempt lives in `sessionStorage` for ten minutes and is consumed once.
3. **Exchange.** The callback page checks the `state`, then sends `code`, `codeVerifier` and `redirectUri` to `POST /oauth/github/token` of the broker. The answer is `{accessToken, expiresIn, refreshToken, refreshTokenExpiresIn?}`; it is checked strictly, and an answer without a refresh token is refused. The user is read with `GET /user`, and the connection is saved only when every step worked.
4. **Keeping it alive.** The access token lasts 8 hours; the refresh token lasts about six months and **rotates**: every renewal returns a new one and the old one stops working. Renewals go through the broker (`POST /oauth/github/refresh`) inside the Web Lock `narrarium-token-refresh:github`, after re-reading what another tab may have saved, and the new refresh token is sealed in the vault before anything else. They happen ahead of time (when the app starts, when the tab becomes visible, shortly before expiry), and any request to `api.github.com` that comes back `401` while carrying the app's token renews it once and is repeated once; a second `401` is the answer, and there is no loop. `invalid_grant` means **Reconnect GitHub**.
5. **Where each piece lives.** The access token is in memory (read by `setConnectedGitHubToken` for the many places that need a token without waiting) and, when the connection is remembered, in the device database. The refresh token is in memory and sealed in the credential vault (AES-GCM under a non-exportable device key), never in the device database. **Neither is ever part of the synced account dataset**: they are registered as device-local secrets, and the projection of the settings empties any synced token field that holds the app's token. Personal access tokens stay syncable as before. Nothing is logged.
6. **Disconnect.** The connection is removed from the device first; then the token is renewed (GitHub revokes by a live token) and `POST /oauth/github/revoke` deletes the app's authorization of the user, on every device. A refusal never keeps the connection.

## Installing the app

A GitHub App reaches only the repositories it is installed on. After authorizing, the card reads `GET /user/installations` and `GET /user/installations/{id}/repositories` with the user token and says where the app is installed (all repositories or these N), offers **Choose repositories on GitHub** (`https://github.com/apps/<slug>/installations/new`, or the installation's own settings page), **Check again**, and names a book whose repository is not reached, with the same button. An organization that has not installed or approved the app is said to need an owner; a SAML-protected organization gets the single-sign-on hint.

## Which token a book uses

The order is the book's own token, its named token, the default token, then the GitHub connection. The setting **Prefer the GitHub connection over the default token** (`githubPreferConnection`, synced like the other settings) moves the connection ahead of the default token only. The card and each book's settings show which token the book uses.

## Books run by the personal server

The server keeps a copy of the book's token and cannot renew an 8-hour token (it has no client secret and never receives the refresh token). Narrarium warns when a server-run book would use the app's token. While a browser with Narrarium is open, each renewal re-sends the fresh access token to the server for those books (the server route is the book's registration, `PUT /api/v1/books/:id`, whose `githubToken` replaces the stored copy), only for a book the server already holds a token for. A PAT does not have this limit and is recommended for such books.

## What only a real GitHub App can show

See the report of the release: the app registration, the permissions (`Contents`, `Pull requests`, `Workflows`, `Repository creation`), whether a repository created with a user token is reachable when the app is installed on selected repositories, and the per-user token cap are verified with the real app, not with the fakes the tests use.

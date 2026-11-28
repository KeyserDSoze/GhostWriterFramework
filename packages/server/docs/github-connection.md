# The personal server's own GitHub connection

A GitHub book run by the personal server needs a token to clone, pull and push. Until now the server kept a **copy** of a token that the browser sent: a GitHub App user token, which lasts eight hours and which the server cannot renew (it has no client secret, and it never receives the refresh token). A personal access token has no such limit, but it is broad and the author has to create it. The server's own GitHub connection removes the limit instead of warning about it: the server connects to GitHub **by itself**, once, and keeps that connection alive with no browser open.

It is **opt-in**. A book that does not ask for it keeps what it had, and an old client or an old server is unaffected (feature `server-github-connection`, field `githubAuth`).

## Design

**Device authorization.** The owner starts the connection from Narrarium (Settings → Personal server), which sends the GitHub App's public Client ID and the broker's address to the server (`POST /api/v1/github/connection`). The server itself asks `https://github.com/login/device/code` for a device code, shows the owner a short **user code** and `https://github.com/login/device`, and polls `https://github.com/login/oauth/access_token` in the background, as often as GitHub allows (its `interval`, five seconds more after `slow_down`, until the code expires). The owner can type the code on any device; the browser only reads the status. A device flow needs only the public Client ID: no client secret reaches the server.

**Its own pair, never the browser's.** The server ends up with an access token (8 hours) and a refresh token (about six months) that are **its own**. GitHub rotates the refresh token at every use, so a pair shared with the browser would sign one of the two out at the first renewal. The browser's refresh token is never sent to the server.

**Renewing through the broker.** The client secret stays in the Worker (`src/auth-proxy`, the broker). A few minutes before the access token ends, the server calls the broker's `POST /oauth/github/refresh` with its refresh token (the route the browser uses; a server sends no `Origin` header, and the Worker serves a caller without one) and gets the next pair. The renewal runs **one at a time** however many callers ask, and the new pair is **saved before the new access token is used** (one atomic write), so a crash never loses the refresh token GitHub just rotated. A timer renews it on a server that runs no book, which also keeps the six months of the refresh token going.

**Books.** `githubAuth: "connection"` on a book means: no token copy, and every git operation of the book asks the connection for its current access token (renewed first when it ends soon). A run that lasts days therefore never meets an ended token.

| | Where |
|---|---|
| Client ID, broker, account, dates, both tokens | `private/github-connection.json`: one file, encrypted by the server's vault (AES-256-GCM, key in `private/master.key`), 0600, atomic writes |
| Device code | memory only (a server that restarts while waiting for the code starts again) |
| What the app and the panel read | the public status: state, login, dates, the broker's origin, the user code, a problem code. Never a token or the device code |
| Client secret | the Worker only |

## Security and the trade-off

What the connection gives the server is what a GitHub App user token gives: the app's permissions on the repositories the app is installed on, for as long as the connection lives (the refresh token renews it, up to six months from its last use). That is **more durable** than the eight-hour copy the server held before, and **narrower** than a personal access token (limited to the app's repositories and permissions, revocable at once, and the secret that renews it is not in the server). It sits on the owner's computer in the vault, next to the key that decrypts it: that protects the file from being copied by itself, not from somebody who runs as the server's user. The owner can end it at any time (the admin panel, or from Narrarium) and from GitHub (Settings → Applications → Authorized GitHub Apps).

The Client ID and the broker come **from the browser**, and the broker receives the refresh token, so the server does not trust them blindly:

- the broker must be **https** (plain http only on this computer), with no credentials, query or fragment; the Client ID and the broker are **pinned** when the connection is made and changing them takes a disconnect first;
- `githubConnection.allowedBrokerOrigins` in `config.json` (set by whoever edits the file) restricts the brokers, at the connect and at every renewal;
- the broker's origin is in the status and in the admin panel, so the owner sees where the server's token goes;
- every outbound call has a fixed time to answer, a limit on what it reads, and no redirect is followed; the address the owner is told to open is GitHub's own page, not what an answer says;
- the owner types the code on github.com, where GitHub names the app that asks for it: **a code for an app the owner does not recognise is not to be entered**. A page that is not the owner's could start a connection to *its* app and broker (the API token of the page decides who may), and it is the owner's check on github.com, the broker's origin in the panel and the optional list of brokers that stop it.

**Revoking.** The Worker's `github/revoke` deletes the owner's whole authorization of the app, on every device: it would sign the browser out too. So the server's *Disconnect* uses a route of its own, `github/revoke-token`, which deletes only the server's access token (`DELETE /applications/{client_id}/token`), then deletes its saved pair. A Worker without the route answers 404: the server still disconnects, and its token ends by itself within eight hours.

## What can go wrong, and what the server does

| What happens | What the server does |
|---|---|
| The GitHub App has «Enable Device Flow» off | The start answers the status `disconnected` with the problem `device-flow-disabled` and says what to switch on. Nothing is polled. |
| «Expire user authorization tokens» is off | The token has no expiry or no refresh token: refused, nothing stored (`expiring-tokens-off`). |
| The owner refuses, or the code expires | `access-denied`, `code-expired`; nothing is stored, the owner starts again. |
| The broker cannot be reached (down, error, garbage, redirect) | The current token is used until it really ends; retries after 30 s, doubling to ten minutes (`broker-unreachable`). Then `502 github_connection_unavailable` for the books. |
| GitHub refuses the refresh token (revoked, expired, used twice) | `needs-reconnect`: nothing usable is kept, the books on the connection stop with `412 github_connection_required` and a message, and connecting again with the same Client ID and broker repairs it. |
| The server stops in the middle of a renewal | If GitHub had rotated the refresh token before the answer reached the server, that pair is lost and the next renewal says `needs-reconnect`: GitHub gives the new refresh token only once, so no design can recover it. |
| The data folder cannot be written during a renewal | The new pair is used from memory and saved again at the next chance. |

## What needs the owner

1. In the GitHub App (Settings → Developer settings → GitHub Apps → the app → General): **Enable Device Flow** on, and **Expire user authorization tokens** on. The owner's guide for the Worker creates the app with Device Flow off.
2. The Worker (`src/auth-proxy`) deployed with the same app's client id and secret (`/oauth/status` says `"github": true`), and with the route `github/revoke-token` for a clean *Disconnect* (this release of the Worker).
3. The app installed on the repositories of the books.
4. A server release that announces `server-github-connection`, and Narrarium's side (the site) that starts the connection, shows the status and offers *Disconnect*; the admin panel's card already shows the state and disconnects.
5. Optionally, `githubConnection.allowedBrokerOrigins` in the server's `config.json`.

## What has not been verified against the real GitHub

The device flow end to end (`device_flow_disabled`, `slow_down`, the code that expires), the rotation as GitHub really applies it to a second caller, and `DELETE /applications/{client_id}/token` for a GitHub App user token (that it leaves the owner's other tokens and the authorization alone) are built from GitHub's documentation and tested against a fake GitHub and a fake broker in the process, never the real network. They need the owner's app and a real account.

See also: [`README.md`](../README.md) (the routes, the status, the safety rules), [`src/auth-proxy/README.md`](../../../src/auth-proxy/README.md) (the Worker's routes), [GitHub's device flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token).

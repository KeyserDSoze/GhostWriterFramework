# narrarium-server

Personal Narrarium server. It runs the **autopilot** and the **director** of your books on your own computer, even with the browser closed, and keeps them in sync with the [Narrarium web app](https://narrarium.net/app). It bundles [`narrarium-engine`](../engine/README.md), the same engine the web app runs in the browser.

## Start

```bash
npx narrarium-server
```

Requirements: Node.js 22.14 or newer with npm, on Linux, macOS or Windows. Install `git` to host books stored on GitHub; without it the server hosts local books only.

The first start prepares a **verified copy** of the server in its data folder: npm must report a registry signature for it, and every release after the first one must also carry the provenance attestation of this repository's publishing workflow. Then it starts two listeners, both on this computer only:

| | Address | Who uses it |
|---|---|---|
| API | `http://127.0.0.1:24242` | Narrarium, with a client token |
| Admin panel | `http://127.0.0.1:24243` | You, with the admin code |

Show the admin code with `npx narrarium-server admin-code` and open the admin panel in a browser on the same computer.

## Connect Narrarium

1. In the admin panel choose **Generate a pairing code** (valid five minutes).
2. In Narrarium open **Settings → Personal server**, keep the address `http://127.0.0.1:24242` (or type the server's public address), type the nine digits and choose **Pair**.
3. Back in the admin panel, approve the request. Tick **allow updates** if this device may also update the server.

Narrarium checks the server's identity before sending anything: the server signs a fresh random value with its Ed25519 key, and Narrarium remembers the key's fingerprint. A server answering with another key is refused until you pair again. The fingerprint is shown in the admin panel and in Narrarium's settings.

Then, with your consent, send your AI router configuration from the same settings page, approve the AI endpoints in the admin panel (**AI endpoints**), and open a book's **Autopilot** page to choose **Move to my server**.

You can also create a token without pairing: in the admin panel (**Clients**) or on the server's computer with `npx narrarium-server client-token`, then paste it in Narrarium.

### Permissions

| Permission | Allows |
|---|---|
| `read` | Listing books, reading files, the live stream, the update check |
| `write` | Registering books, writing files, sending the AI configuration |
| `run` | Starting, pausing and steering the autopilot, asking the director |
| `update` | Replacing the server with a newer verified version (granted only when you tick it) |

Revoking or rotating a token in the admin panel closes its live connection at once.

## Updates

When the server runs under the supervisor (`npx narrarium-server start`, the default), a newer release can be installed without touching the server's computer:

- from Narrarium, **Settings → Personal server → Version and updates**, with a token that has the `update` permission;
- from the admin panel, **Updates**.

The server accepts an update only when no autopilot is running and from then on refuses new work. The supervisor stops it cleanly, installs the exact version with `npm install --ignore-scripts`, runs `npm audit signatures`, compares the files with any copy of the same version it already has, and restarts the server on the new version. If anything fails, the previous version starts again and the reason is shown in Narrarium and in the admin panel. At most three updates per hour are performed.

Locally, `npx narrarium-server update [--to VERSION]` installs a version that the next start will use.

Releases without the registry signature and the provenance of `KeyserDSoze/GhostWriterFramework` (directory `packages/server`) are never offered or installed. The only exception is `0.1.0`, published by hand before Trusted Publishing existed, which needs the registry signature and is accepted only as the copy prepared by the first start.

## Reach the server from other devices (Cloudflare)

Both listeners stay on `127.0.0.1`. To use the server from another computer or from your phone, publish it over HTTPS:

- **Existing tunnel**: route a hostname of your tunnel to `http://127.0.0.1:24242`, then in the admin panel (**Approved network**) set it as the public API address.
- **New tunnel**: in the Cloudflare dashboard create a remotely managed tunnel and route a hostname to `http://127.0.0.1:24242`, install `cloudflared` 2025.4.0 or newer, then paste the connector token in the admin panel (**Cloudflare → Save and start**). The server runs its own connector (`cloudflared tunnel run --token-file`), never touches other connectors and does not restart a connector that stopped.

To manage the server remotely as well, route a second hostname (or the same one) to `http://127.0.0.1:24243` and set it as the public admin address. On that address the panel is served and `/api/v1/*` is passed to the API, which still checks the client token. Protect remote administration with Cloudflare Access if you can. Remote administration can be switched off in the same form.

Narrarium on `https://narrarium.net` can always call the server; add other web origins under **Approved network**.

## Start automatically

```bash
npx narrarium-server setup --autostart
```

On Linux this installs a systemd user service (`~/.config/systemd/user/narrarium-server.service`; run `sudo loginctl enable-linger $USER` to start it before you log in). On macOS it installs a launch agent (`~/Library/LaunchAgents/net.narrarium.server.plist`, logging to `server.log` in the data folder). On Windows, add `npx narrarium-server start` to Task Scheduler at logon. The service runs the supervisor of the version installed by `setup`; the server it starts is always the active version, so run `setup --autostart` again after updates if you want the supervisor itself to move to the newer version.

## Commands

```bash
npx narrarium-server [start]            # run the server under the update supervisor (default)
npx narrarium-server setup [--autostart]
npx narrarium-server status             # data folder, active version, whether it is running
npx narrarium-server doctor             # Node.js, npm, git, lock tools, cloudflared, data folder
npx narrarium-server admin-code         # show the admin code
npx narrarium-server rotate-admin-code  # replace it with a random one (server running)
npx narrarium-server set-admin-code [--code-file FILE]   # choose it (typed, or from a 0600 file)
npx narrarium-server client-token [--label NAME] [--scope read,write,run[,update]]
npx narrarium-server update [--to VERSION]
npx narrarium-server --version
```

| Option | Commands | Meaning |
|---|---|---|
| `--data-root DIR` | all | Data folder (see below). |
| `--port N` | `start`, `setup` | API port (default `24242`, saved in `config.json`). |
| `--admin-port N` | `start`, `setup` | Admin panel port (default `24243`, saved). |
| `--label NAME` | `start`, `setup`, `client-token` | Server name shown in Narrarium, or the new client's name. |
| `--origin URL` | `start` | Allow another web origin (saved; repeatable). |
| `--direct` | `start` | Run without the supervisor: everything works except remote updates. |
| `--verbose` | `start` | Log every request. |

The admin code is never accepted on the command line. Rotating it ends every admin session; client tokens keep working. Editing `private/admin-code.txt` by hand and restarting the server also replaces it.

## Data folder

Default location, unless `--data-root` or `NARRARIUM_SERVER_HOME` says otherwise:

| System | Folder |
|---|---|
| Linux | `$XDG_DATA_HOME/narrarium-server`, or `~/.local/share/narrarium-server` |
| macOS | `~/Library/Application Support/Narrarium Server` |
| Windows | `%APPDATA%\Narrarium\server` |

```text
config.json              ports, label, origins, approved network (no secrets)
books.json               hosted books
books/<id>/repo/         working copy of each book: every autopilot step is a git commit
private/                 0700
  admin-code.txt         admin code (0600)
  authorization.json     client tokens as SHA-256 hashes, pending pairing
  master.key             vault key (0600; protected by DPAPI on Windows)
  identity.json          the server's Ed25519 key, its private half encrypted
  ai.json                AI router configuration, encrypted
  book-tokens.json       per-book GitHub tokens, encrypted
  cloudflare-tunnel-token, cloudflare-tunnel.json, cloudflared-home/
  npm-runtime/           verified versions and the active one
  update-request.json, update-result.json
```

One server per data folder: a kernel lock on Linux (`flock`), a named mutex on Windows, a lock file on macOS.

## Security

- Both listeners bind to `127.0.0.1`; requests with an unexpected `Host` header are refused (DNS-rebinding protection). Private Network Access preflights are answered for allowed origins.
- Browser requests are accepted only from allowed origins. Every API call needs a client token with the right permission.
- The admin panel needs the admin code, an `HttpOnly`, `SameSite=Strict` cookie and a CSRF token; it is served under a strict Content-Security-Policy.
- AI keys, GitHub tokens and the identity key are encrypted with AES-256-GCM; client tokens are stored only as hashes and never returned.
- The server calls only the AI endpoints you approved, GitHub and the npm registry: DNS is resolved once per connection, private addresses are refused (except an approved local model on `127.0.0.1`) and redirects are never followed.
- npm runs without install scripts and without your npm credentials.

## How books travel

- **GitHub books**: the server clones the same branch, commits every autopilot step and pushes it; before each step it pulls the author's work. Narrarium pulls the server's commits through its usual repository sync. The book's GitHub token is sent to the server only with the author's explicit consent.
- **Local books**: files are exchanged with a three-way sync (`syncBookStores` in the engine): changes on one side are copied to the other, and files changed on both sides are reported instead of overwritten.

## API

All endpoints live under `/api/v1` and return JSON; errors are `{ "code", "message" }`.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/info?nonce=HEX64` | none | Identity and version, signed over the nonce. |
| `POST` | `/pairings`, `/pairings/:id/result` | none | Pair with a code; collect the token once approved. |
| `GET`/`DELETE` | `/session` | any | The calling client and its permissions / revoke its own token (disconnect). |
| `GET`/`PUT` | `/ai` | read / write | Redacted AI status (with endpoints awaiting approval) / replace the configuration. |
| `GET` | `/books` | read | Hosted books with their autopilot summary. |
| `PUT`/`DELETE` | `/books/:id` | write | Register (local or GitHub) / remove a book. |
| `GET` | `/books/:id/manifest` | read | Paths and hashes of the book's text files. |
| `POST` | `/books/:id/files/read`, `/books/:id/files/commit` | read / write | Read files / commit changes with compare-and-swap. |
| `POST` | `/books/:id/sync` | write | Pull and push the GitHub branch. |
| `GET` | `/books/:id/autopilot`, `/books/:id/autopilot/events?since=N` | read | Snapshot / recent live events. |
| `POST` | `/books/:id/autopilot/{start,pause,intervene,answer}` | run | Control the autopilot. |
| `POST` | `/books/:id/autopilot/{configure,reset}` | write | Change or reset its settings. |
| `POST` | `/books/:id/director/ask` | run | Ask the director about the book, a chapter or a scene. |
| `GET` | `/events` | read | Server-sent events: autopilot events and book summaries. |
| `GET`/`POST` | `/updates` | read / update | Release check / request the verified update. |

The typed client is `NarrariumServerClient` in `narrarium-engine` (with `pairWithServer` and `verifyServerIdentity`).

## Maintainers: releasing

Releases are published by [`.github/workflows/publish-server-npm.yml`](../../.github/workflows/publish-server-npm.yml) through npm Trusted Publishing, with a provenance attestation and without any npm token:

1. Bump `version` in `packages/server/package.json` and `SERVER_VERSION` in `src/version.ts` (a test keeps them equal); `packages/engine` has the same pair (`ENGINE_VERSION`), commit and push.
2. Push the tag: `git tag narrarium-server-v0.1.1 && git push origin narrarium-server-v0.1.1`.

The workflow checks that the tag matches the package, builds and tests the engine and the server, checks the package contents and publishes. The generic `Publish npm packages` workflow never publishes this package.

First publication (once): npm can bind a Trusted Publisher only to an existing package, so `0.1.0` is published by hand from a clean, verified checkout:

```bash
npm ci
npm run build -w narrarium && npm run build -w narrarium-engine
npm run test -w narrarium-server
npm login                      # with two-factor authentication
cd packages/server
npm publish --access public --provenance=false
```

Then, on npmjs.com, open the package **Settings → Trusted publishing** and add GitHub Actions with owner `KeyserDSoze`, repository `GhostWriterFramework`, workflow `publish-server-npm.yml`, environment `npm-publish`. Optionally require two-factor authentication and disallow tokens for publishing.

# narrarium-server

Personal Narrarium server. It runs the **autopilot** and the **director** of your books on your own computer, even with the browser closed, and keeps them in sync with the [Narrarium web app](https://narrarium.net/app). It uses [`narrarium-engine`](../engine/README.md), the same engine the web app runs in the browser.

## Start

```bash
npx narrarium-server
```

Requirements: Node.js 20 or newer. Install `git` to host books stored on GitHub; without it the server hosts local books only.

At the first start the server prints its address (default `http://127.0.0.1:24242`) and a **client token**, shown only once. In Narrarium open **Settings → Personal server**, paste the address and the token, test the connection and, with your consent, send your AI router configuration. Then open a book's **Autopilot** page and choose **Move to my server**.

## Commands

```bash
npx narrarium-server [start] [options]      # start the server (default)
npx narrarium-server token create --label "my laptop"
npx narrarium-server token list
npx narrarium-server token revoke <id>
npx narrarium-server status                 # configuration, books, whether it is running
npx narrarium-server doctor                 # Node.js, git, data folder, port
```

| Option | Meaning |
|---|---|
| `--port N` | Port (default `24242`). |
| `--host ADDRESS` | Bind address (default `127.0.0.1`). Use `0.0.0.0` only on a trusted network. |
| `--data DIR` | Data folder (default `~/.narrarium-server`, or `NARRARIUM_SERVER_HOME`). |
| `--origin URL` | Allow another web origin (repeatable). `https://narrarium.net` and local dev origins are always allowed. |
| `--allow-host HOST` | Accept this `Host` header, for example a tunnel hostname (repeatable). |
| `--label NAME` | Name shown in Narrarium. |
| `--verbose` | Log every request. |

## How books travel

- **GitHub books** — the server clones the same branch, commits every autopilot step and pushes it; before each step it pulls the author's work. The web app pulls the server's commits through its usual repository sync. The book's GitHub token is sent to the server only with the author's explicit consent and stored with restrictive permissions.
- **Local books** — files are exchanged with a three-way sync (`syncBookStores` in the engine): changes on one side are copied to the other, and files changed on both sides are reported instead of overwritten.

Every step is a git commit inside the server's working copy, so the full history stays inspectable.

## Security

- Binds to loopback by default; requests with an unexpected `Host` header are refused (DNS-rebinding protection).
- Browser requests are accepted only from allowed origins; Private Network Access preflights are answered for those origins.
- Every API call needs a bearer client token. Tokens are stored as SHA-256 hashes and can be revoked.
- AI keys and GitHub tokens are written with mode `0600` in the data folder and never returned by the API.
- One server per data folder (lock file).

To reach the server from another device, expose it over HTTPS (for example with a tunnel) and start it with `--allow-host <hostname>`.

## API

All endpoints live under `/api/v1` and return JSON:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/info` | Public server identity and version. |
| `GET` | `/session` | The calling client. |
| `GET`/`PUT` | `/ai` | Redacted AI status / replace the AI router configuration. |
| `GET` | `/books` | Hosted books with their autopilot summary. |
| `PUT`/`DELETE` | `/books/:id` | Register (local or GitHub) / remove a book. |
| `GET` | `/books/:id/manifest` | Paths and hashes of the book's text files. |
| `POST` | `/books/:id/files/read`, `/books/:id/files/commit` | Read files / commit changes with compare-and-swap. |
| `POST` | `/books/:id/sync` | Pull and push the GitHub branch. |
| `GET` | `/books/:id/autopilot` | Autopilot snapshot. |
| `POST` | `/books/:id/autopilot/{start,pause,intervene,answer,configure,reset}` | Control the autopilot. |
| `GET` | `/books/:id/autopilot/events?since=N` | Recent live events. |
| `POST` | `/books/:id/director/ask` | Ask the director about the book, a chapter or a scene. |
| `GET` | `/events` | Server-sent events: live autopilot events and book summaries. |

The typed client is `NarrariumServerClient` in `narrarium-engine`.

## Data folder

```text
~/.narrarium-server/
  config.json        server id, port, label, extra origins
  tokens.json        hashed client tokens (0600)
  ai.json            AI router configuration (0600)
  book-tokens.json   per-book GitHub tokens (0600)
  books.json         hosted books
  books/<id>/repo/   working copy of each book
```

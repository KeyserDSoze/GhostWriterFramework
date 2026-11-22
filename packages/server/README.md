# narrarium-server

Personal Narrarium server. It runs the **autopilot** and the **director** of your books on your own computer, even with the browser closed, and keeps them in sync with the [Narrarium web app](https://narrarium.net/app). It bundles [`narrarium-engine`](../engine/README.md), the same engine the web app runs in the browser, and the same AI client (`createFetchAi`): the same configuration gives the same requests and the same outcomes in both. What is the owner's alone stays the owner's: where the API keys may go ([AI endpoints](#ai-endpoints-and-spending-limits)) and how much the server may spend.

## Start

```bash
npx narrarium-server
```

Requirements: Node.js 22.14 or newer with npm, on Linux, macOS or Windows. Install `git` to host books stored on GitHub; without it the server hosts local books only.

The first start prepares a **verified copy** of the server in its data folder: npm must report a registry signature for it, and every release after the first one must also carry the provenance attestation of this repository's publishing workflow, at the tag of that release (see [Updates](#updates)). Then it starts two listeners, both on this computer only:

| | Address | Who uses it |
|---|---|---|
| API | `http://127.0.0.1:24242` | Narrarium, with a client token |
| Admin panel | `http://127.0.0.1:24243` | You, with the admin code |

Show the admin code with `npx narrarium-server admin-code` and open the admin panel in a browser on the same computer.

## Connect Narrarium

1. In the admin panel choose **Generate a pairing code** (valid five minutes, usable by one device once).
2. In Narrarium open **Settings → Personal server**, keep the address `http://127.0.0.1:24242` (or type the server's public address), type the nine digits and choose **Pair**.
3. Back in the admin panel, read the request: the name the device gave itself, **where it comes from** (its address as the rate limits count it, or "this computer"), its user agent, the time, and a four-digit **code**. Approve it only if it is your device. Tick **allow updates** if this device may also update the server.

Whoever types the nine digits first gets the request, so the panel shows who that was; if your own device is told that the code is "wrong, expired or already used", somebody else used it: **Reject** the request. Every client in the **Clients** table shows the same facts (source, user agent, creation time, last use) and a **Revoke** button that works at once, without a confirmation. The four-digit code of a client is derived from its token (`sha256` of the token, in hexadecimal, hashed again with a fixed prefix: see "API"), so a device can show what the panel shows and you can check that the device in front of you is the one that holds the token.

Narrarium checks the server's identity before sending anything: the server signs a fresh random value with its Ed25519 key, and Narrarium remembers the key's fingerprint. A server answering with another key is refused until you pair again. The fingerprint is shown in the admin panel and in Narrarium's settings.

Then, with your consent, send your AI router configuration from the same settings page, approve the AI endpoints it needs in the admin panel (**AI endpoints**: see [below](#ai-endpoints-and-spending-limits)), optionally set a spending limit (**AI spending**), and open a book's **Autopilot** page to choose **Move to my server**.

You can also create a token without pairing: in the admin panel (**Clients**) or on the server's computer with `npx narrarium-server client-token`, then paste it in Narrarium.

### Permissions

| Permission | Allows |
|---|---|
| `read` | Listing books, reading files, the live stream, the update check |
| `write` | Registering books, writing files, sending the AI configuration |
| `run` | Starting, pausing and steering the autopilot (the limits of a run, a pause at the end of the chapter, the settings that can change during a run), editing and removing its permanent rules, asking the director |
| `update` | Replacing the server with a newer verified version (granted only when you tick it) |

Revoking or rotating a token in the admin panel closes its live connection at once. A device that disconnects itself (`DELETE /api/v1/session`, with a token of any permission) revokes the token it presented and no other client's; a token that was replaced a moment ago cannot revoke its replacement.

## AI endpoints and spending limits

Whoever holds a token with the `run` permission can start runs that spend **your** AI credits, and whoever holds one with `write` chooses where the configuration sends your API keys. Both are decided by you here, whatever a client asks for.

### Approving AI endpoints

The server sends an API key only to an endpoint you approved. An *endpoint* is the **base** every request of an integration starts with: its `endpoint`, or the provider's default when it has none (`https://api.openai.com/v1` for OpenAI, `https://models.github.ai/inference` for GitHub Models). Every integration of a configuration sent by a client, the providers' defaults included, waits in the admin panel (**AI endpoints**) and in `GET /api/v1/ai` (`pendingApproval`) until you approve it. After an update from an earlier version, what the saved configuration needs is listed at the first start.

- An approval is an origin (`https://api.openai.com`) or an origin and a path (`https://my-resource.openai.azure.com/openai/v1`), compared as `new URL` writes them: host in lower case, no trailing slash, no query, default ports dropped. **An origin covers every base on it** (this is what every version up to 0.1.3 saved: nobody who approved before has to approve again); an entry with a path covers that base and what is under it, by whole segments (`/v1` covers `/v1/x`, not `/v10`). The **Approve** button approves exactly the base it shows.
- Before **every** call the server checks every endpoint the call can reach: the primary of its route and the fallbacks it may try (a fallback in another account that the privacy settings keep out, `sameBoundaryOnly`, or ask about, `requireAcknowledgement`, is never called by this server, which cannot answer that question: it needs no approval either). If one is not approved **nothing is sent**: the autopilot stops (status `error`, and Resume works once you approved) with a message that names the base, and a director question is answered `412 ai_not_approved`. It is not retried, and it is not a network error.
- The guard around outgoing requests (see [Security](#security)) is unchanged and decides by origin; the check above is what makes the owner's decision exact.
- GitHub Models is called at `https://models.github.ai` directly: unlike a browser, the server has no CORS restriction, so the web app's optional proxy setting (`githubModelsBaseUrl`) does not apply and is not passed to the AI client.

### Spending limits and the switch

The server counts everything it spends on AI and refuses a call that your limits do not allow. The settings live in `config.json` (field `spend`, absent when nothing is set) and are changed **only** by you, in the admin panel (**AI spending**) or on the server's computer with `npx narrarium-server spend`; no client token, whatever its permissions, has a call for it (the API only shows them).

```json
"spend": { "paused": false, "maxTokensPerDay": 0, "maxCostPerDay": 0, "maxTokensPerRun": 0, "maxCostPerRun": 0 }
```

| Setting | Meaning |
|---|---|
| `paused` | The switch. While it is set **no AI call is made** (the default is not set: spending is allowed). |
| `maxTokensPerDay`, `maxTokensPerRun` | Whole numbers of tokens (input and output); `0` is no limit. At most 10¹². |
| `maxCostPerDay`, `maxCostPerRun` | Amounts in the currency of the AI configuration; `0` is no limit. At most 1 000 000. They count only the costs that are **known** (a model with a price, whose usage the provider reported; a cost worked out from estimated tokens counts too, and is said so): a model without a price has no cost to cap, the token limits cover every model. |

- **Counting.** `private/spend.json` (written atomically, 0600, a few kilobytes) holds the totals of each UTC day (the last 31 are kept) and of the latest run of each book. It is fed by the AI client's `onAttemptEnd`, so **every attempt counts**, the failed ones that used tokens included, and tokens the provider did not report count as the engine's estimate; an attempt that used nothing is only a call. It holds numbers and ids only: never a key, an address, a prompt, a reply or an error. It is read again at start, so a restart does not give the day's allowance back.
- **A damaged record never stops the server.** If `spend.json` cannot be read it starts again from zero, keeps the unreadable file as `spend.json.damaged`, logs a line starting with `Spend`, and shows a warning in the panel.
- **Enforcement.** Before every AI call (and before starting a run, so that a run that would stop at its first call leaves no error in the book) the server checks the switch, then the day's limits, then the run's. A limit is reached when the total has got to it: the call that crosses it is the last one, and nothing starts after it (calls already in flight finish). A run is one start of the autopilot of a book, from Start or Resume until it ends: its totals begin from zero at every start, and count the AI calls of that book while it runs (a director question asked on that book meanwhile included); a director question asked otherwise counts in the day only.
- **What the author sees.** The run stops with status `error` and a message that says which limit, what was used and who can change it (`Server spending cap reached: 450 tokens were used today (UTC) and the owner's cap is 400 a day…`). It is never retried. It resumes with **Resume** after you raise the limit or, for a day's limit, after midnight UTC. Starting or asking while the switch is off or a day's limit is reached is answered `429 spend_limit` with the same message.
- **The switch is a kill switch.** Turning it off in the panel (or `spend --pause`) pauses every autopilot at once and abandons the call in flight (they are paused, not failed), and a director question in flight is abandoned too and answered `429 spend_limit`.
- **What a client reads.** `GET /api/v1/ai` (and the answer of `PUT /api/v1/ai`) carries, next to the redacted configuration, `spend` (always present, for every token with `read`):

```json
"spend": {
  "paused": false,
  "today": { "day": "2026-11-22", "tokens": 12345, "calls": 31, "cost": 0.42, "currency": "USD", "costUnknownCalls": 2 },
  "limits": { "maxTokensPerDay": 0, "maxCostPerDay": 0, "maxTokensPerRun": 0, "maxCostPerRun": 0 }
}
```

`today.cost` and `today.currency` appear when a cost of the day is known; `costUnknownCalls` when some calls used tokens at an unknown or estimated cost. The panel (`GET`/`POST /admin/api/spend`, behind the admin session, the CSRF token and the panel's origin like every other action there) shows the same, plus the warning above.

```bash
npx narrarium-server spend                                   # today's use, the limits, the switch
npx narrarium-server spend --pause                           # no AI call until --resume
npx narrarium-server spend --max-tokens-per-day 200000 --max-cost-per-run 2.5
```

Going back to a version older than 0.1.4 (see [Going back](#going-back)) forgets these settings: those versions know nothing about them and drop the field from `config.json` the next time they write it, so they spend without limits. Set them again after returning to 0.1.4 or later.

## Updates

When the server runs under the supervisor (`npx narrarium-server start`, the default), a newer release can be installed without touching the server's computer:

- from Narrarium, **Settings → Personal server → Version and updates**, with a token that has the `update` permission;
- from the admin panel, **Updates**.

The server accepts an update only when no autopilot is running and from then on refuses new work. The supervisor stops it cleanly, installs the exact version with `npm install --ignore-scripts`, runs `npm audit signatures`, compares the files with any copy of the same version it already has, and restarts the server on the new version. If anything fails, the previous version starts again and the reason is shown in Narrarium and in the admin panel. At most three updates per hour are performed.

Locally, `npx narrarium-server update [--to VERSION]` installs a version that the next start will use. It never installs a version older than the highest one this data folder has run (see [Going back](#going-back)).

### How an update is verified

A release is trusted only when this repository's publishing workflow built it, and that is read from the **attestation itself**, not from what the package's metadata says: whoever controls the npm package controls its metadata, and could register any GitHub repository as its trusted publisher and obtain perfectly valid provenance for it. The same checks decide what the server **offers** (without downloading anything) and what the supervisor or `update` **installs**, in this order:

1. **The metadata** (`npm view`): the package is `narrarium-server`, the version is the one asked for, the repository is `KeyserDSoze/GhostWriterFramework` (directory `packages/server`), the registry signatures are there, `dist.integrity` is one sha512 value, and the metadata points at an SLSA provenance attestation of that package and version. This is only a first filter.
2. **Not a rollback**: the version is not older than the highest one this data folder has run. For an older version nothing else happens: no download, and nothing is asked of npm beyond what `latest` is.
3. **Who signed** (read from `https://registry.npmjs.org/-/npm/v1/attestations/narrarium-server@<version>`, a small JSON document): exactly one SLSA provenance v1, whose signing certificate
   - has as its only subject alternative name `https://github.com/KeyserDSoze/GhostWriterFramework/.github/workflows/publish-server-npm.yml@refs/tags/narrarium-server-v<version>` (this workflow, at the tag of this very version),
   - was issued to GitHub Actions (OIDC issuer `https://token.actions.githubusercontent.com`),
   - is for GitHub repository id `1176286350` and account id `40713438` (numbers nobody can take over by registering the same names);

   and whose signed statement is about `pkg:npm/narrarium-server@<version>` and the sha512 of this tarball (the integrity npm announces; at install, the one npm recorded), and names that same repository, workflow file and tag. A release that fails is **not offered** (the update panel says that it is not trusted, the API's `message` says why, and the server log has a line starting `Update not offered`) and is never installed.
4. **Installing** (not when offering): `npm install --ignore-scripts` in a staging folder, with npm's own isolated configuration; the integrity npm recorded in the staging `package-lock.json` must be the one announced in step 1, so nothing can be swapped between two reads of the registry; `npm audit signatures` verifies the registry signature, and that a validly signed provenance bundle is about the installed tarball; then step 3 is repeated against what was really installed.
5. **Activating**: the installed files are compared with any copy of the same version already there, and the version is activated atomically.

The hand-published `0.1.0` has no attestation: it needs the registry signature only, and is accepted only as the copy prepared by `setup` or the first start.

### Going back

The data folder remembers the highest version it ever activated (`private/npm-highest.json`; for a folder from before that file, the version it runs). Nothing older is ever **offered, installed or activated** by an update: not what npm calls `latest`, not `update --to`, not an update request file, not the version of the CLI at start. Without this, whoever takes over the npm account could point `latest` at an older, vulnerable release that still carries perfectly valid provenance. A version equal to the highest, or newer, is fine.

To go back on purpose after a bad release, use a copy that is already installed on this computer:

```bash
npx narrarium-server rollback --to 0.1.1      # nothing is downloaded; a running server keeps its version until restarted
npx narrarium-server status                    # active runtime and highest version
```

The record is not lowered by a rollback, so updates stay as strict as before. A newer CLI installs its own version when it starts, so until a fixed release exists start the server with the version you went back to: `npx narrarium-server@0.1.1 start`. If `private/npm-highest.json` is damaged, installs stop with a message; delete the file and it is rebuilt from the active runtime.

### What this does not protect against

- **The very first `npx narrarium-server`** executes whatever npm serves under that name, before any of the checks above can run. Pin the version you mean (`npx narrarium-server@0.1.2`), and check it first: the package page on [npmjs.com](https://www.npmjs.com/package/narrarium-server) shows its provenance (repository `KeyserDSoze/GhostWriterFramework`, workflow `publish-server-npm.yml`, the tag and commit), and in a scratch folder `npm install --ignore-scripts narrarium-server@0.1.2 && npm audit signatures` verifies the signatures. From then on the server only moves to releases that pass the checks above.
- **Sigstore is verified by npm, not by this server.** `npm audit signatures` checks the signature, the certificate chain and the transparency log, and that the provenance is about the installed tarball; it does not tell who signed. The server reads the bundle to see who signed (the certificate's name, issuer and ids, and the signed statement's claims) but does not re-verify the signature itself, so it relies on the registry serving the same bundle to npm and to it.
- **GitHub and npm are the roots of trust.** Whoever can push a tag `narrarium-server-v*` to the repository, or change the workflow on such a tag, publishes a release that passes. Protecting that is the maintainer's job: see [Maintainers](#maintainers-releasing).
- **A proxy that only npm is configured for.** The registry is read by npm through `HTTPS_PROXY`; the attestation is read by the server with a direct HTTPS request, so behind a proxy that is the only way out, updates are not offered and `update` fails with a message that says the attestation could not be read.

## Reach the server from other devices (Cloudflare)

Both listeners stay on `127.0.0.1`. To use the server from another computer or from your phone, publish it over HTTPS:

- **Existing tunnel**: route a hostname of your tunnel to `http://127.0.0.1:24242`, then in the admin panel (**Approved network**) set it as the public API address.
- **New tunnel**: in the Cloudflare dashboard create a remotely managed tunnel and route a hostname to `http://127.0.0.1:24242`, install `cloudflared` 2025.4.0 or newer, then paste the connector token in the admin panel (**Cloudflare → Save and start**). The server runs its own connector (`cloudflared tunnel --no-autoupdate run`), never touches other connectors and does not restart a connector that stopped.

The connector token is kept **encrypted by the vault** (`private/cloudflare-tunnel-token.json`), never in clear text, never on a command line and never in a log: `cloudflared` receives it in its environment. A clear-text token file written by an earlier version is moved into the vault the first time the server starts, and deleted. The connector ends with the server: a clean stop (Ctrl+C, SIGTERM, a closed terminal) stops it, so does any exit of the server process, and a connector that outlived a server that was killed outright is recognised at the next start by its program and its start time (not by its process number alone, which may belong to something else by then) and stopped before a new one starts.

To manage the server remotely as well, route a second hostname (or the same one) to `http://127.0.0.1:24243`, set it as the public admin address **and turn on "Serve this panel on its public address"**: a new installation serves the panel on this computer only until you do (an installation that was updated from an earlier version keeps what it had). On that address the panel is served and `/api/v1/*` is passed to the API, which still checks the client token. Protect remote administration with Cloudflare Access if you can.

Narrarium on `https://narrarium.net` can always call the server; add other web origins under **Approved network**.

Set the public API address (**Approved network**) even when you only use the tunnel: besides the `Host` check, the server uses it to believe Cloudflare's `cf-connecting-ip` header, so that every limit below is counted for the real caller. Without a public address (and without the server's own connector) all tunnel traffic would count as one caller.

## Start automatically

```bash
npx narrarium-server setup --autostart
```

On Linux this installs a systemd user service (`~/.config/systemd/user/narrarium-server.service`; run `sudo loginctl enable-linger $USER` to start it before you log in). On macOS it installs a launch agent (`~/Library/LaunchAgents/net.narrarium.server.plist`, logging to `server.log` in the data folder). On Windows, add `npx narrarium-server start` to Task Scheduler at logon. The service runs the supervisor of the version installed by `setup`; the server it starts is always the active version, so run `setup --autostart` again after updates if you want the supervisor itself to move to the newer version.

The service starts with the `PATH` of the shell that ran `setup` (absolute entries only; so npm, git and cloudflared installed through nvm or Homebrew are found) and is restarted after a crash at most ten times in five minutes: after that systemd leaves it stopped, and `systemctl --user reset-failed narrarium-server` lets it start again. Run `setup --autostart` again to refresh an older unit.

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
npx narrarium-server spend [--pause | --resume] [--max-tokens-per-day N] [--max-cost-per-day N] [--max-tokens-per-run N] [--max-cost-per-run N]
npx narrarium-server update [--to VERSION]   # never a version older than the highest ever installed
npx narrarium-server rollback --to VERSION   # reactivate an installed older copy (nothing is downloaded)
npx narrarium-server --version
```

| Option | Commands | Meaning |
|---|---|---|
| `--data-root DIR` | all | Data folder (see below). |
| `--port N` | `start`, `setup` | API port (default `24242`, saved in `config.json`). |
| `--admin-port N` | `start`, `setup` | Admin panel port (default `24243`, saved). |
| `--label NAME` | `start`, `setup`, `client-token` | Server name shown in Narrarium, or the new client's name. |
| `--to VERSION` | `update`, `rollback` | The exact version to install, or to go back to (`rollback` needs it). |
| `--origin URL` | `start` | Allow another web origin (saved; repeatable). |
| `--direct` | `start` | Run without the supervisor: everything works except remote updates. |
| `--verbose` | `start` | Log every request. |
| `--pause`, `--resume`, `--max-tokens-per-day N`, `--max-cost-per-day N`, `--max-tokens-per-run N`, `--max-cost-per-run N` | `spend` | The switch and the limits (`0` is no limit); without any of them the command only shows them. |

The admin code is never accepted on the command line. Rotating it ends every admin session; client tokens keep working. Editing `private/admin-code.txt` by hand and restarting the server also replaces it.

`client-token`, `rotate-admin-code`, `set-admin-code` and `spend` talk to the running server on its admin port, and **never send the admin code to a program that cannot prove it is that server**: before anything secret is sent they ask the listener to sign a fresh random value (`GET /admin/api/identity?nonce=HEX64`) and check the signature with the public key in the data folder (`private/identity.json`). A program that took the port while the server was down, another server with another data folder, and an answer recorded earlier are all refused with an explanation ("The admin code was NOT sent"). A server older than this version has no identity check: the commands refuse it too, so restart it first (or use the admin panel in a browser). The commands sign out of the admin panel when they are done.

## Data folder

Default location, unless `--data-root` or `NARRARIUM_SERVER_HOME` says otherwise:

| System | Folder |
|---|---|
| Linux | `$XDG_DATA_HOME/narrarium-server`, or `~/.local/share/narrarium-server` |
| macOS | `~/Library/Application Support/Narrarium Server` |
| Windows | `%LOCALAPPDATA%\Narrarium\server` (a data folder that earlier versions made under `%APPDATA%\Narrarium\server`, the roaming profile, keeps being used; nothing is moved) |

```text
config.json              ports, label, origins, approved network, spending limits (no secrets)
books.json               hosted books
books/<id>/repo/         working copy of each book: every autopilot step is a git commit
books/.trash/           removed or replaced working copies, deleted for good after 14 days
private/                 0700
  admin-code.txt         admin code (0600)
  authorization.json     client tokens as SHA-256 hashes, pending pairing
  master.key             vault key (0600; protected by DPAPI on Windows)
  master.key.bak         a copy of it, made once and never overwritten (see below)
  identity.json          the server's Ed25519 key, its private half encrypted
  ai.json                AI router configuration, encrypted
  spend.json             what the server spent on AI per UTC day and per run (numbers only)
  book-tokens.json       per-book GitHub tokens, encrypted
  cloudflare-tunnel-token.json   the Cloudflare connector token, encrypted
  cloudflare-tunnel.json, cloudflared-process.json, cloudflared-home/   connector settings, and the connector that runs (its process number and start time)
  npm-runtime/           verified versions and the active one
  npm-install.json       the installer's state: the active version
  npm-highest.json       the highest version ever activated: nothing older is installed from npm
  git-home/              the empty home git runs in (never your own ~/.gitconfig)
  npm-home/              the empty home, configuration and cache npm runs with (never your ~/.npmrc)
  update-request.json, update-result.json
```

One server per data folder: a kernel lock on Linux (`flock`), a named mutex on Windows, a lock file (`server.lock`) on macOS. The lock file names the process that holds it and when that process started, so a number that was given to another program after a reboot or a crash is not taken for a server; it is created whole, taken over from a dead holder by one server at a time, and its holder checks every few seconds that it is still its own. **A server that loses its lock** (the lock helper was killed, the lock file was deleted or replaced) stops serving at once, pauses its autopilots, closes, and exits with an error, so that a supervisor or service manager starts it again instead of two servers writing in one folder.

**The vault key** is never created again by accident: if `private/master.key` is missing while encrypted files (`identity.json`, `ai.json`, `book-tokens.json`, `cloudflare-tunnel-token.json`) exist, the server refuses to start and says so, because a new key would make them unreadable for good. Copy `private/master.key.bak` over `master.key` (or restore it from your own backup) and start again; to start with no secrets instead, move the encrypted files away first (devices must then pair again, and the AI configuration and GitHub tokens must be sent again).

## Security

- Both listeners bind to `127.0.0.1`; requests with an unexpected `Host` header are refused (DNS-rebinding protection). Private Network Access preflights are answered for allowed origins.
- Browser requests are accepted only from allowed origins. Every API call needs a client token with the right permission.
- The admin panel needs the admin code, an `HttpOnly`, `SameSite=Strict` cookie and a CSRF token; it is served under a strict Content-Security-Policy.
- AI keys, GitHub tokens and the identity key are encrypted with AES-256-GCM; client tokens are stored only as hashes and never returned.
- The server calls only the AI endpoints you approved (by base: see [AI endpoints and spending limits](#ai-endpoints-and-spending-limits)), GitHub and the npm registry: DNS is resolved once per connection, private addresses are refused (except an approved local model on `127.0.0.1`) and redirects are never followed.
- Updates are verified end to end, from the attestation and not from the package's metadata, and never go back to an older version: see [How an update is verified](#how-an-update-is-verified) and [Going back](#going-back), and what they do not cover.
- npm runs without install scripts and without your npm credentials: every run gets empty user and global configuration files, a private cache and home and an empty working folder, so your `~/.npmrc` (tokens, registry overrides) is never read. A proxy you configured only there stops applying: use `HTTPS_PROXY`, which is still passed, and `NODE_EXTRA_CA_CERTS`.
- A book's working copy is not trusted (a cloned repository can contain anything): no operation follows a symbolic link, git runs with `core.symlinks=false`, a private home, no hooks, no credential helpers and no URL rewrites from your own configuration, the names of git's own folder are refused in every spelling (`.GIT`, `GIT~1`, trailing dots, look-alike Unicode) together with Windows device names, and only text files (`.md`, `.markdown`, `.txt`, `.json`, `.yaml`, `.yml`) can be written. A commit is validated before anything is written, and a failed one puts every file back.
- Admin sessions are bounded without ever ending everybody's: at most ten per address and fifty in all, the least recently used one goes first, and an expired one goes before any live one (a new admin code, on purpose, ends all of them).
- The panel is reachable on its public address only when you turn that on (new installations); the server's name in `GET /info` is neutral (an earlier default `narrarium-server@computer` is shown as `narrarium-server` to everybody but you).
- Book files are flushed to disk before they are put in place, and the folders that gained or lost files after that, so a power cut cannot leave a half-done commit; one thing at a time happens in a book's working copy (commits, pulls and pushes of the autopilot and of `POST /sync` take turns); the books' revisions are not asked of git on every listing; and registering a book is all or nothing (a failed first clone, or a failure to store the token or the entry, leaves no registration, token or folder behind).
- Book ids that a Windows computer cannot keep (`con`, `nul`, `aux`, `com1`…, with or without an extension; names that end or start with a dot) are refused for new books; books that already have such an id keep working.
- The guard around outgoing requests honours what the caller asked for (a `Request` object's method, headers and body; `redirect: "manual"` returns the 3xx answer, nothing is ever followed), lets no caller set `Host` or the framing headers, and offers every verified address of a host to the connection (a local model on `localhost` may listen on `127.0.0.1` or `::1`).
- Behind a proxy: when `HTTPS_PROXY` is set in the server's environment (the variable git and npm already receive; an `http://` address, or a bare `host:port`, with optional `user:password@`; `NO_PROXY` applies), the server's own requests to AI endpoints and the npm registry go through it with `CONNECT`. TLS is spoken with the destination itself inside the tunnel, so its certificate is verified exactly as without a proxy (a proxy that inspects TLS needs its authority in `NODE_EXTRA_CA_CERTS`) and the proxy sees only encrypted bytes; the destination must still be approved and a private address is still refused, but a name that this computer cannot resolve within three seconds is left to the proxy, which resolves it and makes the connection, so the address it uses cannot be checked here. An approved local model is never sent through a proxy, and a proxy variable that is not an `http://` address (`socks5://`, `https://`) is ignored by these requests, as before. A proxy that refuses or is not there is one clear error (`Could not connect to <origin> through the proxy named by HTTPS_PROXY (the proxy answered 403)`) that never repeats the proxy's address or credentials.
- Every limit is counted per caller, never for everybody at once, so an anonymous caller cannot lock you out: 10 wrong admin codes per five minutes per address (a correct code clears the count), 10 pairing requests per five minutes per address (and 5 wrong codes per address, 50 in all, inside one pairing), 120 `info` requests a minute per address, 60 failed authentications a minute per address, 16 anonymous requests in flight per address, 6000 authenticated requests a minute per client token, and 10 live connections per client token (50 in all). A request body that goes quiet for 20 seconds is dropped, a whole request must arrive within five minutes, and at most two large uploads are read at once. Refused requests answer 429 with `Retry-After` (or 408, 503).
- A server error that is not understood answers `500 internal` with a short `requestId` (also in the `x-request-id` header) and the details only in the log.
- Removing a book, or moving it to another storage, never deletes its working copy: it goes to `books/.trash` for 14 days, and a failed move leaves the old copy untouched.

## How books travel

- **GitHub books**: the server clones the same branch, commits every autopilot step and pushes it (by default: the author can choose to publish only when a chapter is closed, or never: see [Quick controls and publishing](#quick-controls-and-publishing)); before each step it pulls the author's work. Narrarium pulls the server's commits through its usual repository sync. The book's GitHub token is sent to the server only with the author's explicit consent.
- **Local books**: files are exchanged with a three-way sync (`syncBookStores` in the engine): changes on one side are copied to the other, and files changed on both sides are reported instead of overwritten.

## Quick controls and publishing

The controls behind the web app's quick-command bar: pausing at the end of the chapter (and taking a pause back), the limits of one run, and the settings that can change while a run goes on, one of which is where a GitHub book is published. The engine does the work (see *Quick controls* in the [engine's README](../engine/README.md)); the server adds the routes and the push.

A server that has them announces `"autopilot-controls"` in the `features` of `GET /api/v1/info`. An older server does not, and would ignore `limits` and read every pause mode but `now` as `after-step` (a `cancel` would pause), so a client checks the feature before it sends them (`serverSupportsAutopilotControls(info)` in the engine).

All three calls need the `run` permission, answer the snapshot of the autopilot (what `GET /books/:id/autopilot` answers: its `summary` has `pausePending`, `limits` and `publish`) and, when they refuse, answer `{ "code", "message" }`. Every one also answers 401, 403 `scope` (no `run` permission) and 404 `book_not_found`.

| Call | Body | Answer |
|---|---|---|
| `POST /books/:id/autopilot/pause` | `{ "mode": "now" \| "after-step" \| "after-chapter" \| "cancel" }`. No `mode` is `after-step`, as it always was. | `200`. `after-chapter` finishes the chapter in progress (its closing and its publishing included) and pauses; the stricter of two requests counts. `cancel` takes back a pause that waits and stops nothing; with nothing waiting, and any mode with nothing running, the answer is `200` too and nothing changes. A pause is not refused while an update is about to start. `400 invalid_request`: a `mode` that is none of the four, or a body that is not a JSON object. |
| `POST /books/:id/autopilot/start` | The body it always had (`brief`, `options`, `force`) and `limits?: { "steps"?: n, "chapters"?: n }`: the run pauses after that many steps saved, or chapters completed. | `200`. `400 invalid_request` when `limits` is present and is not an object: it is checked before anything else, and nothing starts. The numbers go to the engine as they are (a value that is not a whole number above zero is no limit). Limits are for that run only: they are not saved, and the next start has none. The other answers are as before: `409 busy`, `412 ai_not_configured`, `429 too_many_runs`, `429 spend_limit`, `503 maintenance`. |
| `PUT /books/:id/autopilot/options` | `{ "publishEvery"?: "off" \| "chapter" \| "step" \| null, "pauseAfterEachChapter"?: boolean }`: at least one, and nothing else. `null` takes the choice back, so that the server's default (`step`) decides again. | `200`, also while the autopilot runs: the choice is saved in the book, the step in flight is not repeated, and the run reads the new value at the end of the step or of the chapter. A book with no autopilot state gets one (as `configure` does). `400 invalid_request` for any other key (nothing of the request is applied, not even the part that was right), a value of the wrong type, or a body that is not an object; `409 conflict` when the state file kept changing under the write (try again); `409 state_corrupt` when it cannot be read; `503 maintenance`. |

`summary.pausePending` (`"after-step"`, `"after-chapter"` or `null`) and `summary.limits` (`{ steps?, chapters?, stepsDone, chaptersDone }` for the run in progress, `null` when it has none or is over) are never saved. They are in the snapshot, in the `state` events of the live stream, and in the `autopilot` summary that `GET /books` and the `book` events carry for every book; `summary.publish` is where the book is published now.

### Publishing to GitHub

`publishEvery` says when the server pushes a GitHub book. The author chooses it (and can change it while the run goes on); a book with no choice takes the server's default, `step`, which is what every server did before. The old option `syncAfterChapter` is the browser's and does not decide here.

| `publishEvery` | The server pushes |
|---|---|
| `step` (default) | After every step, and once more when a chapter is closed (that second push has nothing new when the step that closed the chapter was just pushed). |
| `chapter` | When a chapter is closed, and only then. |
| `off` | Never: every commit stays in the book's working copy. |

- The engine decides and the server only pushes. The choice is read at the end of every step and of every chapter, from the state that step saved, so a change takes hold at the end of the step that is running. A book that is not on GitHub has nowhere to push, whatever it says (its `summary.publish` is then only what it would be).
- **`lastSync`** says how the last push went, whether it worked or not: `{ "ok": true, "message": "Pushed to GitHub." }`, or `{ "ok": false, "message" }` with what git said (cut to 500 characters, with the token taken out). A push that fails is a warning (a `sync` event with `syncFailed`, or `publishFailed` for a chapter) and never stops the run: its commits wait for the next push that works, or for `POST /books/:id/sync`. With `off` no push is tried, and `lastSync` stays as it was.
- **What waits on the server.** With `step`, only the commit that records how the run ended; with `chapter`, everything after the last chapter that was closed (the director's judgement of the whole book, how the run ended); with `off`, everything. `POST /books/:id/sync` publishes it all by hand. With `off`, GitHub does not move at all, so the web app's usual repository sync does not see what the autopilot wrote until a publish.
- **The risk of `chapter` and `off`.** Before every step the server still pulls what the author published (a fetch, then a fast-forward, otherwise a rebase of its own commits under the author's), and with these two ways it has more unpublished commits for longer.
  - A change made on GitHub to a file that the server also changed cannot be rebased under them (every step rewrites `autopilot/state.json` and `autopilot/activity.json`; chapters, `plot.md` and the resumes change as the book grows). The next step then fails and the run stops with status `error` and the message *The book changed on GitHub in a way that conflicts with the server's work. Resolve it from the web app, then resume.* `POST /books/:id/sync` answers `409 sync_failed` with the same words. A change to a file the server did not touch is rebased under its commits, and the run goes on.
  - Nothing is lost: the rebase is always undone, the server's commits are all still in the working copy, and the working copy is clean.
  - To go on, settle it on GitHub (undo or redo the change that conflicts, so that the server's commits rebase cleanly) and resume; or merge on the server, where the working copy is an ordinary git repository (`books/<id>/repo` in the data folder: `git pull --no-rebase`, settle the file, commit, `git push`); or give up the server's unpublished work by removing the book from the server (its working copy stays in `books/.trash` for 14 days) and registering it again from GitHub.
  - To avoid it, keep `step` for a book that is also edited on GitHub or by another device, or publish with `POST /books/:id/sync` before anybody else edits it. With `step` the same conflict is possible too, but only in the moment between one push and the next.

## Permanent rules

The rules the author gives with `from_now` (and the answers to the director that are kept as rules) are `state.constraints` in the autopilot's state, in the order the author sees them. Two calls edit and remove them, also while the autopilot runs. A server that has them announces `"autopilot-rules"` in the `features` of `GET /api/v1/info` (`serverSupportsAutopilotRules(info)` in the engine reads it): an older server answers `404 not_found` to the routes, so a client asks before it offers to edit or remove a rule.

Both calls need the `run` permission, answer the snapshot of the autopilot (as `…/options` does) and check a request in the same order: `503 maintenance`, `404 book_not_found`, the address, the body. `:index` is the position of the rule in `state.constraints`, from 0, written as an address writes a whole number (`0`, `7`): `-1`, `1.5`, `01`, `1e2` or `abc` are `400 invalid_request`, and a number that names no rule is `404 rule_not_found`. `expectedText` is the rule as the author saw it: when the rule at that index is no longer that (compared without the spaces around it), nothing is written and the answer is `409 rule_changed`, so a rule that changed in the meantime (on another device, or by the author's answer to the director) is never overwritten or removed by mistake. A client always sends it. After a removal the rules after it move up by one: a client reads the answer, not its own list.

| Call | Request | Answer |
|---|---|---|
| `PUT /books/:id/autopilot/rules/:index` | `{ "text": string, "expectedText"?: string }`, and nothing else (a field that is misspelt is refused, not ignored: a guard that goes unread is no guard). The text goes to the engine as it is, never trimmed or cut first. | `200` the snapshot, of the state that was saved. The step in flight is not repeated, and the next step has the rule as it is now. A text equal to the rule it replaces changes nothing. |
| `DELETE /books/:id/autopilot/rules/:index?expectedText=…` | No body. `expectedText` is URL-encoded (it is decoded as every parameter is), given once, at most 10 000 characters (the longest rule an older engine kept was 8000). It is the one parameter: any other is refused. | `200` the snapshot. |

| Status | `code` | When |
|---|---|---|
| 400 | `rule_empty` | The text is empty or only spaces. |
| 400 | `rule_too_long` | The text is over 800 characters. It is refused, never cut: the message gives the length that was sent. |
| 400 | `rule_duplicate` | Another rule already says it. |
| 400 | `invalid_request` | The number is not a whole number from 0; the body is not a JSON object of `{ text, expectedText? }` (`text` missing or not a string, `expectedText` not a string or over 10 000 characters, another field); the address has a parameter other than `expectedText`, or has it twice. A body that is not JSON is `400 invalid_json`, one that is not `application/json` is `415`, and one over the limit is `413`, as for the other calls. |
| 404 | `rule_not_found` | There is no rule at that number (*There is no rule number 4.*), or the book has never run. |
| 409 | `rule_changed` | The rule at that number is not `expectedText`. |
| 409 | `conflict`, `state_corrupt` | The state file kept changing under the write (try again); it cannot be read. |
| 503 | `maintenance` | The server is about to restart for an update. |

Every call also answers 401, 403 `scope` (no `run` permission) and 404 `book_not_found`. The text of a rule is the author's, and a DELETE carries it in its address: the server's log writes `?***` in place of the query of these two calls (the only addresses it changes). A request address is limited to 16 KB by Node, so a rule of thousands of accented characters cannot be named in a DELETE: shorten it with a PUT first, or send no `expectedText`.

### What the server passes on

The server does not add to what the engine says about a run, take anything out of it, or write it again: the snapshot (`GET /books/:id/autopilot`), the summaries of `GET /books` and of the `book` events, and the `state` events of the live stream carry the engine's own state and summary. These fields came with engine 0.1.6. Each is absent until the engine has something to say, and from a file that an older engine wrote (the server never makes one up: not zero, not `NaN`, not an empty list):

| Field | Where | What it is |
|---|---|---|
| `finalReview` | `state`, and `summary` with the text cut shorter | The director's judgement of the whole book once the final step is done: `{ verdict: "approve" \| "revise", score, text, at }`. |
| `stats.workedMs` | `state`, `summary.stats` | The milliseconds the autopilot worked, over every run: the sum of the steps that were saved (not the wait for the author, the pauses, the attempts that failed or the waits between them). |
| `errorKind`, `errorDetail` | every failed activity (and its `task-finished` event), `state.lastError`, and `summary.lastError`, which also has them as `kind` and `detail` | What went wrong, in a closed list (`network`, `auth`, `rate_limit`, `timeout`, `truncated`, `refused`, `conflict`, `budget`, `limit`, `profile`, `provider`, `unknown`), and where: `{ status?, endpoint?, model?, provider?, integration?, attempt?, retries? }`. `endpoint` is the origin of the provider's address and nothing more, and no field holds a secret. |
| `summary.retry` | the snapshot, `GET /books`, the `book` events and the `state` events | `{ at, attempt, retries }` while the run waits to try a failed step again (never sooner than the provider's `Retry-After`): when the next attempt is, and which retry. Never saved. A `state` event says it when the wait begins and another says it is over, so a client replaces its summary by the newest event it has seen. `at` is the server's clock: count down from the `at` of the event, not from the browser's own time. |
| `plan.chapters[].rounds` | `state.plan` | The rounds of review of a chapter that closed, oldest first: `{ director?, readers?, accepted?, rejected? }`. Not in the summary. |

**No secret goes through.** An AI key is never in an answer, an event, the log or a file: the engine takes it out of what a provider says (a 401 that repeats the key, a message that names it) before anything is kept, and the server only passes on what the engine kept. The server's tests prove it with a provider that names the key in what it says, and then look for it in every answer, event, log line, file and change of the book.

## API

All endpoints live under `/api/v1` and return JSON; errors are `{ "code", "message" }`.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/info?nonce=HEX64` | none | Identity, version and `features` (among them `autopilot-controls` and `autopilot-rules`: see [Quick controls and publishing](#quick-controls-and-publishing) and [Permanent rules](#permanent-rules)), signed over the nonce. |
| `POST` | `/pairings`, `/pairings/:id/result` | none | Pair with a code (answers `{ id, verification }`); collect the token once approved (answers `{ token, verification }`). `verification` is optional: four digits that the owner sees in the panel too (below). |
| `GET`/`DELETE` | `/session` | any | The calling client and its permissions / revoke the token it presented, and no other (disconnect; answers `{ revoked }`). |
| `GET`/`PUT` | `/ai` | read / write | Redacted AI status (with the endpoints awaiting approval and the spending status) / replace the configuration. |
| `GET` | `/books` | read | Hosted books with their autopilot summary. |
| `PUT`/`DELETE` | `/books/:id` | write | Register (local or GitHub) / remove a book. |
| `GET` | `/books/:id/manifest` | read | Paths and hashes of the book's text files. |
| `POST` | `/books/:id/files/read`, `/books/:id/files/commit` | read / write | Read up to 100 files (16 MiB in all) / commit up to 5000 changes with compare-and-swap. |
| `POST` | `/books/:id/sync` | write | Pull and push the GitHub branch. |
| `GET` | `/books/:id/autopilot`, `/books/:id/autopilot/events?since=N` | read | Snapshot / recent live events. |
| `POST` | `/books/:id/autopilot/{start,pause,intervene,answer}` | run | Control the autopilot (`answer` takes `{ questionId, answer, accept?, asRule? }`: with `asRule` the answer becomes a permanent rule; `start` takes `limits`, `pause` takes `after-chapter` and `cancel`: see [Quick controls and publishing](#quick-controls-and-publishing)). |
| `PUT` | `/books/:id/autopilot/options` | run | Change `publishEvery` (where a GitHub book is pushed) and `pauseAfterEachChapter`, also while the autopilot runs. |
| `PUT`/`DELETE` | `/books/:id/autopilot/rules/:index` | run | Edit / remove one permanent rule of the autopilot, also while it runs (see [Permanent rules](#permanent-rules)). |
| `POST` | `/books/:id/autopilot/{configure,reset}` | write | Change or reset its settings. |
| `POST` | `/books/:id/director/ask` | run | Ask the director about the book, a chapter or a scene. |
| `GET` | `/events` | read | Server-sent events: autopilot events and book summaries. |
| `GET`/`POST` | `/updates` | read / update | Release check / request the verified update. |

The typed client is `NarrariumServerClient` in `narrarium-engine` (with `pairWithServer` and `verifyServerIdentity`).

**Errors the engine and the owner's settings give.** Every refusal below keeps its message (never a `500 internal`):

| Status | `code` | When |
|---|---|---|
| 400 | `rule_empty`, `rule_too_long`, `rule_duplicate` | A permanent rule (`from_now` or `rewrite` intervention, or an answer with `asRule`) that is empty, over the engine's 800 characters (never cut: the message gives the length that was sent), or already there. A note (`next_step`) may be longer; an empty one is `400 invalid_request`. |
| 404, 409 | `rule_not_found`, `rule_changed` | A rule that is not there, or changed since the author saw it (`PUT`/`DELETE …/autopilot/rules/:index`: see [Permanent rules](#permanent-rules)). |
| 409 | `question_closed` | The director's question was answered already. |
| 412 | `ai_not_approved` | The call would send an API key to an endpoint the owner has not approved. |
| 422 | `frontmatter_invalid` | The engine refused to rewrite a file whose frontmatter cannot be read; the message names the file and the line. |
| 429 | `spend_limit` | The owner's switch is off, or a day's limit is reached (starting a run, asking the director). |
| 502 | `ai_provider` | The AI provider failed, or the engine refused to call it (a prompt over every model's context window, a routing budget, a fallback the privacy settings keep out): the engine's message, as it is. |

**Verification codes.** `verification` is `String(sha256("narrarium-pairing-verification\n" + kind + "\n" + hashHex).readUInt32BE(0) % 10000).padStart(4, "0")`, where `hashHex` is the lowercase hexadecimal SHA-256 of a secret: for the pairing request (`kind` is `request`, shown in the panel while the request waits) the client's nonce, for the issued token (`kind` is `client`, shown next to the client in the panel) the token. A device can compute the same four digits from what it holds, or just display what the server answered.

The admin port also answers `GET /admin/api/identity?nonce=HEX64` (no session): `{ name, serverId, publicKey, fingerprint, nonce, signature }`, the same signature as `GET /info?nonce=` gives, for the local commands.

## Maintainers: releasing

Releases are published by [`.github/workflows/publish-server-npm.yml`](../../.github/workflows/publish-server-npm.yml) through npm Trusted Publishing, with a provenance attestation and without any npm token:

1. Bump `version` in `packages/server/package.json` and `SERVER_VERSION` in `src/version.ts` (a test keeps them equal); `packages/engine` has the same pair (`ENGINE_VERSION`), commit and push.
2. Push the tag: `git tag narrarium-server-v0.1.2 && git push origin narrarium-server-v0.1.2`.

The workflow checks that the tag matches the package, builds and tests the engine and the server, checks the package contents and publishes. The generic `Publish npm packages` workflow never publishes this package.

### Protect the release path

Every installed server accepts exactly one identity (`NPM_RELEASE_IDENTITY` in `src/npm-release.ts`): the account and repository above, the workflow file `publish-server-npm.yml`, and a tag `narrarium-server-v<version>`. Keep that true, and protect who can reach it:

- **Do not change the identity by accident.** Renaming the account, the repository or the workflow file, giving the workflow another trigger (`workflow_dispatch`, a branch), or recreating the repository, makes releases that every installed server refuses. Such a change needs a server release that carries the new identity, installed by hand (`npx narrarium-server@<version>`). Bump the publishing npm (`npm@12.0.2` in the workflow) only to versions that still write SLSA provenance v1.
- **GitHub**: a ruleset on the tags `narrarium-server-v*` that restricts who can create them and blocks updating and deleting them (a published tag must never move); required reviewers on the `npm-publish` environment, with that environment limited to the tags `narrarium-server-v*`; no other workflow may publish this package.
- **npm**: two-factor authentication on the maintainer account (also for publishing), the package's *Trusted publishing* set to this repository, workflow and the `npm-publish` environment and nothing else, and every old npm token revoked (publishing uses OIDC, no token is needed). After any change to the account, look at the package's trusted publishers again.
- **After publishing**, open the package page and check that the provenance names this repository, the workflow and the tag. It is the check every installed server makes before it updates (`verifyNpmReleaseProvenance` in `src/npm-release.ts`), tested against the real registry data of `0.1.2` (`test/fixtures`): a release that does not pass it is never offered.

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

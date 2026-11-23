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
| `read` | Listing books, reading files, the live stream, the update check; a book's MCP status and the tools of its MCP endpoint that read |
| `write` | Registering books, writing files, sending the AI configuration; switching a book's MCP on or off; the tools of its MCP endpoint that change the book |
| `run` | Starting, pausing and steering the autopilot (the limits of a run, a pause at the end of the chapter, the settings that can change during a run), editing and removing its permanent rules, asking the director; the tools of its MCP endpoint that steer the autopilot |
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

### How long a call to a provider may take

A slow model (a 30B model behind a gateway) can be silent for minutes, and a call that does not stream (`streamMode: "off"`) takes as long as the whole reply to begin. Three deadlines decide when the server gives up on a call, and they are the engine's (*Timeouts and streaming* in the [engine's README](../engine/README.md)), set for each integration in the web app: the **start** deadline (from sending the request until the headers arrive, the connection included; the whole call when it does not stream; 600 s by default, never under 30 s), the **idle** deadline (the longest silence between two pieces of a stream; 600 s by default, between 30 s and 3600 s) and a **total** cap (4 h, not configurable). Every reply streams unless the integration says otherwise, so a model that is alive is not silent.

Nothing else cuts a call earlier. Node's own `fetch` (undici) has two limits of its own, 300 s each, that no deadline of the engine can raise: `headersTimeout` (the headers of a response) and `bodyTimeout` (the silence between two pieces of a body). The server's process does not use it for these calls: when it starts it replaces `fetch` with the outbound guard's (`network.ts`, built on `node:http` and `node:https`, see [Security](#security)), which limits the connection (30 s, as long as the engine's shortest start deadline, so that a connection is never cut before the engine would cut the call) and nothing after it. This was tried with the built server (`dist/server.mjs`): a provider that sent its headers after 310 s, and another that went silent for 310 s in the middle of a stream, were both waited for, and a plain Node 22 `fetch` given the same delays failed after 301 s (`UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`). The tests do the same in a moment, with Node's two limits lowered, and one of them starts `dist/server.mjs` to check that the process as it is published wears the guard (a provider's redirect is refused there; the platform's `fetch` follows it). Do not give the AI client a `fetch` of its own (an undici `Agent` with the two limits off would not be cut either): it would leave the guard behind, with its pinned addresses, its refusal of private addresses and redirects, and its proxy.

A call that the author cancels (a pause now, the owner's switch, a director question whose connection closed) is aborted through the signal: the connection is closed at once, whatever the deadlines are, and the attempt is counted as a call that used nothing.

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

The server accepts an update only when no autopilot is running and from then on refuses new work. The supervisor stops it cleanly, installs the exact version with `npm install --ignore-scripts`, checks the registry's signature of it itself and runs `npm audit signatures` ([how an update is verified](#how-an-update-is-verified)), compares the files with any copy of the same version it already has, and restarts the server on the new version. If anything fails, the previous version starts again and the reason is shown in Narrarium and in the admin panel. At most three updates per hour are performed.

Locally, `npx narrarium-server update [--to VERSION]` installs a version that the next start will use. It never installs a version older than the highest one this data folder has run (see [Going back](#going-back)).

The admin panel keeps the **history** of the last twenty updates, with what the supervisor verified in each and why one was refused: see [The history of the updates](#the-history-of-the-updates).

### How an update is verified

A release is trusted only when this repository's publishing workflow built it, and that is read from the **attestation itself**, not from what the package's metadata says: whoever controls the npm package controls its metadata, and could register any GitHub repository as its trusted publisher and obtain perfectly valid provenance for it. The same checks decide what the server **offers** (without downloading anything) and what the supervisor or `update` **installs**, in this order:

1. **The metadata** (`npm view`): the package is `narrarium-server`, the version is the one asked for, the repository is `KeyserDSoze/GhostWriterFramework` (directory `packages/server`), the registry signatures are there, `dist.integrity` is one sha512 value, and the metadata points at an SLSA provenance attestation of that package and version. This is only a first filter.
2. **Not a rollback**: the version is not older than the highest one this data folder has run. For an older version nothing else happens: no download, and nothing is asked of npm beyond what `latest` is.
3. **Who signed** (read from `https://registry.npmjs.org/-/npm/v1/attestations/narrarium-server@<version>`, a small JSON document): exactly one SLSA provenance v1, whose signing certificate
   - has as its only subject alternative name `https://github.com/KeyserDSoze/GhostWriterFramework/.github/workflows/publish-server-npm.yml@refs/tags/narrarium-server-v<version>` (this workflow, at the tag of this very version),
   - was issued to GitHub Actions (OIDC issuer `https://token.actions.githubusercontent.com`),
   - is for GitHub repository id `1176286350` and account id `40713438` (numbers nobody can take over by registering the same names);

   and whose signed statement is about `pkg:npm/narrarium-server@<version>` and the sha512 of this tarball (the integrity npm announces; at install, the one npm recorded), and names that same repository, workflow file and tag. A release that fails is **not offered** (the update panel says that it is not trusted, the API's `message` says why, and the server log has a line starting `Update not offered`) and is never installed.
4. **The registry's signature** (when installing, not when offering), which the server verifies itself, so that it does not depend on which npm this computer has. It reads the registry's own document of the version (`https://registry.npmjs.org/narrarium-server/<version>`) and the registry's list of public keys (`https://registry.npmjs.org/-/npm/v1/keys`), and requires **every** signature in `dist.signatures` to be an ECDSA P-256 SHA-256 signature of `narrarium-server@<version>:<integrity>`, made with a key the registry lists, for the very tarball that step 3 judged. A release is refused, before anything is downloaded, when it has no signature, a signature by a key the registry does not list, a signature that is not valid, an integrity that differs from the one announced, or a signature by a key that had expired before the release was published (that date is the registry's, read from its packument only when a key has expired). A list of keys that is not valid (two keys with one id, a date that is not a date) refuses the release too. Each answer is one bounded direct HTTPS read like the attestation's (no credentials, no redirect, no cache, 12 seconds at most), and the keys are read once per install.
5. **Installing** (not when offering): `npm install --ignore-scripts` in a staging folder, with npm's own isolated configuration; the integrity npm recorded in the staging `package-lock.json` must be the one announced in step 1, so nothing can be swapped between two reads of the registry; `npm audit signatures` verifies the registry signature again, and that a validly signed provenance bundle is about the installed tarball (one failure of it is accepted, and only that one: see [When `npm audit signatures` cannot finish](#when-npm-audit-signatures-cannot-finish)); then steps 3 and 4 are repeated against what was really installed.
6. **Activating**: the installed files are compared with any copy of the same version already there, and the version is activated atomically.

The hand-published `0.1.0` has no attestation: it needs the registry signature only (step 4 applies to it too), and is accepted only as the copy prepared by `setup` or the first start.

### When `npm audit signatures` cannot finish

`narrarium-server@0.1.8` was published with the SLSA provenance and without npm's own *publish attestation* (the registry's signed statement of the publication, which 0.1.6 and 0.1.7 carry next to the provenance). An older npm, such as npm 10.9 that comes with Node 22, refuses a package like that with `EMISSINGSIGNATUREKEY` and `<package>@<version> has attestations but no corresponding public key(s) can be found`, as if a key were missing (it expects a keyed attestation from every attested package); newer ones accept it (npm 11.19 and 12 were checked). That would make the update depend on the npm of each computer, so the server accepts **that failure and no other**, and only when all of these hold:

- the release has no npm publish attestation: the attestation document the server read (before the download, and again after it) holds the SLSA provenance and nothing else. With a publish attestation, npm's "no corresponding public key" is a real failure, and the release is refused;
- the server's own checks passed: the registry signature (step 4) and the provenance (step 3), before the download and again on what was installed;
- npm printed nothing else: its output (both streams) is that error code once and that message once, for this package and this version, and apart from them only `npm warn` and `npm notice` lines, the line that says where its log is, and blank lines. Another error code, the same message about a *registry signature* ("has a registry signature with keyid … but no corresponding public key"), a key that expired, an invalid signature, a registry that cannot be reached, a message for another version, one more line of error: all of them refuse the release, as before;
- the release is a normal one, not the hand-published `0.1.0` (which has no attestation at all).

The release is then installed, and a line is written to the log of whoever ran the install: `[supervisor] Warning: npm audit signatures could not finish for narrarium-server@<version> …` in the output of `npx narrarium-server start`, or the same line in the output of `setup` and `update`. It says that the release was accepted because the server verified the registry signature and the provenance itself. The result that Narrarium and the admin panel show is unchanged (`Update completed.`): the warning is only in that log. A newer npm (the one that comes with Node 24, for instance) removes it.

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
- **Sigstore is verified by npm, not by this server, and where npm cannot, nobody does.** `npm audit signatures` checks the signature, the certificate chain and the transparency log, and that the provenance is about the installed tarball; it does not tell who signed. The server reads the bundle to see who signed (the certificate's name, issuer and ids, and the signed statement's claims) but does not re-verify the signature itself, so it relies on the registry serving the same bundle to npm and to it. For a release that has only the SLSA provenance, on an npm that refuses it ([above](#when-npm-audit-signatures-cannot-finish)), npm stops before it reaches the bundle: nobody then checks its signature, certificate chain or transparency log, and the server accepts the claims it reads, together with the registry's signature of the tarball (which it does verify), as the registry served them over TLS. A release that also carries the npm publish attestation never gets that tolerance.
- **The registry's own signature proves that the registry published that tarball, not who made it.** The key list and the date of a release are read from the registry over TLS, like everything else the server reads from it; the date (the packument's) is not signed, so it only settles whether a key had expired by the time of the release. Who made the tarball is what step 3 is for.
- **GitHub and npm are the roots of trust.** Whoever can push a tag `narrarium-server-v*` to the repository, or change the workflow on such a tag, publishes a release that passes. Protecting that is the maintainer's job: see [Maintainers](#maintainers-releasing).
- **A proxy that only npm is configured for.** The registry is read by npm through `HTTPS_PROXY`; the attestation, and the registry's signature (its document of the release, its list of keys and, rarely, its packument), are read by the server with direct HTTPS requests, so behind a proxy that is the only way out, updates are not offered and `update` fails with a message that says what could not be read.

## Reach the server from other devices (Cloudflare)

Both listeners stay on `127.0.0.1`. To use the server from another computer or from your phone, publish it over HTTPS:

- **Existing tunnel**: route a hostname of your tunnel to `http://127.0.0.1:24242`, then in the admin panel (**Approved network**) set it as the public API address.
- **New tunnel**: in the Cloudflare dashboard create a remotely managed tunnel and route a hostname to `http://127.0.0.1:24242`, install `cloudflared` 2025.4.0 or newer, then paste the connector token in the admin panel (**Cloudflare → Save and start**). The server runs its own connector (`cloudflared tunnel --no-autoupdate run`), never touches other connectors and does not restart a connector that stopped.

The connector token is kept **encrypted by the vault** (`private/cloudflare-tunnel-token.json`), never in clear text, never on a command line and never in a log: `cloudflared` receives it in its environment. A clear-text token file written by an earlier version is moved into the vault the first time the server starts, and deleted. The connector ends with the server: a clean stop (Ctrl+C, SIGTERM, a closed terminal) stops it, so does any exit of the server process, and a connector that outlived a server that was killed outright is recognised at the next start by its program and its start time (not by its process number alone, which may belong to something else by then) and stopped before a new one starts.

To manage the server remotely as well, route a second hostname (or the same one) to `http://127.0.0.1:24243`, set it as the public admin address **and turn on "Serve this panel on its public address"**: a new installation serves the panel on this computer only until you do (an installation that was updated from an earlier version keeps what it had). On that address the panel is served and `/api/v1/*` is passed to the API (and so is `/mcp/*`, the MCP addresses of the books: see [MCP for each book](#mcp-for-each-book)), which still checks the client token. Protect remote administration with Cloudflare Access if you can.

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

The admin code is never accepted on the command line. Rotating it ends every admin session and every remembered device; client tokens keep working. Editing `private/admin-code.txt` by hand and restarting the server also replaces it.

`client-token`, `rotate-admin-code`, `set-admin-code` and `spend` talk to the running server on its admin port, and **never send the admin code to a program that cannot prove it is that server**: before anything secret is sent they ask the listener to sign a fresh random value (`GET /admin/api/identity?nonce=HEX64`) and check the signature with the public key in the data folder (`private/identity.json`). A program that took the port while the server was down, another server with another data folder, and an answer recorded earlier are all refused with an explanation ("The admin code was NOT sent"). A server older than this version has no identity check: the commands refuse it too, so restart it first (or use the admin panel in a browser). The commands sign out of the admin panel when they are done.

## The admin panel

`http://127.0.0.1:24243` (or its public address, when you turned that on), behind the admin code. It is in English and in Italian (the **IT**/**EN** button), runs under a strict Content-Security-Policy (no inline script or style, nothing from outside, everything the server sends is put in as text), follows the light or the dark scheme of the device, and can be used with the keyboard and at 200% text size. A state is always a word (with a glyph), never a colour alone; the lines of risks and health are polite live regions that are written again only when their words change.

**Pages.** The panel is one page at a time, each at an address of its own, so that it can be bookmarked, reloaded, and gone back to and forward from: `/#/overview`, `/#/books`, `/#/updates`, `/#/clients`, `/#/apps`, `/#/ai`, `/#/network`, `/#/log` and `/#/security`. The navigation is a sidebar on a wide window and a **Menu** button on a narrow one; the page that is open is marked (`aria-current`), the first thing to Tab to is **Skip to content**, and a number on a page says what needs you (things to look at in the health, books running, an update available, a client or an AI endpoint waiting for approval, risks to review). Every page has a title of its own (`document.title`) and one heading, which takes the focus when you go there. A table is one card for each row when its own box is narrow, and a long one scrolls inside its box with the header in view.

| Page | What is on it |
|---|---|
| Overview | four tiles (health, books, updates, security), the [health](#health) of the server, the books at a glance and this server's facts |
| Books and runs | the [books in progress](#books-in-progress) |
| Updates | the version, a check and **Update to…**, and the [history of the updates](#the-history-of-the-updates) |
| Clients | pairing a client, the clients (renew or revoke a token) and creating a token by hand |
| Connected apps | for each book its [MCP](#mcp-for-each-book) switch, address and apps, the passkeys, and the latest calls |
| AI and spending | the AI endpoints that wait for approval and the approved ones, and the [spending limits](#spending-limits-and-the-switch) |
| Network | the approved network (AI endpoints, origins, public addresses, remote administration) and the Cloudflare connector |
| Action log | the [action log](#the-action-log) |
| Security | the [risks](#risks-in-the-set-up), the [remembered devices](#remembered-devices) and the admin code |

Every view is read when its page is opened and again every twenty seconds while the window is in view (an answer that has not changed is not drawn again, so the keyboard stays where it is), and none of them holds a secret, a token, a prompt or a text of a book. All of their routes are behind the admin session and the panel's own origin, like the others; none of them is in the API of the clients.

### Remembered devices

The sign-in has a box, **Remember this device forever**, unticked. The panel never keeps the admin code, anywhere. When the box is ticked the server makes a random key for this browser (a **device token**, 256 bits, `nrd_…`), says it once in the answer to that sign-in, and keeps only its SHA-256, a label (the browser and the system, taken from the user agent as a few known words: `Chrome · Windows`, and nothing else of it), the time it was made and the time it was last used, in **`private/admin-devices.json`** (0600, written through a temporary file, at most 1 MiB and twenty devices; past twenty the sign-in works, says that it could not remember, and you revoke one first). The page keeps the key in its `localStorage` under a name of its own address (scheme, host and port), so two servers on one computer do not mix them up. When the half-hour session ends, or the page opens with none, the page signs in by itself with the key (`POST /admin/api/login` with `{ "deviceToken" }`) and goes on; a key that the server says it does not know is deleted by the page and the sign-in is shown, with a sentence.

- **One budget, one answer.** A sign-in with a key goes through the same count of wrong attempts per address as a sign-in with the code (ten per five minutes, a right one clears it, a refused address is refused even with the right key), and a wrong, unknown or malformed key is refused in the very words of a wrong code (`401 admin_login`): nobody can tell which of the two was wrong, and the budget cannot be used to guess a key. A device is not told its own key again, and a sign-in with a key makes no other device.
- **Revoking.** **Security → Remembered devices** lists each device (label, since, last used, and **This device**) with **Revoke**, and **Revoke all devices**, each after a question. Revoking a device also closes the sessions it opened. **Sign out** also forgets and revokes the key of the device that does it (the button says so). **Setting or rotating the admin code revokes every device**, and so does restarting the server after the code file was edited by hand: what was let in with the old code is not let in with the new one. Sessions still last half an hour and are not renewed by use.
- **The log and the risks.** `admin.login` says how it came (`code` or `device`, with the label of the device); `admin.device.remember` and `admin.device.revoke` (one device, `all`, `sign-out`, or `code-changed` with how many) are in the log under *access*, never with a key. While at least one device is remembered, the risks list a note, `device-remember`, with how many; it says more when the panel is on the internet. If the file cannot be read the server still starts: the devices are forgotten, the file is kept as `admin-devices.json.damaged`, and the Security page says so.

Routes (behind the admin session, the CSRF token for changes, and the panel's origin; a client token opens none of them): `GET /admin/api/devices` answers `{ devices: [{ id, label, createdAt, lastUsedAt }], warning? }` (never a key or a hash), `POST /admin/api/devices/revoke` `{ id }` answers `{ revoked }`, `POST /admin/api/devices/revoke-all` answers `{ revoked: <how many> }`, `POST /admin/api/logout` takes `{ deviceId? }`, and `GET /admin/api/session` answers `{ csrf }` for a request that has the cookie of a session: it is how a second tab, or a tab whose token for changes was replaced by another tab's sign-in, gets the token that goes with the cookie it has, without signing in again. `POST /admin/api/login` takes `{ code, remember? }` or `{ deviceToken }` and answers `{ csrf }`, with `{ device: { id, token, label, createdAt } }` only to the sign-in that made the device, and `deviceLimit: true` when `remember` could not be done.

### Risks in the set-up

What you should know about how this server is set up, each with why it matters and a link to where it is changed. A risk is there while its fact is true and goes when it is not; nothing is kept, and nothing is a false alarm.

| Risk | Level | It is there while |
|---|---|---|
| `remote-admin` | high | the panel is served on a public address (`allowRemoteAdmin` with `adminPublicUrl`, or else `publicUrl`): it says which |
| `client-update` | medium | a client token that was not revoked may update the server |
| `oauth-write` | medium | an app connected through OAuth may write or run |
| `spend-unlimited` | medium | an AI is set up, spending is not switched off, no limit is set, and a client or an app may start runs |
| `no-passkey` | medium | a book's MCP is on, the server has a public address and no passkey that works there is registered (without a public address the consent page is only on this computer). With an address that cannot hold a passkey (an IP address) it says to give the server a name first |
| `client-run` | note | a client may start runs (they spend your AI credits) |
| `ai-remote` | note | an approved AI endpoint is not on this computer (`localhost`, `127.0.0.0/8` and `::1` are) |
| `device-remember` | note | at least one device is remembered by the panel (how many; and whether the panel is on the internet, which is what makes a stolen browser matter) |

`GET /admin/api/risks` answers `{ risks: [{ id, level, facts }], counts: { high, medium, note } }`. The facts are names and numbers (client labels, app names, book ids, an address you configured): never a token, a code, a key or a client id. The sentences are the panel's, in both languages.

### Health

One line (`All is well.` or `Needs a look: …`) and a row for each check, with a status (`ok`, `info`, `warn`, `bad`, `off`, `unknown`: only `warn` and `bad` need a look, and a check that cannot be found out is `unknown`, which is not a cause by itself).

| Check | What it says |
|---|---|
| `server` | since when it runs (by its own clock), and whether it is restarting for an update |
| `versions` | the server's and the engine's, and whether an update is available, asked for, unreachable, or **refused** (a newer release that this server does not offer because it failed its checks: a cause). A slow npm does not hold the report up: after four seconds the versions are told as not answered yet |
| `disk` | the free space of the file system of the data folder: a cause under 1 GiB, a problem under 256 MiB |
| `git` | whether it is installed: a cause only when a book is on GitHub |
| `tunnel` | the Cloudflare connector: off when you do not use it, a cause when it was switched on and is not running (with the code of why) |
| `runs` | the places in use of `maxConcurrentRuns`, and the starts that were refused for lack of a place in the last 24 hours (a cause, counted from the action log; a log that was cut counts less, never more). A full server that turned nobody away is only a note |
| `spend` | spending paused, a day's cap reached, a record that was damaged and started from zero |
| `books` | books whose autopilot state cannot be read, that stopped with an error, or that look stalled |
| `error` | the last error that nobody expected since the server started: when, the request id that finds it in the log, whether it was in the API or in the panel, the shape of the request (`POST /api/v1/books/:id/director/ask`, with no query and no book, rule, chapter, client or slug) and the kind of error (`TypeError`). **Never what it said**: that is in the log, under the request id. A cause for a day, a note after |

`GET /admin/api/health` answers `{ at, overall: "ok" | "attention", attention: [ids], checks: [{ id, status, facts }] }`.

### Books in progress

For each hosted book: its state in words, which chapter of how many, the step and since when, what the run spent, what the server spent today, who runs it (this server, another server, or a browser) and since when the book last changed. It is read from the autopilot's own state (`autopilot/state.json` and `autopilot/activity.json`, through the engine's session), **never from the books themselves**: nothing is listed, hashed or asked of git, so a server with many books is not slowed down by an open panel. Readers that ask together share one read.

States, from what needs a look first: `stalled` (a run that says nothing for ten minutes: the engine saves a sign of life every five minutes at least, and treats twenty as a dead run), `retrying` (waiting to try a failed step again: which retry and in how long), `running`, `waiting` (a question needs the author's answer), `error`, `unreadable` (the state file cannot be read: the message that the books list has always shown), `paused`, `idle`, `completed`, `none` (never run). Ten books at first, **Show all** for the rest (up to 200 at a time). Nothing the engine says in words is passed on (the run's message, a question, the title of a step, the text of an error): only closed lists (the step, the kind of error), numbers and times.

`GET /admin/api/runs?limit=&offset=` (limit 10 by default, 200 at most) answers `{ now, maxConcurrentRuns, running, total, counts, spendToday, books, nextOffset }`, `counts` being the totals of all the books by state, not of the page.

### The history of the updates

The last twenty updates, and the releases that the server refused to offer: when, from which version to which, who asked (you, or a client by its name), how it ended, what was verified, and for a refusal which check stopped it and why, in the server's own words. `GET /admin/api/updates/history` answers `{ max, entries }`, newest first. The rows are made from what an update already produces (the request, the result, and the record below); the rules of verification are not changed.

**`update-history.json`** (data folder, 0600, a small file that only this server writes): `{ "version": 1, "offer"?: "<what the last refused release said>", "entries": [...] }`, oldest first, at most twenty. An entry is `{ id, kind: "update" | "offer", state: "requested" | "completed" | "failed" | "limited" | "stopping" | "refused", at, requestedAt?, by?: "admin" | "client", actor?, from?, to?, checks?: [{ check, result, reason?, code? }], refusal?: { check?, kind: "refused" | "unreadable" | "failed", reason?, code? } }`. A release that the server will not offer is one entry of kind `offer`, once for each different refusal. An update that ended `limited` or `stopping` is shown as cancelled: it never ran a check. A file that cannot be read is kept as `update-history.json.damaged`, and the history starts again.

**`private/update-verification.json`** is what the supervisor verified, written **before** `update-result.json` (whose format is unchanged): `{ "schemaVersion": 1, "requestId", "version", "fromVersion", "at", "checks": [{ "check", "result", "reason"?, "code"? }] }`. The checks are `rollback`, `metadata`, `provenance`, `registry-signature`, `install`, `integrity`, `audit-signatures` and `package`, in the order of [the install](#how-an-update-is-verified); the results are `passed`, `tolerated` (npm's audit could not finish and the server's own checks passed: see [above](#when-npm-audit-signatures-cannot-finish)), `refused`, `unreadable` (what it checks against could not be read: nothing was proved) and `failed` (something went wrong that is not a verdict). `reason` is the server's own words for a refusal of a signature, a provenance, a version that is too old or a registry that could not be read (printable ASCII, at most 300 characters); `code` is the code npm gave (`EMISSINGSIGNATUREKEY`) for an audit it refused or could not finish. **Never what npm printed, a path, or what a registry said.** A supervisor older than this version writes no such file: its updates are in the history with how they ended, and the panel says that it did not report what it checked, and does not say that all was well.

### The action log

What you and your clients changed on this server, newest first, with a filter by kind and by what worked or failed, and **Older entries** to go back. The kinds: `access` (signing in, with the code or with a remembered device; a device remembered or revoked; the admin code set or replaced), `clients` (pairing started, requested, tried, approved or rejected; a token issued, renewed or revoked; a client that disconnected itself), `updates` (asked for, ended), `apps` (a book's MCP on, off, at another address or changed; an app approved, denied or revoked; a passkey link, added, renamed or removed), `ai` (an endpoint approved, taken away or dismissed; a configuration sent by a client), `spend` (paused, resumed, limits changed), `network` (the approved network or remote administration changed; the Cloudflare connector started, restarted or removed), `books` (a book added or removed; the autopilot started, paused or reset, or resumed by the server itself after a restart).

**`admin-log.jsonl`** (data folder, 0600): one JSON object per line, `{ seq, at, last?, count?, actor: { kind, id?, label? }, action, object?, label?, detail?, ok, code?, source? }`. `actor.kind` is `admin` (you, at the panel), `client` (a token, by its id and the name you gave it), `device` (one that asked to pair), `anonymous` (somebody who proved nothing: a wrong admin code, a wrong pairing code) or `system` (the server: an update that ended, an autopilot it resumed after a restart). `object` is an id (of a book, a client, a passkey), a version or an address, never a text; `label` is a name as its owner wrote it (a client's, an app's), cleaned of control and direction characters, on one line and cut short, as the MCP audit does; `detail` is a few words from a closed vocabulary or numbers (`read,write`, `maxTokensPerDay 0->1000`); `code` is the short code of why it did not work; `source` is where it came from (an address, or `local`).

- **What is written is picked field by field.** Never a token, an admin or pairing code, a key, a `code_verifier`, a prompt, the answer of a model or a text of a book: a test looks for each of them in the file and in the page.
- **Repeats are one line.** The same failure again within ten minutes of the last (wrong admin codes, wrong pairing codes, a proof that failed on the consent page) is counted in that entry (`count`, and `last` for the time of the last one), and the same action that worked again within a minute (a double click) too.
- **It is bounded like the MCP audit.** When the file passes 512 KiB it is cut back to the newest 1000 entries, or fewer when they do not fit in half of that size. Each entry has a number (`seq`) that goes up and is never reused, so a page can say where it ends.
- **A client that was let in and told no** (a permission it does not have, a limit, a state of the server: 403, 409, 412, 429, 5xx) leaves a line; a request that is wrong in itself does not.

`GET /admin/api/log?limit=&before=&type=&ok=` (limit 20 by default, 200 at most; `type` one of the kinds above, `ok` `true` or `false`) answers `{ entries, nextBefore }`; each entry has its `type` too. An action that this version of the panel does not know (a log written by a newer server) is shown as the server wrote it.

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
mcp.json                 which books have their MCP on, and each one's slug (see MCP for each book)
mcp-audit.jsonl          one line per call of an MCP tool: who, when, which tool, which files, never the text (at most about 512 KiB)
admin-log.jsonl          what you and your clients changed on this server, one line each, never a secret or a text (0600, at most about 512 KiB): see The admin panel
update-history.json      the last twenty updates and refused releases, with what was verified and why one was refused (0600): see The admin panel
books/<id>/repo/         working copy of each book: every autopilot step is a git commit
books/.trash/           removed or replaced working copies, deleted for good after 14 days
private/                 0700
  admin-code.txt         admin code (0600)
  authorization.json     client tokens as SHA-256 hashes, pending pairing
  admin-devices.json     the devices that the admin panel remembers: SHA-256 of each key, label, times (0600): see The admin panel
  master.key             vault key (0600; protected by DPAPI on Windows)
  master.key.bak         a copy of it, made once and never overwritten (see below)
  identity.json          the server's Ed25519 key, its private half encrypted
  ai.json                AI router configuration, encrypted
  spend.json             what the server spent on AI per UTC day and per run (numbers only)
  auto-resume.json       when the server resumed a book's autopilot by itself after a restart, the last 24 hours (see Resume after a restart)
  oauth.json             apps that registered, what you allowed them (access and refresh tokens as SHA-256 only), your passkeys (public keys only): see Connect ChatGPT and Claude
  book-tokens.json       per-book GitHub tokens, encrypted
  cloudflare-tunnel-token.json   the Cloudflare connector token, encrypted
  cloudflare-tunnel.json, cloudflared-process.json, cloudflared-home/   connector settings, and the connector that runs (its process number and start time)
  npm-runtime/           verified versions and the active one
  npm-install.json       the installer's state: the active version
  npm-highest.json       the highest version ever activated: nothing older is installed from npm
  git-home/              the empty home git runs in (never your own ~/.gitconfig)
  npm-home/              the empty home, configuration and cache npm runs with (never your ~/.npmrc)
  update-request.json, update-result.json
  update-verification.json   what the supervisor verified in the last update, written before update-result.json
```

One server per data folder: a kernel lock on Linux (`flock`), a named mutex on Windows, a lock file (`server.lock`) on macOS. The lock file names the process that holds it and when that process started, so a number that was given to another program after a reboot or a crash is not taken for a server; it is created whole, taken over from a dead holder by one server at a time, and its holder checks every few seconds that it is still its own. **A server that loses its lock** (the lock helper was killed, the lock file was deleted or replaced) stops serving at once, pauses its autopilots, closes, and exits with an error, so that a supervisor or service manager starts it again instead of two servers writing in one folder.

**The vault key** is never created again by accident: if `private/master.key` is missing while encrypted files (`identity.json`, `ai.json`, `book-tokens.json`, `cloudflare-tunnel-token.json`) exist, the server refuses to start and says so, because a new key would make them unreadable for good. Copy `private/master.key.bak` over `master.key` (or restore it from your own backup) and start again; to start with no secrets instead, move the encrypted files away first (devices must then pair again, and the AI configuration and GitHub tokens must be sent again).

## Security

- Both listeners bind to `127.0.0.1`; requests with an unexpected `Host` header are refused (DNS-rebinding protection). Private Network Access preflights are answered for allowed origins.
- Browser requests are accepted only from allowed origins. Every API call needs a client token with the right permission.
- The admin panel needs the admin code, an `HttpOnly`, `SameSite=Strict` cookie and a CSRF token; it is served under a strict Content-Security-Policy. It never keeps the admin code: a browser that you ask it to remember holds a random device key that the server stores only as a hash, counts against the same limit as the code, and revokes when you change the code (see [Remembered devices](#remembered-devices)).
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
- Every limit is counted per caller, never for everybody at once, so an anonymous caller cannot lock you out: 10 wrong admin codes per five minutes per address (a correct code clears the count), 10 pairing requests per five minutes per address (and 5 wrong codes per address, 50 in all, inside one pairing), 120 `info` requests a minute per address, 60 failed authentications a minute per address, 16 anonymous requests in flight per address, 6000 authenticated requests a minute per client token, and 10 live connections per client token (50 in all); for the OAuth server, 20 app registrations an hour and 120 requests a minute per address. A request body that goes quiet for 20 seconds is dropped, a whole request must arrive within five minutes, and at most two large uploads are read at once. Refused requests answer 429 with `Retry-After` (or 408, 503).
- The MCP endpoint of a book is closed until you switch it on, answers a book that is off exactly as an address that never existed, takes the token only from the `Authorization` header (never from the address, whose query is not logged), refuses a browser origin you have not approved, reaches only the book's own text files (never anything that starts with a dot: `.github/workflows`, `.vscode`…), never replaces a file that changed since the client read it, and records what each call touched without the text: see [MCP for each book](#mcp-for-each-book).
- Apps (ChatGPT, Claude.ai…) connect to a book through an OAuth server on the API's own port, and the owner allows each one on a page of his server, with a passkey or the admin code: PKCE S256 only, the redirect address matched exactly, tokens opaque and stored as hashes, bound to one book and to the permissions he chose, accepted nowhere but that book's MCP endpoint, revoked when the book's MCP is switched off or its slug changes, with strict CSP, framing refused, a token per consent page, and nothing secret in the log: see [Connect ChatGPT and Claude](#connect-chatgpt-and-claude) for the notes, and what the admin code on the public page means.
- A server error that is not understood answers `500 internal` with a short `requestId` (also in the `x-request-id` header) and the details only in the log.
- What you and your clients change is written to `admin-log.jsonl` (who, when, what, on which id, whether it worked), never with a secret or a text; and the panel says what you should know about how the server is set up (remote administration, clients and apps that may update, write or run, no passkey, AI endpoints away from this computer, spending with no limit) without being asked: see [The admin panel](#the-admin-panel).
- Removing a book, or moving it to another storage, never deletes its working copy: it goes to `books/.trash` for 14 days, and a failed move leaves the old copy untouched.

## How books travel

- **GitHub books**: the server clones the same branch, commits every autopilot step and pushes it (by default: the author can choose to publish only when a chapter is closed, or never: see [Quick controls and publishing](#quick-controls-and-publishing)); before each step it pulls the author's work. Narrarium pulls the server's commits through its usual repository sync. The book's GitHub token is sent to the server only with the author's explicit consent. When the author and the server changed the same files, the author chooses which version to keep: see [Conflicts with GitHub](#conflicts-with-github).
- **Local books**: files are exchanged with a three-way sync (`syncBookStores` in the engine): changes on one side are copied to the other, and files changed on both sides are reported instead of overwritten.

## Quick controls and publishing

The controls behind the web app's quick-command bar: pausing at the end of the chapter (and taking a pause back), the limits of one run, the settings that can change while a run goes on (one of which is where a GitHub book is published, another «Retry later»), and «Retry now». The engine does the work (see *Quick controls* and *Retries* in the [engine's README](../engine/README.md)); the server adds the routes and the push.

A server that has them announces `"autopilot-controls"` in the `features` of `GET /api/v1/info`. An older server does not, and would ignore `limits` and read every pause mode but `now` as `after-step` (a `cancel` would pause), so a client checks the feature before it sends them (`serverSupportsAutopilotControls(info)` in the engine).

All four calls need the `run` permission, answer the snapshot of the autopilot (what `GET /books/:id/autopilot` answers: its `summary` has `pausePending`, `limits`, `publish` and, while the run waits to try a failed step again, `retry`) and, when they refuse, answer `{ "code", "message" }`. Every one also answers 401, 403 `scope` (no `run` permission) and 404 `book_not_found`.

| Call | Body | Answer |
|---|---|---|
| `POST /books/:id/autopilot/pause` | `{ "mode": "now" \| "after-step" \| "after-chapter" \| "cancel" }`. No `mode` is `after-step`, as it always was. | `200`. `after-chapter` finishes the chapter in progress (its closing and its publishing included) and pauses; the stricter of two requests counts. `cancel` takes back a pause that waits and stops nothing; with nothing waiting, and any mode with nothing running, the answer is `200` too and nothing changes, but for a run the server paused when it stopped: the pause makes it the author's, and it is not resumed by itself after a restart (see [Resume after a restart](#resume-after-a-restart)). A pause is not refused while an update is about to start. `400 invalid_request`: a `mode` that is none of the four, or a body that is not a JSON object. |
| `POST /books/:id/autopilot/start` | The body it always had (`brief`, `options`, `force`) and `limits?: { "steps"?: n, "chapters"?: n }`: the run pauses after that many steps saved, or chapters completed. | `200`. `400 invalid_request` when `limits` is present and is not an object: it is checked before anything else, and nothing starts. The numbers go to the engine as they are (a value that is not a whole number above zero is no limit). Limits are for that run only: they are not saved, and the next start has none. The other answers are as before: `409 busy`, `412 ai_not_configured`, `429 too_many_runs`, `429 spend_limit`, `503 maintenance`. |
| `PUT /books/:id/autopilot/options` | `{ "publishEvery"?: "off" \| "chapter" \| "step" \| null, "pauseAfterEachChapter"?: boolean, "frozenEdits"?: "ask" \| "auto" \| "notify", "longRetry"?: { "everyMinutes": n, "cycles": n \| "unlimited" } \| null, "resumeAfterRestart"?: boolean }`: at least one, and nothing else. `null` takes the choice back, so that the server's default (`step`) decides again. `frozenEdits` is what the autopilot does when the author changes a frozen chapter (see [Frozen chapters](#frozen-chapters)), written exactly so (`"ASK"` or `" ask"` is refused). `longRetry` is «Retry later» (see [Retry later and Retry now](#retry-later-and-retry-now)); `null` turns it off. `resumeAfterRestart` is «Resume after a restart» (see [Resume after a restart](#resume-after-a-restart)), `true` or `false` and nothing else. | `200`, also while the autopilot runs: the choice is saved in the book, the step in flight is not repeated, and the run reads the new value at the end of the step or of the chapter. A book with no autopilot state gets one (as `configure` does). `400 invalid_request` for any other key (nothing of the request is applied, not even the part that was right), a value of the wrong type (for `longRetry`, the message says what is wrong with it), or a body that is not an object; `409 conflict` when the state file kept changing under the write (try again); `409 state_corrupt` when it cannot be read; `503 maintenance`. |
| `POST /books/:id/autopilot/retry-now` | None (or `{}`). | `200` the snapshot and `skipped`: `true` when the run was waiting to try a failed step again (a quick retry, or a wait of «Retry later») and the attempt starts now, `false` when nothing was waiting (no run, or a run that is not waiting: nothing changes). It uses up nothing: the retry, or the cycle, stays counted. `400 invalid_request` for any other body; `503 maintenance` while an update is about to start (unlike a pause: «Retry now» sets the run going again). |

`summary.pausePending` (`"after-step"`, `"after-chapter"` or `null`) and `summary.limits` (`{ steps?, chapters?, stepsDone, chaptersDone }` for the run in progress, `null` when it has none or is over) are never saved. They are in the snapshot, in the `state` events of the live stream, and in the `autopilot` summary that `GET /books` and the `book` events carry for every book; `summary.publish` is where the book is published now.

### Retry later and Retry now

A server that has them announces `"autopilot-retry"` in the `features` of `GET /api/v1/info` (`serverSupportsAutopilotRetry(info)` in the engine). The server runs the engine's own: a book's run waits, counts its cycles and stops exactly as in the browser (see *Retries* in the [engine's README](../engine/README.md)), and the live stream carries what it says (`summary.retry.longTerm`, the insights `longRetryWait`, `retrySkipped` and `longRetryExhausted`, the codes `longRetryExhausted` and `longRetryOff` of `run-ended`). The same code is also in the saved state, `lastError.code` (and `summary.lastError.code`), so a page opened after the run, or another device, can say that «Retry later» ended it.

- **The setting.** `PUT /books/:id/autopilot/options` takes `{ "longRetry": { "everyMinutes": 1 to 10080, "cycles": 1 to 1000 or "unlimited" } }`, written exactly so (a fraction, a number in quotes, `"Unlimited"`, a missing field or another one is a `400` that says which), and `{ "longRetry": null }` to turn it off; also while the autopilot runs, and while it waits: turned off, a run that waits for it stops with the failure it waited to try again; new minutes or cycles count from the next cycle. `configure` and `start` hand it to the engine with the other options, as they are, and the engine reads it as it reads every option there (a value that is not a policy changes nothing). The engine's client never sends `longRetry` to a server that does not announce the feature (an older one would refuse it in this route and drop it from `configure` and `start` without a word): it answers `feature_unavailable` itself.
- **Retry now.** `POST /books/:id/autopilot/retry-now` (above), and the MCP tool `autopilot_retry_now`.
- **A run that waits is a run.** It keeps the book (its heartbeat is saved as during a long step) and its place among the runs of the server: it counts against `maxConcurrentRuns` (`429 too_many_runs` for another book), and the server cannot be updated while it waits (`409 running`). Pause it to free its place: the wait ends at once, and nothing of it is lost but the wait (resuming starts the cycles from zero). Letting a sleeping run give its place away would mean taking the place back when the wait ends, with nowhere to go if another run took it; a pause is simpler, and says what happens.
- **When the server stops.** The wait is in memory. A server that stops pauses its runs, while they wait or not (see [Resume after a restart](#resume-after-a-restart)); resuming one (by itself after the restart, when the author asked for it, or with the app's Resume, `POST …/autopilot/start` or the MCP tool `autopilot_resume`) repeats the step at once, with the quick retries and the cycles from zero.

### Resume after a restart

A server that stops cleanly (Ctrl+C, `SIGTERM` from a service manager, a closed terminal, an error that makes it stop) pauses every run at once, as `pause("now")` does: the step in flight is abandoned, the steps already saved stay. Its state then says that the server stopped it: `stoppedBy: "server-shutdown"`, with the message *Paused because the server stopped.* («In pausa perché il server si è fermato.», in the language of the book) and the code `serverShutdown` on `run-ended`. A pause the author had asked for before stays the author's.

When the author turned **Resume after a restart** on for the book («Riprendi da solo dopo un riavvio del server»: `options.resumeAfterRestart`, off unless turned on, in the «Retries» card of the web app's autopilot settings, changeable while a run goes on), the server resumes such a run by itself when it starts again. A server that announces `"autopilot-auto-resume"` in the `features` of `GET /api/v1/info` does it (`serverSupportsAutopilotAutoResume(info)` in the engine); the option goes through `PUT /books/:id/autopilot/options`, `configure` and `start` as `true` or `false`, and the engine's client never sends it to a server without the feature.

- **What is resumed.** A book whose run was paused by the server's stop, and one whose state still says `running` with this server's runner (a process that ended without pausing it: killed, or the machine lost power) or with a runner silent for more than 20 minutes. Never a run the author paused (also with nothing running: a pause of the author takes the server's word away), one that paused by itself (the end of a chapter, a limit, a budget), one that waits for the author, one that ended with an error, nor a book with the option off.
- **How.** After the books are loaded, in the background while the server already answers: one book at a time, five seconds apart, each through what a start of the author goes through (the AI configuration, the number of runs the server may run, `maxConcurrentRuns`, and your spending switch and caps). The run says it first in its feed (the insight `resumedAfterRestart`: *Resumed by itself after the server restarted.*), and the admin log has a line for it (`run.autoResume`, by `The server`, with the book, why it was resumed and the count, such as `server-shutdown 1/3`). The server's log says it too, also without `--verbose`.
- **At most three times a day.** A book is resumed by itself at most three times in 24 hours (a rolling window), so that a run that makes the server stop, again and again, does not loop. The count is in `private/auto-resume.json` (`{ "version": 1, "resumes": [{ "bookId", "at" }] }`, only the last 24 hours) and is written **before** each attempt, so an attempt that ends the process still counts. After the third the run is not started: its state is paused, without the server's word, with a message that says why (*Not resumed after the server restart: the autopilot already resumed by itself 3 times in the last 24 hours. Resume it when you are ready.*), and the admin log says `auto_resume_limit`. Only the author resumes it then. A record that cannot be read is set aside (`auto-resume.json.damaged`): nothing is resumed by itself that time, and the count starts again from zero.
- **A start that is refused** (no AI configuration, as many runs as the server allows, spending paused or a cap of the day reached, any other failure) leaves the run as it is and writes nothing to the book: the server's log and the admin log say why (`ai_not_configured`, `too_many_runs`, `spend_limit`…), and it is not tried again until the next start of the server. A refusal found before the attempt does not use up one of the three.
- **What to keep in mind.** The AI configuration is the one saved on the server (`private/ai.json`): a server that has none when it starts resumes nothing (send it from the app, then Resume). One server per data folder (the lock says so): two servers on copies of the same books would each resume their copy.

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
  - A change made on GitHub to a file that the server also changed (a chapter the author edits in the browser while the autopilot refines it, `plot.md`, a resume…) is a conflict: the next step stops the run with a conflict that says how many files, and the author chooses which version of each to keep, in the app or through the API. See [Conflicts with GitHub](#conflicts-with-github). A change to a file the server did not touch is rebased under its commits, and the run goes on; the autopilot's own files never stop it.
  - Nothing is lost: the rebase is always undone, the server's commits are all still in the working copy, and the working copy is clean.
  - To avoid it, keep `step` for a book that is also edited on GitHub or by another device, or publish with `POST /books/:id/sync` before anybody else edits it. With `step` the same conflict is possible too, but only in the moment between one push and the next.

## Conflicts with GitHub

A GitHub book on the server is a git working copy of the book's branch. The server publishes its work (after every step, every chapter, or never: `publishEvery`) and brings in what was changed elsewhere before every step. When the author and the server changed **the same file** since the two last met (the author edits a chapter in the browser while the autopilot refines it), git cannot put the server's commits on top of GitHub's by itself: that is a **conflict with GitHub**. Before, the run stopped with an error that sent the author to the web app, which had no way to settle it. Now the conflict has a name, a list, and a resolution: the author chooses, file by file or for all of them, **the server's version** or **GitHub's version**, exactly as the app already lets them choose between a device and the server.

- **The stop.** The step stops, nothing is lost (the rebase is undone, the working copy is clean), and the run ends with the error code `github_conflict`: *The book changed on GitHub in a way that conflicts with the server's work (3 files). Resolve it in the app (Where it runs, or the error panel), then resume.* The engine classifies it as a `conflict` with `errorDetail.githubConflicts` (the number of files), `lastSync` says it with `conflicts`, and `POST /books/:id/sync` answers `409 github_conflict` with `conflicts` (before: `409 sync_failed`). It is not retried: the author chooses.
- **The list.** `GET /api/v1/books/:id/github-conflicts?offset=&limit=` (permission `read`) fetches GitHub and compares the two by a merge that writes nothing (git's `merge-tree`; with a git older than 2.38, a merge in the working copy that is always undone, see below), and answers `{ conflicts, total, offset, limit, ahead, behind, branch, head, githubHead, fingerprint, autopilotFiles? }`. Each conflict is `{ path, server, github, serverBytes?, githubBytes?, resolvable, reason? }`: what happened to the file on each side since they parted (`modified`, `added`, `deleted`) and the size of each version, never what it says. The list is in the order of the paths, a page at a time (100 by default, at most 500), so it does not grow with a book of 5000 files. `ahead` and `behind` count the commits of each side that the other does not have. Looking changes nothing; the same conflicts give the same `fingerprint`. A book that parted from GitHub without touching the same files has no conflict (`conflicts: []`): the next sync puts its commits on top of GitHub's, as it always did. A conflict that was settled elsewhere (the author put the file back on GitHub) disappears from the list by itself.
- **The resolution.** `POST /api/v1/books/:id/github-conflicts/resolve` (permission `write`) with `{ "choices"?: { "<path>": "server" | "github" }, "default"?: "server" | "github", "message"?: string, "fingerprint"?: string }`. It makes **one merge commit** of the server's work and GitHub's, whose two parents keep both histories as they are (no rebase, no history rewritten): every file in conflict is the version chosen for it, or the `default`; a file that one side deleted follows the same rule (*keep the server's* keeps it or leaves it deleted as the server has it, *take GitHub's* as GitHub has it). Every other file is merged as git merges it. The commit is built without touching the working copy, **pushed** (when the book is published: with `publishEvery: off` nothing is pushed, as nothing else is), and only then does the working copy move to it. The version that was not chosen is not lost: it stays in the history of the merge, which has both parents. The answer is `{ head, pushed, pushError?, resolved, ignored, unresolvable, counts, autopilotFiles? }`: the new commit, whether GitHub has it, the files resolved with the version kept (the first 100), the choices that were left aside, the files kept as the server has them, and the counts (`{ total, server, github, ignored, unresolvable }`). The run is not started again: the author resumes it as always (the app's Resume, `POST …/autopilot/start`, or the MCP tool `autopilot_resume`), and the step that stopped is done once.
- **The rules of a resolution.** A file in conflict without a choice when there is no `default` is refused, `400 choice_missing` with `paths` (the first 100) and `missing`: nothing is chosen at random, and nothing is written. A choice for a file that does not conflict (any more) is left aside and listed in `ignored`. `fingerprint` is the one of the list the author chose from (without it, the server takes the last list it gave of the book, and refuses if it gave none since it started): when the conflicts are not those any more (GitHub moved again onto those files), the answer is `409 conflicts_changed` with the list as it is now (`conflicts`, `total`, `fingerprint`…), and nothing is written. Nothing to resolve is `409 not_conflicted`; a book that is not on GitHub `409 no_remote`; a run that is active `409 busy` (pause it first: the files of the run must not change under it); an update about to start `503 maintenance`. A large resolution is a `default` and a few exceptions: the body is limited like every small body (2 MiB, and at most 5000 `choices`).
- **A push that GitHub refuses.** When GitHub moved while the resolution was on its way, the server fetches again: if the conflicts are still the ones chosen for, the merge is made again on GitHub as it is now and pushed once more; if GitHub moved onto them, `409 conflicts_changed`, and nothing is written. A push that fails for another reason (the token, the network) leaves the resolution on the server, says why in `pushError` (never with the token), and the next publish or sync pushes it.
- **The autopilot's own files are never asked about.** `autopilot/state.json`, `autopilot/activity.json` and `autopilot/plan.md` belong to the autopilot: they are not in the list, and when both sides changed them they are taken **whole, the three together, from one side** (they are one record: a state, its log, its plan), never mixed line by line. While a run of the server is active, from the server: the run owns them. Otherwise from the side whose `state.json` was saved last (`updatedAt`): the host that ran the autopilot most recently, the browser when the book moved there; a state that cannot be read loses to one that can, and when neither can, or the times are the same, the server keeps its own. The list says which side that would be (`autopilotFiles`), and so does the answer. A conflict only on those files has nothing to resolve: the next step, or a sync, merges the two by itself (a merge commit, without stopping the run). Every other folder (`conversations/`, `resumes/`, the chapters…) follows the general rule: the author chooses.
- **Names the server does not read or write.** A file in conflict whose name is not a safe book path for the server (`..`, `.git` under any spelling, an absolute path, a Windows device name such as `aux.md`, characters such as `?` or `:`, a name that is not UTF-8) is listed with `resolvable: false` and `reason: "unsafe-path"` (its name cleaned of control characters), and a resolution keeps the server's version of it whatever is asked, without failing the rest; so is a file on one side where the other has a folder (`file-directory`: the server's file or folder stays) and a conflict that is not between two plain files (`not-a-file`: a link, a submodule). A GitHub branch that holds a name no working copy can hold (`..`, `.git`: GitHub itself refuses such trees, only a broken or hostile remote has one) is refused with `422 invalid_github_path` before anything is merged or pushed.
- **Nothing a repository holds is run.** Git runs as it always runs on the server: in a private home, with no hook (its hooks folder is an empty one of the server's), no credential helper, no filter, merge or diff driver of any configuration (the repository's `.gitattributes` can name them, nothing defines them), no submodule (`.gitmodules` is not followed, not even to fetch), no link (`core.symlinks=false`), and the token only as a header of the commands that talk to GitHub. What the files say is never read, logged or answered: the only content the server reads is the `updatedAt` of the autopilot's state. The log says that a resolution happened, with its counts, and never a file or what it holds.
- **A server that stops in the middle.** A trial merge of an older git, and a rebase, leave a mark in `.git` while they work. A server that starts again finds the copy as it was: git's lock removed, the merge or the rebase that the mark says was going on undone, and every command works. A merge or a rebase without the mark (started by hand in the copy) is not the server's, and is left as it is. The resolution itself never leaves the working copy half-merged: the commit is built apart, and the copy moves to it in one fast-forward.
- **Unrelated histories.** A GitHub branch that has nothing in common with the server's copy (a history rewritten from the start) cannot be merged: `409 unrelated_histories`. Register the book again from GitHub.

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
| `summary.frozenChanges` | the snapshot, `GET /books`, the `book` events and the `state` events | How many chapters have a change that waits for the author (see [Frozen chapters](#frozen-chapters)). Never saved, and absent when nothing waits. |

**No secret goes through.** An AI key is never in an answer, an event, the log or a file: the engine takes it out of what a provider says (a 401 that repeats the key, a message that names it) before anything is kept, and the server only passes on what the engine kept. The server's tests prove it with a provider that names the key in what it says, and then look for it in every answer, event, log line, file and change of the book.

## Frozen chapters

A chapter is frozen when the autopilot's director approves it, or when the author freezes it by hand: its `chapter.md` keeps a record of its text (see *Frozen chapters* in the [engine's README](../engine/README.md)). When the author changes it afterwards, the autopilot stops before its next step and asks what to do, reviews and updates the book on its own, or only says it, as the setting `frozenEdits` says (`ask`, the default; `auto`; `notify`). The engine does the work; the server adds three routes, the setting among the live options, and the engine's refusals as they are. A server that has them announces `"autopilot-frozen"` in the `features` of `GET /api/v1/info` (`serverSupportsFrozenChapters(info)` in the engine reads it): an older server answers `404 not_found` to the routes, so a client asks before it offers them.

- **The question needs no new route.** The question about a change is `state.question` (kind `frozen-change` or `outline-change`, with `choices`), and the author answers it with `POST /books/:id/autopilot/answer` as any other: `answer` is the `id` of a choice (`review-and-update`, `review-only`, `mark-reviewed`; for the outline `rewrite-to-outline`, `keep-text`, `mark-reviewed`) or its label, as the web app's buttons send it; `accept: true` keeps the author's text; any other text reviews and updates the book (for an outline question, rewrites the chapter to follow the outline) with that text as the author's note for the director. An answer that chooses nothing (empty, without `accept`) is `400 invalid_action`, and the question stays open.
- **Apps connected through MCP** never freeze a chapter or take its freeze away: `write_file` keeps the record a chapter.md holds, exactly (`keepChapterFreeze` of the engine), and drops one the app made up; `update_chapter` keeps every key of the frontmatter it is not told to change. A change they make to a frozen chapter is noticed and decided like the author's.
- **The setting** changes with `PUT /books/:id/autopilot/options` (`{ "frozenEdits": "ask" | "auto" | "notify" }`, also while a run goes on: see [Quick controls and publishing](#quick-controls-and-publishing)), and through `configure` and `start` with the other options, which the server hands to the engine as they are.
- **The count.** `summary.frozenChanges` is how many chapters have a change that waits for the author: in the snapshot, in the summaries of `GET /books` and of the `book` events, and in the `state` events, like the other fields of the summary. It is never saved, and absent when nothing waits (and until a run, or `GET …/autopilot/frozen`, has looked: a server that restarted knows it again at the first of them).

Both POST calls check a request in the same order as their neighbours: `503 maintenance`, `404 book_not_found`, the address, the body; the GET is read also while an update is about to start. Every call also answers 401 and 403 `scope`.

| Call | Permission | Request | Answer |
|---|---|---|---|
| `GET /books/:id/autopilot/frozen` | read | No body; no parameter. | `200` `{ mode, changes, pending, warnings }`: every change, in the order of the book (`kind`, `number`, `slug`, `title`, `fingerprint`, the `actions` that can be done with it now, `by`, `frozenAt` and `changed` for a frozen chapter, `outline` for an outline entry, `pending` when a decision is recorded), the decisions recorded, and the chapters whose freeze record cannot be read. |
| `POST /books/:id/autopilot/frozen/:number` | run | `{ "action": "review-and-update" \| "review-only" \| "mark-reviewed" \| "rewrite-to-outline" \| "keep-text", "kind"?: "frozen" \| "outline", "note"?: string }`, and nothing else. `:number` is the chapter, a whole number from 1 as an address writes one. `kind` tells the change of a chapter that has both (its text and its outline entry); `note` is the author's word for the director, cut at 8000 characters as the note of an answer is. | `200` the status after it (as the GET answers), also while a run goes on: `mark-reviewed` (and `keep-text`, at the next step of a run in progress) is done at once; a review is recorded and done by the next run before it goes on with the plan, or by the run in progress at its next step. It closes the question about the chapter. |
| `POST /books/:id/chapters/:slug/freeze` | write | `{ "frozen": boolean }`, and nothing else. `:slug` is the chapter's folder in `chapters/`. | `200` `{ slug, number, frozen }`: the record the chapter has now (`by: "author"`), or `null` once it is unfrozen. Freezing a changed chapter accepts the change as it is; both drop the decisions that waited for it. Unfreezing a chapter that is not frozen writes nothing. |

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | The number is not a whole number from 1 (`0`, `-1`, `1.5`, `01`, `1e2`, `abc`); the folder has a separator or a control character, or is over 200 characters; the body is not `{ action, kind?, note? }` (`action` missing or not a string, `kind` not `frozen` or `outline`, `note` not a string, another field) or `{ frozen }` (`frozen` not a boolean, another field). A body that is not JSON is `400 invalid_json`, one that is not `application/json` is `415`, and one over 2 MiB is `413`, as for the other calls. |
| 400 | `invalid_action` | The action is not one of the five, does not fit the change (`keep-text` for a frozen chapter's text), or cannot be done now (a review of a chapter the autopilot has no plan for: it can only be marked as reviewed); an answer to the question that chooses nothing. |
| 404 | `chapter_not_found` | No chapter has that number, or no folder that name. |
| 409 | `not_changed` | The chapter has no change to decide about (it was decided, or taken back, elsewhere). |
| 409 | `conflict`, `state_corrupt` | The files kept changing under the write (try again); the state file cannot be read. |
| 422 | `frontmatter_invalid` | The chapter.md cannot be read: the engine never rewrites it from what could be read of it, and the message names the file and the line. |
| 503 | `maintenance` | The server is about to restart for an update. |

A freeze, and a change marked as reviewed, is a commit of the chapter's `chapter.md` in the book's working copy, like the autopilot's own: a GitHub book publishes it with the next push (the next step of a run, or `POST /books/:id/sync`).

## MCP for each book

Every book on the server can have its own **MCP server** (the [Model Context Protocol](https://modelcontextprotocol.io), over Streamable HTTP): an assistant such as Claude Code, Cursor or VS Code can then read the book and edit it with the tools the Narrarium Copilot uses, from wherever it runs. It is **off for every book** until you switch it on, one book at a time.

### Switching a book on

A client with the `write` permission switches it on (the status needs only `read`):

```bash
curl -X PUT http://127.0.0.1:24242/api/v1/books/BOOK_ID/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "enabled": true }'
```

The answer is the status of the book's MCP: `{ bookId, enabled, slug, path, url, public, protocolVersions, updatedAt, connections, oauth }` (`connections` is how many apps are connected through OAuth, `oauth` says where the OAuth server is: `{ issuer, metadataUrl, resourceMetadataUrl, scopes }`), and `message` when `public` is false. `GET` on the same address gives it (the first time a book's MCP is looked at, whichever way, it is given its slug and the slug is kept; nothing else changes). Switching a book **off** closes its address at once, also for the tokens that were issued before: the next request gets a `404`. It also **disconnects every app that was connected through OAuth** (changing the slug or removing the book does the same): they do not come back when you switch the book on again, you allow them again. The state (on or off, and the slug) is kept in `mcp.json` in the data folder; a file that cannot be read leaves every book off.

### The address

`url` is `<public address>/mcp/<slug>`, for example `https://api.example.com/mcp/the-glass-harbor`. The public address is the one you set in the admin panel (**Approved network**), the same host the API answers to from outside; while the server has none, `url` is the local one (`http://127.0.0.1:24242/mcp/…`), `public` is `false` and `message` says that it works only from this computer. (When one public hostname reaches the admin port, as described under [Reach the server from other devices](#reach-the-server-from-other-devices-cloudflare), `/mcp/*` is carried to the API like `/api/v1/*`.)

The **slug** is made from the book's title when its MCP is first looked at: lower case, accents taken off, words joined by hyphens (a title with no letter of ours, such as Cyrillic or Chinese, uses the book's id). It is unique on the server (`-2`, `-3` after a title that is shared), and **stable**: a new title never moves the address. You can change it with `PUT … { "slug": "my-book" }`: `400 invalid_slug` when it is not made of lowercase letters, digits and single hyphens (1 to 80 characters), `409 slug_taken` when another book has it, `404` when the book is not there. A removed book has no address and its slug is free again. An address that does not exist, a book whose MCP is off and a token for another book all answer the same `404`: nothing tells which books there are.

### Connecting a client

Use a client token (pair a device, or create one in the admin panel, **Clients**, with the permissions you want the assistant to have) and send it in the `Authorization: Bearer <token>` header. Only the header is read: a token in the address is not accepted, and the query of an `/mcp/` address never reaches the log. Without a valid token the answer is `401` with `WWW-Authenticate: Bearer`.

```bash
# Claude Code
claude mcp add --transport http glass https://api.example.com/mcp/the-glass-harbor \
  --header "Authorization: Bearer nrs_…"
```

```json
{ "mcpServers": { "glass": { "url": "https://api.example.com/mcp/the-glass-harbor", "headers": { "Authorization": "Bearer nrs_…" } } } }
```

The second shape is the one most clients that take an address and headers use (Cursor, for one; VS Code's `mcp.json` calls the list `servers` and wants `"type": "http"`): see the client's own documentation. **ChatGPT and Claude.ai cannot send a fixed header**: they connect through OAuth, with a consent page where you prove you are the owner (a passkey, or the admin code): see [Connect ChatGPT and Claude](#connect-chatgpt-and-claude).

### Connect ChatGPT and Claude

ChatGPT and Claude.ai (and every client that follows the authorization part of the MCP specification, `2025-06-18`) connect to a book **by themselves**: you paste the address of the book, they find the rest, and **you** say yes on a page of your own server. Nothing is pasted that could be copied or leaked: the app is given a token only after you have allowed it, for that one book and for what you chose.

**What you need.** The server must be reachable from the internet at its **public address**, which must be `https` (see [Reach the server from other devices](#reach-the-server-from-other-devices-cloudflare)), and that address set in the admin panel (**Approved network → Public API address**): the apps' servers call it, not your browser. Without it the server still speaks OAuth on its local address (so a client on this computer, such as MCP Inspector, can connect with the admin code), but ChatGPT and Claude.ai cannot reach it, and passkeys cannot be used.

**1. Paste the address.** Switch the book's MCP on (admin panel → **Connected apps (MCP)**, or `PUT /api/v1/books/:id/mcp`) and copy its address, `https://api.example.com/mcp/the-glass-harbor`.

- **Claude.ai**: add a *custom connector* (in the settings, under Connectors) and paste the address. Leave any client id and secret empty: the server registers the app by itself.
- **ChatGPT**: add your own connector or app (in the settings; this needs *Developer mode*), paste the address and choose OAuth as the authentication. No client id or secret is needed.

The menus of these apps change from time to time: look for "custom connector" in Claude and for "developer mode" and "connectors" in ChatGPT, and see the app's own help.

**2. What you see.** The app opens a page of your server in your browser (in English or Italian, as your browser asks). It says which app asks, the address it goes back to (so you can see that it is the app's own), the book, and the permissions it asks for, each a switch you can lower, never raise:

| Switch | The app can |
|---|---|
| Read the book (always on) | read it: chapters, scenes, canon, files |
| Change the book (off until you turn it on) | create and edit chapters, scenes, canon and files; every change is a git commit you can revert |
| Control the autopilot (off until you turn it on) | pause, resume, add notes and answer its questions |

**Read only is the default**: a permission is on only if you turn it on, even when the app asked for it. Then you prove that it is you, in one of two ways:

- a **passkey**: your fingerprint, face or screen lock, one tap;
- the **admin code** (`npx narrarium-server admin-code` on the computer that runs the server). The first time you have no passkey, so you use the admin code; on the public address the page then offers to **add a passkey on that device** ("Not now" is fine, and you can add one later from the admin panel).

Then **Allow** or **Deny**. The app goes back to its chat, connected to that book, and only that book.

**3. Revoke.** Admin panel → **Connected apps (MCP)** → the book → **Revoke** next to the app (it lists what it may do and when it was last used); or `DELETE /api/v1/books/:id/mcp/clients/:id` with a `write` token (what a client such as the Narrarium web app can use). The app's next call is refused and its refresh token is useless. It also ends by itself when you switch the book's MCP off, change its slug or remove the book, when an app does not refresh for 60 days, and when a refresh token is used twice (see below).

**What the server speaks.** Every address is on the API's own port, under the host the request came to: the public address from outside, `http://127.0.0.1:…` on this computer.

| Address | What it is |
|---|---|
| `/.well-known/oauth-protected-resource/mcp/<slug>` | Protected resource metadata (RFC 9728): the book's exact MCP address as `resource`, the server as its authorization server, the scopes. The same document for every well-formed slug, so nobody learns which books exist. |
| `/.well-known/oauth-authorization-server` (and `/.well-known/openid-configuration`, the same OAuth fields) | Authorization server metadata (RFC 8414): the issuer is the public address. |
| `POST /oauth/register` | Dynamic client registration (RFC 7591). |
| `GET /oauth/authorize` | The consent page. |
| `POST /oauth/token` | The code and refresh grants. Form-encoded, as RFC 6749 says. |
| `POST /oauth/revoke` | Revocation (RFC 7009). |
| `/oauth/authorize/{challenge,approve,deny}`, `/oauth/passkeys/{add,options,register}`, `/oauth/assets/*` | The consent page's own calls and files. |

A `401` from `/mcp/<slug>` carries `WWW-Authenticate: Bearer realm="narrarium", resource_metadata="<address of the metadata>"` (no `scope`: the app asks for everything the server offers and you choose); a `403` for a missing permission names `scope="mcp:read"`.

**Registration.** Public clients only (`token_endpoint_auth_method: none`). One to five redirect addresses, each **https, or http on this computer** (`localhost`, `127.0.0.1`, `[::1]`), written out exactly: no wildcard, fragment or credentials, at most 2048 characters. A name is cleaned of control and direction-changing characters, cut at 80 characters, shown as text, and the address the app goes back to is shown with it (an address with look-alike letters is shown in its real, ASCII form). A body is at most 16 KiB; one source may register 20 apps an hour; at most 500 apps are kept; **an app that nobody used for 30 days and that holds no grant is forgotten** (what counts as use: its consent page opened, a token asked for). An app that is not registered is refused on the consent page with a page, never a redirect.

**Authorization.** The code flow with **PKCE S256, required** (no `plain`), the `redirect_uri` **exactly** as registered, and `state` returned with `iss` (RFC 9207). `scope` is any of `mcp:read`, `mcp:write`, `mcp:run` (`read` is always included; `mcp:write` and `mcp:run` add the tools of those permissions, see [What a client may do](#what-a-client-may-do)); names that apps ask for out of habit (`openid`, `profile`, `email`, `offline_access`) are left out, not refused. A request that is wrong in itself (a parameter twice, no PKCE, an unknown scope, a `resource` that is not a book address of this server) goes back to the app as an OAuth error; one whose app or redirect address cannot be trusted is a page that says so. A code is **single use, valid 60 seconds**, and bound to the app, the redirect address, the PKCE challenge, the book and the permissions you chose.

**Which book (`resource`).** The app should say which book it wants with `resource` (RFC 8707, the address of the book as the metadata gave it). The server checks its form when the page opens (same host, `/mcp/<slug>`, no query or fragment) and checks that a book with MCP on is there **only after you have proved who you are**: so nobody who merely opens the page learns which books are on, and the page shows the address as the app gave it. **An app that names none is not given one**: there is nothing the server could derive it from (an app registers once and says nothing of any book, and offering a list, or a default, would tell a stranger which books have MCP on), so the page asks *you* for the book (its address, or just its slug).

**Tokens.** Opaque random tokens (`nra_…` access, `nrr_…` refresh; 256 bits), **kept only as SHA-256 hashes**. An access token lives **one hour**; a refresh token **60 days from its last use** and is **rotated** at every use. If a refresh token that was already used is shown again, the whole grant is revoked, the new tokens too (it was copied, or the app lost track: either way it is safer to ask you again). A token is **bound to one book and to the permissions you chose** (a refresh may ask for less, never for more), is accepted at that book's MCP endpoint and **nowhere else** (not the REST API, not the admin panel), and asking for it again with another `resource` is refused (`invalid_target`). A code that is used twice revokes what its first use gave. Answers of the token endpoint are JSON, `Cache-Control: no-store`, in the words of RFC 6749, and never repeat a secret.

**Passkeys.** A passkey is WebAuthn: `userVerification: required`, attestation `none`, ES256, EdDSA or RS256 (2048 bits or more), checked with `node:crypto` alone: the challenge (32 random bytes, used once whatever happened to the answer, valid two minutes), the origin, the relying party, user presence and verification, the signature, and the **sign counter** (it must go up unless the authenticator has none: a counter that stands still or goes back says the key was copied). A passkey is made on the public address: the admin code on the consent page offers it, or the admin panel gives a **link** (`/oauth/passkeys/add#<ticket>`, valid ten minutes, works once, the ticket after the `#` so that it never reaches a log or a `Referer`) to open on the device that will keep it. You can rename and remove passkeys in the admin panel; **the last one is removed only when you confirm** that the admin code is then the only way to approve an app. At most 20 are kept.

**The relying party is the host, so a server reached only on an IP address uses the admin code.** A passkey is tied to a host name (its *relying party ID*), and the browser uses it only on a page served from that very host, over https; the host cannot be an IP address. So the server offers passkeys only on its **public address** (an https name). On `http://127.0.0.1:…`, or an address that is an IP, the consent page works with the admin code and says so. A passkey made for another address (you changed the public address) is listed in the panel as "for another address" and cannot be used; add one again.

**The admin code is accepted on the public page.** It is the only proof possible before the first passkey exists, and the fallback after. It has **the same attempt limits and lockout as the admin panel's sign-in, and the same count** (10 wrong codes per five minutes per address; a source over the limit is refused even with the right code), but unlike the panel it can be tried from the internet: it is 256 random bits by default, so guessing is out of reach; **never replace it with something short** (the server accepts 32 to 200 characters for that reason), and keep the pages of the admin panel and the consent page on the host that you meant. There is no switch yet to refuse the admin code on the public address once you have passkeys (see below).

**In the admin panel.** The page **Connected apps** lists every book with its switch, address and slug (switching off or changing the slug asks first when apps are connected: they are disconnected), the apps connected to each book with what they may do, where they go back to and when they were last used (**Revoke**), the passkeys (**Add a passkey** shows the link to open on the device; rename; remove; the last one asks for confirmation), and the latest calls. Its routes, all behind the admin session (a change also needs the session's CSRF token): `GET /admin/api/mcp`, `POST /admin/api/mcp/book` `{ bookId, enabled?, slug? }`, `POST /admin/api/mcp/revoke` `{ id }`, `POST /admin/api/passkeys/link`, `…/rename` `{ id, label }`, `…/remove` `{ id, confirmLast? }`, and `GET /admin/api/mcp/audit`.

**Security notes.**

- **Open redirect: impossible.** The address an app goes back to must be one that it registered, matched character for character (no prefix, no case change, no other port, no added query), and the answer is built from the registered address, never from what a request says. A request whose app or address is not recognised is a page, not a redirect.
- **CSRF on the consent form.** Every decision (`challenge`, `approve`, `deny`) needs the token of the page it came from (a random token made with the page, in the page's own data and in the `X-CSRF-Token` header), JSON (a form of another site can send neither the header nor JSON), and an `Origin` that is the server's own address (or none: a command line). The token is per page, so the token of one page opens no other.
- **Clickjacking.** Every page and answer of the OAuth server carries `Content-Security-Policy: … frame-ancestors 'none'` and `X-Frame-Options: DENY`; the policy is the admin panel's: no inline script or style, scripts and styles from the server only, nothing from elsewhere. An app's name and address are escaped; the script sets them as text.
- **Codes and tokens are never logged.** The server logs no body, and the query of every `/oauth/` and `/.well-known/` address (which holds the state, the PKCE challenge and the app's address) is replaced by `?***`, as the query of `/mcp/` addresses is. The consent page sends no `Referer` (`Referrer-Policy: no-referrer`).
- **Rate limits.** Wrong admin codes (shared with the panel's sign-in), 20 registrations an hour and 120 requests a minute to the OAuth addresses, each per source; at most 500 consent requests wait at once (the oldest goes first), and a request that nobody answers is gone after ten minutes. A source over its limit gets `429` with `Retry-After`.
- **Cookies: none.** The consent page keeps what it needs in the page and in the server's memory (a request lives ten minutes, a challenge two, a ticket ten; none survives a restart). A cookie, if one is ever added, must be `Secure; HttpOnly; SameSite=Lax`.
- **Where it is asked.** The `Host` check of the API applies: the server answers only to its local addresses and to the host of the public address, so a name that points to it by DNS rebinding is refused. A browser page of another site can call the OAuth addresses only if you approved its origin (**Approved network → Extra client origins**); ChatGPT and Claude.ai call from their own servers and need none.
- **Browser-based clients.** An MCP client that is itself a web page (not the apps above) calls these addresses from a browser origin: approve that origin first.

**What is not here.** No client secrets, no implicit or password flows, no `plain` PKCE, no dynamic client updates or deletion, no switch to turn the admin code off on the public address once passkeys exist, no per-app permission changes after the fact (revoke and allow again), and no OpenID Connect (`/.well-known/openid-configuration` answers the OAuth fields only). A client that registers an address with a loopback port must use that very port: ports are not matched loosely.

### What a client may do

| Permission | The client sees |
|---|---|
| `read` (needed to reach the endpoint at all) | the tools that read the book |
| `write` | also the tools that change it |
| `run` | also the tools that steer the autopilot |

A token with only `write`, `run` or `update` is refused with `403`: reading comes first. A tool of a permission the client does not have is not listed, and calling it is an error of the tool (`[scope]`), so nothing is written.

| Tool | Permission | What it does |
|---|---|---|
| `book_info` | read | Title, language, counts, default ghostwriter, the autopilot in a few words, what this client may do. |
| `list_chapters` | read | The chapters in order, paged. |
| `read_chapter` | read | A chapter's frontmatter and scenes; with `includeText` its prose, in pages of characters. |
| `read_paragraph` | read | One scene: frontmatter, hash, text in pages. |
| `search_book` | read | Words or a "phrase" in the scenes, chapters and canon, ranked, with an excerpt (secrets only with `includeSecrets`). |
| `list_canon` | read | Characters, locations, factions, items, secrets and events (a secret by its name and the chapters it opens at, never by what it says). |
| `read_canon_entry` | read | One entry by slug, name or alias. |
| `list_files`, `read_file` | read | The book's own text files (see below), with hashes; a file in pages. |
| `autopilot_status` | read | What the autopilot is doing, its question and its id, its pause, the failed step it waits to try again (`retry`), its rules, «Retry later» (`longRetry`) and its last error. |
| `read_outline`, `read_outline_entry` | read | The outline (the Scaletta): its description and the entries in pages (who wrote each, whether it is written or frozen), and one entry whole with its hash. See [The outline](#the-outline-scaletta). |
| `create_chapter`, `update_chapter` | write | Add a chapter; change its title, summary, point of view, ghostwriter or text. |
| `create_paragraph`, `update_paragraph` | write | Add a scene; replace one passage (which must be in the scene exactly once) or the whole text, or change its frontmatter. |
| `create_canon_entry`, `update_canon_entry` | write | Add or change an entry of any kind, with the fields of that kind. |
| `edit_outline` | write | A series of edits of the outline (append, insert, move, remove, update, the description of the book), made in order as one commit, as the author's. |
| `write_file` | write | Any other text file of the book (notes, plot, guidelines…), **not the outline**: `outline/` is refused, and `edit_outline` is its tool. |
| `autopilot_pause` | run | Pause after the step, after the chapter, now; or take a waiting pause back. |
| `autopilot_retry_now` | run | End the wait before the next attempt of a failed step, so that it starts at once (as the app's Retry now); `skipped` says whether it was waiting. |
| `autopilot_resume` | run | Resume an autopilot that was set up in the app (never starts a book from nothing); the owner's switch, caps and limit of runs apply. |
| `autopilot_note`, `autopilot_answer` | run | Steer it (a note, a permanent rule) and answer its question, also while it runs. |

Every tool has a complete JSON schema, a description for a model and the MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false`). The book is the address: no tool takes a book or a folder.

**How a change is made.** Every call that changes the book is **one commit** through the same path as `POST /books/:id/files/commit` (compare-and-swap with hashes, one writer at a time, a git commit, and a GitHub book is pulled and pushed at once while no run publishes it), with the message `MCP (<client name>): <what>` (for example `MCP (Claude Code): update scene 001-arrival/001-the-quay`); the name is the one you gave the token. A whole text is replaced only with `expectedHash`, the hash the read tool gave: if the file changed since (in the app, by the autopilot, by another client) the tool answers `[conflict] The file changed since you read it … read it again and retry` and **nothing is written**. (`edit_outline` makes a whole series of edits one commit, with the same rule for each text it replaces: see [The outline](#the-outline-scaletta).) Replacing a passage works on the text as it is now and must find it exactly once (`[not_found]`, `[ambiguous]`); a file whose frontmatter cannot be read is never rewritten (`[frontmatter_invalid]`). Writing works while the autopilot runs. A call that changes nothing makes no commit. To undo a change, revert its commit.

**Which files.** `read_file` and `write_file` reach an allowed list of the book's own text files (`.md`, `.markdown`, `.txt`, `.json`, `.yaml`, `.yml`): `book.md`, `context.md`, `notes.md`, `plot.md`, `ideas.md`, `promoted.md`, `story-design.md`, `director.md`, `evaluation-guidelines.md`, and the folders `guidelines`, `ghostwriters`, `characters`, `items`, `locations`, `factions`, `timelines`, `secrets`, `chapters`, `audit`, `drafts`, `scripts`, `resumes`, `state`, `evaluations`, `operations`, `personas`, `research`, `deepresearches`, `assets`, `outline` (the Scaletta) and, to read only, `autopilot` and `conversations`. `outline` is read as files (`read_file`, `list_files`) but **written only by `edit_outline`**: `write_file` answers `[forbidden]` and says so, whether the file exists or not, and `list_files` shows its files as not writable (the same as the autopilot's and the conversations'). **Nothing that starts with a dot is reachable** (`.git`, `.github/workflows`, `.vscode`, `.opencode`, `.claude`, `.gitignore`: what a book's tools and CI run), and neither is anything outside that list; `autopilot/state.json` and `autopilot/activity.json` change only through the autopilot tools.

**Limits.** A request is at most 1 MiB and one text of a call (`body`, `content`) 400,000 characters; a text is read in pages of at most 60,000 characters; an answer of more than 512 KiB is not sent; a call that takes more than 60 seconds ends with `[timeout]` (the change may still be applied: read before trying again). Each client may make 300 tool calls a minute, and 60 of them may change the book or steer the autopilot; over the limit the answer is `429` with `Retry-After` and the request does nothing (the 6000 requests a minute of every client apply as everywhere). A batch holds at most 16 messages. The outline has limits of its own (see [The outline](#the-outline-scaletta)): 50 edits and 1,000 files a call, 2,000 entries read for the words of a query.

**What is recorded.** Every call of a tool is one line of `mcp-audit.jsonl` in the data folder: when, which book, which client (its name and id), which tool, whether it worked (and the short code of what failed) and which files it looked at or changed, with the commit it made. **Never the text** of anything, and never an error's message. The file is cut back to its last 1000 lines when it grows past 512 KiB. Each entry has a number (`seq`) that goes up with every call; the admin panel shows the latest calls, twenty at a time, newest first (`GET /admin/api/mcp/audit?limit=&before=&book=`, behind the admin session; `nextBefore` says where the next page begins). An app that connected through OAuth appears under its name, with an id that starts with `oauth:`.

**Protocol.** MCP `2025-06-18` and `2025-03-26` (a client is answered with the highest version both know; a request without `MCP-Protocol-Version` is read as `2025-03-26`, and a batch is understood only by that version, as the specification says). Every `POST` is answered with `application/json` (a notification with `202`). There are **no sessions**: every request stands alone, which is all that a server of tools needs, survives a restart and a tunnel that reconnects, and makes a book that is switched off or a token that is revoked felt by the very next request. So there is no event stream either: `GET` and `DELETE` are `405`. Errors are JSON-RPC errors (`-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, also for an unknown tool or arguments that do not fit the tool's schema); a tool that fails is a result with `isError` whose text starts with `[code]`.

**Risks.** The assistant reads **text of the book**, and text can say anything: a model that reads it can be talked into using the tools (this is called prompt injection). The tools tell it that what it reads is data, but that is no guarantee. So: give a client the **fewest permissions** it needs (`read` alone cannot change anything; give `run` only to an assistant that must steer the autopilot, which spends your AI credits within the caps you set); keep one token per assistant, so that you can revoke it alone; switch the MCP off for a book you do not work on with an assistant; and remember that every change is a commit you can revert. A `read` client can read your **secrets** when it asks for them by name (`read_canon_entry`, `read_file`, or `search_book` with `includeSecrets`); the tools mark them and tell the model not to reveal them early. The token is a password: keep it in the client's header, never in an address.

**For maintainers.** The tools are in `src/mcp-read.ts`, `src/mcp-write.ts`, `src/mcp-outline.ts` (the outline's three) and `src/mcp-autopilot.ts`, listed in `src/mcp-tools.ts`; the public /mcp page of the site lists them from `mcp-tools.json` (next to `package.json`, kept out of the npm package), which `npm run docs:tools -w narrarium-server` writes from that list and `test/mcp-tools-docs.test.mjs` keeps true against what the endpoint really lists, so after adding, renaming or changing a tool run the command, and give a new tool its short line in English and in Italian in the site's `src/narrarium-site/src/i18n/locales/mcpBookTools.en.ts` and `mcpBookTools.it.ts` (a test of the site fails until it has them); `src/mcp-outline-edit.ts` is the tool's layer over the engine's `composeOutlineEdits` (the series of edits as one commit: the identity of each entry followed through the renumbering, the hashes, the files read only when they are rewritten, the limits): the flat edits of a model, the rule that a text, an entry or a description is replaced only by someone who read it, the words of every refusal and the line of each edit, while `changeOfWritten` of the engine says what the autopilot does about a change; which files the file tools reach, and that `outline/` is theirs to read and not to write, is `src/mcp-policy.ts`; the protocol is `src/mcp.ts`. Who may call an endpoint is decided by a list of authenticators (`src/mcp-access.ts`) that turn a token into a principal (a name, the permissions, the one book it is for, whether it still holds): the client tokens, and next to them the OAuth access tokens, each bound to one book. The OAuth server is `src/oauth.ts` (protocol), `src/oauth-store.ts` (what is kept in `private/oauth.json`), `src/webauthn.ts` (CBOR, COSE and the checks of a passkey, with `node:crypto`) and `src/oauth-pages.ts` (the consent page, its script and style, English and Italian); the admin panel's section is in `src/ui.ts`. There is no dependency on the official MCP SDK in the server (it would add about 900 KB and eleven packages to the bundle); the tests use it, as a client, to check that the endpoint works with the real thing.

### The outline (Scaletta)

The outline is the author's chapter-by-chapter plan of the book (`outline/book.md`, the rough description, and `outline/chapters/<NNN>.md`, one entry per chapter: a hypothetical title, what happens in it and, when it is not the book's, its ghostwriter). The autopilot follows it as binding, and writes into it what it plans. Its files are the engine's (see *Outline (Scaletta)* in the [engine's README](../engine/README.md)), so the tools do not write them as text: they ask the engine to make each edit, as the Narrarium Copilot does. That is why `write_file` does not write `outline/`: a file written by hand could break the numbering, or declare itself the autopilot's (`origin: autopilot`), and the autopilot would then rewrite what the author asked for.

**Reading** (`read` permission). An outline has no maximum number of chapters, so the tools never read more than they show: the list of the book's files already says every entry's path and hash, and a call reads the files of the entries on its page and no others (5,000 chapters are read 50 at a time).

- `read_outline { offset?, limit?, from?, to?, query? }`: the first page has the description of the book (`outline/book.md`: working title, text up to 20,000 characters as a block of its own, who wrote it, its hash) and the engine's warnings about the outline as a whole (a chapter without an entry, a second file for one chapter, a file that is not an entry); every page lists entries in order of chapter number, 50 at a time (at most 200): `number`, `title`, `ghostwriter` (when it is not the book's), `origin` (`author` or `autopilot`), `intact` (written by the autopilot and untouched since: it binds nothing and the autopilot may rewrite it) and `binds` (the opposite), `textLength`, `written` (the chapter has scenes), `frozen`, `path`, `unreadable` (the frontmatter is not valid YAML: its title and ghostwriter are guesses and are left out, its text is all there), and the warnings of the entries on the page (including a ghostwriter the book does not have). `from` and `to` list a range of numbers, found in the list of files without reading any. `query` keeps the entries whose number it is (a query of digits), or whose title or text has all its words (a `"phrase"` is matched as it is; case and accents do not matter): that does read, so it looks in at most **2,000 entries** a call and says `scanned`, `complete` and `nextFrom` (go on with `from: nextFrom`, or narrow the range). A book without an outline answers an empty list that says how it begins.
- `read_outline_entry { number }`: one entry whole: title, ghostwriter, `origin`, `intact`, the **hash of its file** (what `edit_outline` needs as `expectedHash`), its text in pages of characters (a block of its own), the state of its chapter (`written`, `frozen`, the folder's `slug`) and, when the chapter is written, `afterChange`: what the autopilot does if this entry changes, which is the engine's rule (`changeOfWritten`, see *Composing edits* in the [engine's README](../engine/README.md)): it asks the author, rewrites the chapter or only reports it as its `frozenEdits` setting says (a chapter the author wrote is never rewritten for its decision, so under `auto` it is only reported); says the change once and decides when a chapter that is being written is closed; or does nothing when no plan follows the entry. `[not_found]` for a chapter that has no entry.

**Writing** (`write` permission): `edit_outline { edits: [...] }`, **at most 50 edits** made in order as **one commit** (`MCP (<client>): edit outline: …`), each on the outline the one before left, so a `number` is the number the chapter has at that point of the series. The edits are the engine's:

| `kind` | Takes | What it does |
|---|---|---|
| `append` | `title?`, `body?`, `ghostwriter?` | A new chapter after the last one. |
| `insert` | `at`, `title?`, `body?`, `ghostwriter?` | A new chapter at `at`; the chapters from there on move one number up. |
| `move` | `from`, `to` | The entry goes to `to`; the ones in between follow. |
| `remove` | `number`, `renumber?`, `expectedHash` | Deletes the entry and leaves its number empty, or with `renumber: true` the following chapters move one number down. |
| `update` | `number`, `title?`, `body?`, `ghostwriter?`, `expectedHash?` | Changes what is given; `ghostwriter: null` takes the ghostwriter away; makes the entry when the chapter has none. |
| `book` | `title?`, `body?`, `expectedHash?` | The working title and the description of the book. |

Every entry it writes or moves is **the author's** (`origin: author`, no `digest`): the autopilot follows it and never rewrites it, even an entry of its own that an edit only renumbers. The keys of a file that the format does not manage are kept.

**Never over what changed meanwhile.** To replace the text of an entry that exists (`update` with `body`), to remove one, or to replace the description of the book (`book` with `body`), the call passes `expectedHash`, the hash that `read_outline_entry` gave for the entry (`read_outline` for the description): without it the call is `[expected_hash_required]`, and with a hash that is not the file's it is `[conflict]` and nothing is written (the same as `update_chapter` and `update_paragraph`). A title or a ghostwriter changes no text and needs no hash; one that is given is checked. In a series the hash is **the hash of the entry as it was read, wherever the edits before have put it** (after an `insert` at 1, the entry that was chapter 1 is chapter 2 and its hash is still the one that was read); an entry that an earlier edit of the same call made has no hash, and none can be given. The files are also written with the hashes the call read, so a change that lands between the reading and the commit is a `[conflict]` too.

**What it answers.** `{ edited, applied, created, updated, removed, moved, book?, entries, files, warnings, notes?, commit }`: `applied` has a line for each edit; `created` and `updated` are the numbers (after the series) of the entries it made and changed, `removed` the numbers (before it) of the entries it deleted, `moved` the entries that changed number as runs (`{ from, to, count }`: `count` entries from chapter `from` are now from chapter `to`); `entries` gives each entry it made or changed with its **new hash**, `book` the description's; `files` is how many files the commit changed. What the outline says is a **warning, never an error**: a ghostwriter that does not exist (`ghostwriter-missing`) or is not a file name (`ghostwriter-invalid`), a text past 20,000 characters or a title past 200 (cut: `text-too-long`, `title-too-long`), an entry whose frontmatter could not be read and was written anew (`unreadable`), and chapters left without an entry (`gap`, told when the call made or changed the gap; `read_outline` always says it). `notes` says what the autopilot does about the chapters that are already written and whose entry changed or was deleted (the same rule as `afterChange`, one sentence for the chapters that share an outcome): an entry that an edit deletes is not a change to decide about, the chapter stays in the book and the autopilot only says it, and deleting every entry takes no chapter out of the plan. A series with an edit that cannot be made (`[not_found]` for a chapter that has no entry to move or remove, `[invalid_input]` naming `edits[n]`) leaves **nothing** behind: no commit, no file. A series that changes nothing makes no commit (`edited: false`).

**Limits.** A series that would change more than **1,000 files** (an `insert` at the head of a long outline renames every entry) is refused whole with `[too_many_files]`: the author does it in the app, where it can be undone. The files are counted as the series goes, a file changed and changed back is not one, and a series that has changed more than 1,000 at any moment of it is refused there (the answer says how many it had by then), so that a long series on a long outline does not work for minutes to be refused at the end. An entry is read only when an edit is about to rewrite it (an `update` reads one file, an `append` or a removal none), so the outline can have any length. Like every tool that changes the book it counts against the 60 calls a minute, it is refused while the server waits to restart for an update, and it works while the autopilot runs.

## API

All endpoints live under `/api/v1` and return JSON; errors are `{ "code", "message" }`. The exceptions are the MCP endpoint of a book, `/mcp/<slug>`, described [above](#mcp-for-each-book), and the OAuth server (`/oauth/*` and `/.well-known/*`), described under [Connect ChatGPT and Claude](#connect-chatgpt-and-claude): its token, registration and revocation endpoints answer in the words of RFC 6749 (`{ "error", "error_description" }`).

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/info?nonce=HEX64` | none | Identity, version and `features` (among them `mcp`, `mcp-oauth`, `autopilot-controls`, `autopilot-rules`, `autopilot-frozen`, `autopilot-retry`, `autopilot-auto-resume` and, with git, `github` and `github-conflicts`: see [MCP for each book](#mcp-for-each-book), [Quick controls and publishing](#quick-controls-and-publishing), [Permanent rules](#permanent-rules), [Frozen chapters](#frozen-chapters), [Retry later and Retry now](#retry-later-and-retry-now), [Resume after a restart](#resume-after-a-restart) and [Conflicts with GitHub](#conflicts-with-github)), signed over the nonce. |
| `POST` | `/pairings`, `/pairings/:id/result` | none | Pair with a code (answers `{ id, verification }`); collect the token once approved (answers `{ token, verification }`). `verification` is optional: four digits that the owner sees in the panel too (below). |
| `GET`/`DELETE` | `/session` | any | The calling client and its permissions / revoke the token it presented, and no other (disconnect; answers `{ revoked }`). |
| `GET`/`PUT` | `/ai` | read / write | Redacted AI status / replace the configuration. The status never has a key: it lists the integrations (`hasApiKey`, and their streaming mode, idle timeout and thinking level when they set one), `routedTasks`, `taskRouting` (the route of every routed task, with the thinking level of each of its targets: `{}` when no task has a route) and `toolsOnly` (whether "Tools only" is in force: true unless the configuration turned it off), the endpoints awaiting approval and the spending status. |
| `GET` | `/books` | read | Hosted books with their autopilot summary. |
| `PUT`/`DELETE` | `/books/:id` | write | Register (local or GitHub) / remove a book. |
| `GET`/`PUT` | `/books/:id/mcp` | read / write | The status of the book's MCP endpoint (`enabled`, `slug`, `path`, `url`, `public`) / switch it on or off and/or choose its slug: `{ enabled?: boolean, slug?: string }` (`400 invalid_slug`, `409 slug_taken`: see [MCP for each book](#mcp-for-each-book)). |
| `POST` | `/mcp/:slug` (not under `/api/v1`) | read, write, run | The book's MCP endpoint (JSON-RPC over Streamable HTTP), with a client token: the tools a client sees depend on its permissions. |
| `GET`/`DELETE` | `/books/:id/mcp/clients`, `/books/:id/mcp/clients/:id` | write | The apps connected to the book through OAuth (`{ clients: [{ id, clientId, name, redirectHost, scopes, createdAt, lastUsedAt }] }`, `scopes` among `read`, `write`, `run`) / disconnect one (`{ revoked: true }`, `404 client_missing`). `id` is the connection's, not the app's. Announced by the feature `mcp-oauth`. |
| `GET` | `/books/:id/manifest` | read | Paths and hashes of the book's text files. |
| `POST` | `/books/:id/files/read`, `/books/:id/files/commit` | read / write | Read up to 100 files (16 MiB in all) / commit up to 5000 changes with compare-and-swap. |
| `POST` | `/books/:id/sync` | write | Pull and push the GitHub branch (`409 github_conflict` with `conflicts` when the book conflicts with GitHub, `409 sync_failed` for any other failure). |
| `GET` | `/books/:id/github-conflicts?offset=&limit=` | read | The files that changed both on the server and on GitHub, a page at a time, after a fetch and a merge that writes nothing (see [Conflicts with GitHub](#conflicts-with-github)). Announced by the feature `github-conflicts`. |
| `POST` | `/books/:id/github-conflicts/resolve` | write | Keep the server's version or GitHub's of each of them: one merge commit, pushed. |
| `GET` | `/books/:id/autopilot`, `/books/:id/autopilot/events?since=N` | read | Snapshot / recent live events. |
| `POST` | `/books/:id/autopilot/{start,pause,retry-now,intervene,answer}` | run | Control the autopilot (`answer` takes `{ questionId, answer, accept?, asRule? }`: with `asRule` the answer becomes a permanent rule; `start` takes `limits`, `pause` takes `after-chapter` and `cancel`, `retry-now` ends the wait before the next attempt of a failed step and answers `skipped`: see [Quick controls and publishing](#quick-controls-and-publishing)). |
| `PUT` | `/books/:id/autopilot/options` | run | Change `publishEvery` (where a GitHub book is pushed), `pauseAfterEachChapter`, `frozenEdits`, `longRetry` («Retry later») and `resumeAfterRestart` («Resume after a restart»), also while the autopilot runs. |
| `PUT`/`DELETE` | `/books/:id/autopilot/rules/:index` | run | Edit / remove one permanent rule of the autopilot, also while it runs (see [Permanent rules](#permanent-rules)). |
| `GET` | `/books/:id/autopilot/frozen` | read | The changes of the frozen chapters, and what can be done with each (see [Frozen chapters](#frozen-chapters)). |
| `POST` | `/books/:id/autopilot/frozen/:number` | run | Decide about the change of a chapter, also while the autopilot runs. |
| `POST` | `/books/:id/chapters/:slug/freeze` | write | Freeze a chapter by hand (`{ "frozen": true }`), or unfreeze it. |
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
| 400, 404, 409 | `invalid_action`, `chapter_not_found`, `not_changed` | A decision about a frozen chapter that cannot be taken: the action does not fit (or an answer to its question chooses nothing), the chapter is not there, nothing waits to be decided (see [Frozen chapters](#frozen-chapters)). |
| 409 | `question_closed` | The director's question was answered already. |
| 409 | `github_conflict` | The book changed on GitHub in a way that conflicts with the server's work (`conflicts`: how many files): a sync, and the run's own error. See [Conflicts with GitHub](#conflicts-with-github). |
| 400, 409, 422 | `choice_missing`, `conflicts_changed`, `not_conflicted`, `no_remote`, `unrelated_histories`, `invalid_github_path` | A resolution of the conflicts with GitHub that cannot be made: a file without a choice (`paths`, `missing`), conflicts that changed meanwhile (the list as it is now), nothing to resolve, a book not on GitHub, histories with nothing in common, a name no working copy can hold. Nothing is written. |
| 502 | `git_failed` | Git failed while it listed or resolved the conflicts (GitHub cannot be reached, for example): what it said, without the token. |
| 412 | `ai_not_approved` | The call would send an API key to an endpoint the owner has not approved. |
| 422 | `frontmatter_invalid` | The engine refused to rewrite a file whose frontmatter cannot be read; the message names the file and the line. |
| 429 | `spend_limit` | The owner's switch is off, or a day's limit is reached (starting a run, asking the director). |
| 502 | `ai_provider` | The AI provider failed, or the engine refused to call it (a prompt over every model's context window, a routing budget, a fallback the privacy settings keep out): the engine's message, as it is. |

**Verification codes.** `verification` is `String(sha256("narrarium-pairing-verification\n" + kind + "\n" + hashHex).readUInt32BE(0) % 10000).padStart(4, "0")`, where `hashHex` is the lowercase hexadecimal SHA-256 of a secret: for the pairing request (`kind` is `request`, shown in the panel while the request waits) the client's nonce, for the issued token (`kind` is `client`, shown next to the client in the panel) the token. A device can compute the same four digits from what it holds, or just display what the server answered.

The admin port also answers `GET /admin/api/identity?nonce=HEX64` (no session): `{ name, serverId, publicKey, fingerprint, nonce, signature }`, the same signature as `GET /info?nonce=` gives, for the local commands.

The panel's overview views have routes of their own on the admin port, all of them `GET` and behind the admin session and the panel's origin (they are not part of the API above, and a client token does not open them): `/admin/api/risks`, `/admin/api/health`, `/admin/api/runs?limit=&offset=`, `/admin/api/updates/history` and `/admin/api/log?limit=&before=&type=&ok=`; the devices and the session have theirs, in [Remembered devices](#remembered-devices). What each answers is in [The admin panel](#the-admin-panel). `GET /admin/api/status` lists the books from the same state the books in progress are read from (it no longer reads the books, so it is light however many there are).

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

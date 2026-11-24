# auth-proxy: OAuth token broker and GitHub Models CORS proxy (Cloudflare Worker)

> Owner's step-by-step guide, **CLI first** (install and sign in, move to this Worker, Microsoft with `az`, Google checklist, Cloudflare hardening, GitHub App, what to enforce): [`docs/guida-auth-proxy.it.md`](docs/guida-auth-proxy.it.md) (Italian), short English version [`docs/auth-proxy-setup.en.md`](docs/auth-proxy-setup.en.md).

The Narrarium web app runs entirely in the browser (GitHub Pages). This Cloudflare
Worker, named **`auth-proxy`** (it was `models-github-proxy`, when GitHub Models were its only
job; the old Worker keeps running until the owner deletes it, see the guide, section 2), does
two jobs for it:

1. **Stateless OAuth token broker** (everything under `/oauth/`, see
   [Broker OAuth](#broker-oauth)). It keeps the Google, Microsoft and GitHub App client
   secrets so that the site can stay connected to Google Drive, OneDrive and GitHub
   without asking the user to sign in again every hour. This is what the Worker is for now.
2. **CORS proxy for GitHub Models** (everything outside `/oauth/`). **Being retired**: GitHub
   Models are being shut down, so this part may no longer be needed. It stays here, unchanged
   and tested (`test/proxy.test.mjs`), and can be deleted (`src/index.js` forwarding code and
   its tests) when GitHub Models are gone. The GitHub Models API at
   `https://models.github.ai/*` does not return CORS headers, so browser calls are blocked;
   the Worker transparently forwards every request to `models.github.ai` and adds CORS
   headers scoped to the Narrarium origins.

## What it proxies (GitHub Models, being retired)

Every path outside `/oauth/`:

- `POST /inference/...` — chat/inference (OpenAI-compatible endpoint)
- `GET /catalog/models` — model catalog

Path, query string, HTTP method, body (streamed), and application headers
(`Authorization`, `Content-Type`, `Accept`, `X-GitHub-Api-Version`, ...) are
preserved. Cookies are stripped before forwarding. This behaviour is covered by
regression tests (`test/proxy.test.mjs`) and is unchanged by the broker.

## Allowed origins

Browsers may call the whole Worker (proxy and broker) only from these origins:

- `https://narrarium.net`
- `https://www.narrarium.net`
- `http://localhost:5173`, `http://localhost:4173` (local dev)

They are the defaults in `src/config.js` (`DEFAULT_ALLOWED_ORIGINS`). The optional
variable `ALLOWED_ORIGINS_EXTRA` in `wrangler.toml` adds more, comma separated. Each
entry is reduced to its origin, so a full site URL works; only `https` is accepted
(`http` only for `localhost`, `127.0.0.1` and `[::1]`); wildcards and `null` are ignored.
A site published under a sub-path on GitHub Pages
(`https://<user>.github.io/<repo>/`) is the origin `https://<user>.github.io`: the path
is not part of an origin.

A request with a browser `Origin` that is not allowed gets `403`. A caller with no
`Origin` header at all (curl, a server) is served without CORS headers.

## Broker OAuth

### Why it exists

- **Google.** A "Web application" client needs its client secret to swap the
  authorization code and to renew the access token, even with PKCE. The browser-only
  implicit flow used so far gives one-hour tokens and no refresh token.
- **Microsoft.** With the "Single-page application" platform the refresh token lives
  at most 24 hours. With the "Web" platform and a client secret it lives 90 days,
  renewed at every use.
- **GitHub.** A browser cannot call GitHub's token endpoint (no CORS) and the web flow
  needs the client secret. A **GitHub App** user token lives 8 hours and comes with a
  refresh token (6 months) that **rotates** at every use.

The secrets stay in the Worker. The browser keeps only the refresh token. The broker
is **stateless**: it stores nothing (no KV, no Durable Object, no cache) and writes
nothing to any log.

### API contract

Base URL: the Worker's own URL (`https://auth-proxy.<account>.workers.dev`).
The contract is stable: the site uses it as written here.

Every response has `Cache-Control: no-store`, `Content-Type: application/json` and
`Vary: Origin`. CORS headers are sent only to allowed origins (see above). The body of
a POST is at most 8 KiB and must be `Content-Type: application/json`. Only `POST` is
accepted, plus `GET /oauth/status`.

| Route | Request body | `200` answer |
| --- | --- | --- |
| `GET /oauth/status` | none | `{"google": boolean, "microsoft": boolean, "github": boolean}` |
| `POST /oauth/google/token` | `{"code"}` | `{"accessToken", "expiresIn", "refreshToken"?, "scope"?, "idToken"?}` |
| `POST /oauth/google/refresh` | `{"refreshToken"}` | `{"accessToken", "expiresIn", "scope"?}` |
| `POST /oauth/google/revoke` | `{"token"}` | `204`, no body |
| `POST /oauth/microsoft/token` | `{"code", "codeVerifier", "redirectUri"}` | `{"accessToken", "expiresIn", "refreshToken", "scope"?, "idToken"?, "clientInfo"?}` |
| `POST /oauth/microsoft/refresh` | `{"refreshToken"}` | `{"accessToken", "expiresIn", "refreshToken"?, "clientInfo"?}` |
| `POST /oauth/microsoft/revoke` | `{"token"}` | `204`, no body, nothing is called |
| `POST /oauth/github/token` | `{"code", "codeVerifier", "redirectUri"}` | `{"accessToken", "expiresIn", "refreshToken", "refreshTokenExpiresIn"?, "scope"?}` |
| `POST /oauth/github/refresh` | `{"refreshToken"}` | `{"accessToken", "expiresIn", "refreshToken", "refreshTokenExpiresIn"?, "scope"?}` |
| `POST /oauth/github/revoke` | `{"token"}` | `204`, no body |

Notes:

- `GET /oauth/status` is `true` for a provider only when both its client id **and** its
  secret are configured. It never contains a secret.
- `expiresIn` is a whole number of seconds. Optional fields are omitted, never `null`.
- **Google `/token`**: the code must come from the Google Identity Services code flow
  in popup mode (`initCodeClient` with `ux_mode: "popup"`), whose redirect URI is the
  literal `postmessage`; the broker sends that first and, only if Google answers `redirect_uri_mismatch`, repeats the exchange with the origin of the page (Google's guide says the origin is the redirect URI; the origin is one the Worker already allows). Google returns a
  `refreshToken` only when the user (re)consents, so keep the stored one when the
  answer has none. Google does **not** rotate refresh tokens.
- **Microsoft `/token`**: the site runs the authorization code flow with PKCE (S256).
  The `redirectUri` must be one of the allowed redirect URIs (below) and is sent to
  Microsoft unchanged. The scope is fixed by the broker:
  `User.Read Files.ReadWrite offline_access`; the authorization request must ask for
  the same scopes.
- **Microsoft `/refresh`**: Microsoft **rotates** the refresh token. When the answer
  has a `refreshToken`, the site must store it in place of the old one.
- **Microsoft `/revoke`**: Microsoft has no revocation endpoint the broker can use for
  these clients, so the route only answers `204` and calls nothing. The site deletes
  its local token; a real revocation is done by the user from the app-permissions page
  of their Microsoft account.
- **GitHub `/token`**: the site runs the web flow of a **GitHub App** with PKCE (S256) and
  sends the `code`, the `codeVerifier` and the same `redirectUri` it used to authorize
  (one of the allowed redirect URIs). There are no scopes: the token is limited by the
  app's permissions, the user's rights and the repositories the app is installed on. The
  answer always has `expiresIn` (28800 s) and a `refreshToken`; `refreshTokenExpiresIn`
  (15897600 s) is passed through when present; the empty `scope` GitHub reports is left
  out. A token **without expiry or refresh token** (the app has "Expire user authorization
  tokens" off) is refused with `502 upstream_error`: the broker never hands out a token
  that does not expire.
- **GitHub `/refresh`**: GitHub **rotates** the refresh token at every use, and the old one
  stops working at once. The answer always carries the new `refreshToken`: the site must
  store it in place of the old one (under a lock across tabs, as for Microsoft), and treat
  `400 invalid_grant` as "connect again", never as a retry loop.
- **GitHub `/revoke`**: deletes the app's authorization of that user
  (`DELETE https://api.github.com/applications/{client_id}/grant`, Basic authentication with
  the client id and secret, the token in the body), which revokes every token the app holds
  for the user, on every device. A `404` (no such grant) is answered `204` too. Send a
  **fresh** access token (refresh first): with an expired one GitHub cannot find the grant,
  and the user must then revoke the app at *Settings → Applications*.
- **GitHub reports OAuth errors inside an HTTP `200` JSON body**
  (`{"error":"bad_verification_code"}`), so the broker reads the body for an `error` before
  trusting the status: `bad_verification_code`, `bad_refresh_token` and `invalid_grant` →
  `400 invalid_grant`; `unverified_user_email` → `400 invalid_grant` with a message that
  says to verify the primary email; `incorrect_client_credentials` (and a `401` on revoke) →
  `501 not_configured` (the Worker's client id or secret is wrong); `redirect_uri_mismatch`
  and the other known codes → `502 upstream_error` quoting only the code. An error is never
  answered `200`.
- Body fields are strings of printable ASCII: at most 4096 characters for `code`,
  `refreshToken` and `token`, 2048 for `redirectUri`, 128 for `codeVerifier`. Unknown
  fields are ignored and never forwarded; the client id, grant type, scope, endpoint
  and Google redirect URI can never come from the body.

#### Microsoft account identity (`client_info`)

MSAL builds an account's `homeAccountId` as `<uid>.<utid>` from the `client_info` value
that Microsoft's token endpoint returns (base64url JSON `{"uid": "...", "utid": "..."}`)
and its `localAccountId` from the object id. Without `client_info` it falls back to the
`sub` claim of the ID token, which is a different identifier. To keep the same account
identity as the current MSAL connection:

- the site **adds `client_info=1` to the authorization request** it sends to Microsoft
  (MSAL does the same);
- the broker also asks for it, with `client_info=1` in the form of both
  `/microsoft/token` and `/microsoft/refresh` (MSAL sends it on every token request
  too), and passes the `client_info` string of the answer through **untouched** as
  `clientInfo`, next to `idToken`. It is never decoded and never logged. It is
  omitted when Microsoft sends none, or something that is not a non-empty string of at
  most 2048 characters.

For Google the identity comes from the `idToken` (`sub`). `clientInfo` is never part of
a Google answer.

#### Errors

Errors are JSON, `{"error": "<code>", "message": "<short text for a human>"}`:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | wrong `Content-Type`, body not a JSON object, field missing or invalid, `redirectUri` not allowed |
| 400 | `invalid_grant` | the provider rejects the code or refresh token (revoked, expired, already used, or the user must sign in again): the site must ask to reconnect |
| 403 | `forbidden_origin` | the `Origin` is not allowed |
| 404 | `not_found` | unknown `/oauth/...` route |
| 405 | `method_not_allowed` | wrong HTTP method (an `Allow` header says which) |
| 413 | `payload_too_large` | body larger than 8 KiB |
| 429 | `rate_limited` | too many requests; `Retry-After` gives the seconds to wait |
| 500 | `internal_error` | unexpected failure inside the Worker |
| 501 | `not_configured` | client id or secret missing for that provider, or (GitHub) GitHub says the configured ones are wrong |
| 502 | `upstream_error` | the provider is unreachable, answers unexpectedly, or rejects the broker's own configuration (the message then names the provider's error code, e.g. `invalid_client`) |
| 504 | `upstream_timeout` | the provider did not answer within 10 seconds |

The provider's message is summarised, never relayed, and no message ever contains a
token, a code or a secret.

### Security model

- **Secrets stay in the Worker environment.** `GOOGLE_CLIENT_SECRET`,
  `MICROSOFT_CLIENT_SECRET` and `GITHUB_APP_CLIENT_SECRET` are Worker secrets. They are not in the repository
  (`wrangler.toml` holds only the public client ids), and they never appear in logs,
  error messages, response headers or answers. The Worker has no `console.*` call at all.
- **CORS is not authentication.** The `Origin` check stops other websites from driving a
  visitor's browser to the broker; a caller without an `Origin` header (curl, a server)
  can still use it, and a non-browser caller can spoof the header. What really protects
  the client secrets is that they never leave the Worker. A stolen refresh token stays
  exactly as dangerous as it was before the broker existed, and that is why the site
  treats it as a secret.
- **Fixed upstreams, fixed clients.** The only endpoints ever called are
  `https://oauth2.googleapis.com/token`, `https://oauth2.googleapis.com/revoke`,
  `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
  `https://github.com/login/oauth/access_token` and
  `https://api.github.com/applications/{client_id}/grant`. Client ids come only from the
  configuration. The `redirectUri` of Microsoft and GitHub must match, exactly, an entry of
  `ALLOWED_REDIRECT_URIS` (one list for both: each provider also checks it against the
  callback URLs registered in its own console).
- **Strict input.** Content type, size, JSON shape, types and lengths are checked before
  anything leaves the Worker.
- **Minimal outbound request.** Only `Content-Type` and `Accept` are sent to a provider:
  never the caller's cookies, authorization, origin or address. Redirects are not
  followed, the call times out after 10 seconds (reading the answer included) and at
  most 64 KiB of the answer are read. None of the provider's headers is relayed.
- **Nothing is cached.** Answers are `no-store` and `Vary: Origin`.
- **Rate limit: best effort, not a guarantee.** Each address
  (`cf-connecting-ip`) may send 30 `POST` requests per 60 second window; the next ones
  get `429` with `Retry-After`. The counters live in the memory of the Worker isolate:
  they reset when it is recycled, are not shared between isolates or data centres, and
  an attacker with many addresses sidesteps them. `GET /oauth/status`, preflights and
  requests from refused origins are not counted; requests without `cf-connecting-ip`
  (Cloudflare always sets it) are not limited.
- **Second limit: the Workers Rate Limiting binding (optional).** `wrangler.toml` declares
  the binding `OAUTH_RATE_LIMITER` (30 calls per 60 s per address). It is shared by the
  isolates of one Cloudflare location, so it is stronger than the in-memory limit, but
  Cloudflare documents it as **approximate and local to each location** (and not visible in
  the dashboard); it needs Wrangler 4.36.0 or later (the deploy workflow installs Wrangler 4).
  It is asked after the in-memory check, only for provider `POST`s with an address. A missing
  binding, or one that throws, never blocks a request (the in-memory limit still applies);
  a refusal answers `429` with `Retry-After: 60`. `namespace_id` (`7301`) must be unique in
  the Cloudflare account. A strict global limit would need a Durable Object, and WAF
  rate-limiting rules **cannot be applied on `workers.dev`**: they need a custom domain.

### Configuration

| Name | Kind | Where | Meaning |
| --- | --- | --- | --- |
| `GOOGLE_CLIENT_ID` | variable | `wrangler.toml` | public Google client id (the one in `src/narrarium-site/src/config/publicClients.ts`) |
| `MICROSOFT_CLIENT_ID` | variable | `wrangler.toml` | public Microsoft application id (same file) |
| `GITHUB_APP_CLIENT_ID` | variable | `wrangler.toml` | public Client ID of the GitHub App (not the App ID); empty until the app is registered, and `github` stays `false` in `/oauth/status` while it is empty |
| `GOOGLE_CLIENT_SECRET` | **secret** | Worker secret | never in the repository; uploaded by the deploy workflow |
| `MICROSOFT_CLIENT_SECRET` | **secret** | Worker secret | never in the repository; uploaded by the deploy workflow |
| `GITHUB_APP_CLIENT_SECRET` | **secret** | Worker secret | never in the repository; uploaded by the deploy workflow from the repository secret `GH_APP_CLIENT_SECRET` (GitHub forbids repository secret names that start with `GITHUB_`) |
| `OAUTH_RATE_LIMITER` | binding | `wrangler.toml` `[[ratelimits]]` | optional Workers Rate Limiting binding (see the security model) |
| `ALLOWED_REDIRECT_URIS` | variable | `wrangler.toml` | Microsoft and GitHub redirect URIs the broker accepts, comma separated, exact match |
| `ALLOWED_ORIGINS_EXTRA` | variable | `wrangler.toml` | optional extra allowed origins (see above) |

`ALLOWED_REDIRECT_URIS` defaults to, and `wrangler.toml` lists:

```
https://narrarium.net/auth/microsoft-callback.html
https://www.narrarium.net/auth/microsoft-callback.html
http://localhost:5173/auth/microsoft-callback.html
http://localhost:4173/auth/microsoft-callback.html
https://narrarium.net/auth/github/callback
https://www.narrarium.net/auth/github/callback
http://localhost:5173/auth/github/callback
http://localhost:4173/auth/github/callback
```

When the variable has any text it **replaces** the defaults, so keep every entry you
still need. Entries that are not absolute `https` URLs (`http` only for loopback
hosts) without wildcards, fragments or credentials are dropped; a list with nothing
usable refuses every redirect URI. A site published under a sub-path (`SITE_BASE`, for
instance GitHub Pages) adds its own callback URL, e.g.
`https://<user>.github.io/<repo>/auth/microsoft-callback.html` (and `.../auth/github/callback`).

The client ids in `wrangler.toml` must be the ones the site starts the sign-in with. If
the site is built with `VITE_GOOGLE_CLIENT_ID` or `VITE_MICROSOFT_CLIENT_ID`, change the
two variables to match; `GITHUB_APP_CLIENT_ID` is the Client ID of the GitHub App.

### Limits (constants in `src/oauth.js`)

| Limit | Value | Over the limit |
| --- | --- | --- |
| Request body | 8 KiB | `413` |
| Provider answer read | 64 KiB | `502` |
| Provider call | 10 s | `504` |
| Rate limit | 30 POST requests per 60 s per address (in memory, plus the optional binding) | `429` |

## Passi per il proprietario

Si fanno una volta sola. La procedura completa, **da riga di comando**, con una riga
«Verifica» per passo, è in [`docs/guida-auth-proxy.it.md`](docs/guida-auth-proxy.it.md)
(versione inglese breve: [`docs/auth-proxy-setup.en.md`](docs/auth-proxy-setup.en.md)). In
breve, nell'ordine: (a) unisci in `main` la modifica che crea il Worker `auth-proxy` (il
workflow che parte è quello di `main`); (b) `gh workflow run deploy-auth-proxy.yml` pubblica
il Worker **nuovo** (il vecchio `models-github-proxy` non viene toccato); (c)
`src/auth-proxy/scripts/set-secrets.sh` carica i client secret con input nascosto; (d)
`node src/auth-proxy/scripts/check-status.mjs <url del nuovo Worker>`; (e) sposta la
variabile `VITE_GITHUB_MODELS_BASE` sul nuovo indirizzo e ripubblica il sito; (f) prova un
collegamento vero a Google Drive e OneDrive; (g) solo allora elimina il vecchio Worker.

I segreti, a mano (il valore si incolla al prompt, **mai** nella riga di comando; `set-secrets.sh`
fa la stessa cosa con input nascosto):

```bash
gh secret set GOOGLE_OAUTH_CLIENT_SECRET
gh secret set MICROSOFT_OAUTH_CLIENT_SECRET
gh secret set GH_APP_CLIENT_SECRET     # client secret della GitHub App; il deploy lo carica come GITHUB_APP_CLIENT_SECRET
gh workflow run deploy-auth-proxy.yml
```

Per Microsoft c'è lo script di sola lettura `scripts/check-microsoft-app.sh` (usa `az`): dice
quali dei quattro URI di ritorno mancano. Per Google non esiste una CLI per il client OAuth:
la guida ha la lista dei controlli sulla console.

### Rotazione e disattivazione

**Rotazione di un segreto**, senza interruzioni (i refresh token già emessi restano
validi: non dipendono dal segreto):

1. Crea il segreto nuovo dal provider (Google: **Aggiungi secret**; Microsoft: **Nuovo
   segreto client**) e lascia il vecchio.
2. `gh secret set GOOGLE_OAUTH_CLIENT_SECRET` (o `MICROSOFT_OAUTH_CLIENT_SECRET`),
   incollando il valore nuovo (meglio con `scripts/set-secrets.sh`), poi `gh workflow run
   deploy-auth-proxy.yml`.
3. Controlla `/oauth/status` e collega un account di prova.
4. Solo ora elimina o disattiva il segreto vecchio dal provider.

**Disattivare tutto** (o un solo provider): togli il segreto **dal Worker**. Togliere
solo quello di GitHub non basta, perché un deploy non cancella i segreti già presenti nel
Worker:

```bash
cd src/auth-proxy
npx wrangler login                              # una volta, interattivo
npx wrangler secret delete GOOGLE_CLIENT_SECRET
npx wrangler secret delete MICROSOFT_CLIENT_SECRET
```

In alternativa dal dashboard Cloudflare: **Workers & Pages** → `auth-proxy` →
**Settings** → **Variables and Secrets**. Poi rimuovi anche i segreti GitHub
(`gh secret remove GOOGLE_OAUTH_CLIENT_SECRET`, `gh secret remove
MICROSOFT_OAUTH_CLIENT_SECRET`), altrimenti il deploy successivo li rimette. Da quel
momento `/oauth/status` dà `false`, il broker risponde `501` e il sito torna ai flussi
attuali, perché le registrazioni esistenti (MSAL e Google) non sono state toccate. I
refresh token già emessi restano validi presso il provider finché scadono o l'utente li
revoca dalla propria pagina account.

### Quanto durano le credenziali

- **Google**: finché l'utente non revoca l'accesso; scadono dopo 6 mesi senza uso, e un
  account può averne al massimo 100 per client (i più vecchi vengono invalidati). Con
  l'app in "Testing" scadono dopo 7 giorni.
- **Microsoft**: 90 giorni dall'ultimo uso, rinnovati a ogni uso (per questo il sito
  salva sempre il refresh token nuovo). Possono essere invalidati da un cambio password
  o da una revoca.

### Se qualcosa non funziona

| Sintomo | Causa probabile | Rimedio |
| --- | --- | --- |
| `/oauth/status` dà `false`, o `501 not_configured` | il Worker non ha il segreto del provider (per GitHub: anche `GITHUB_APP_CLIENT_ID` vuoto in `wrangler.toml`, o GitHub dice che id/segreto sono sbagliati) | `gh secret list`, controlla il riepilogo del workflow e rilancialo |
| `/oauth/status` senza la chiave `github` | il Worker in linea è ancora la versione precedente | attendi la propagazione e rilancia il workflow |
| `400 invalid_grant` da GitHub | codice o refresh token respinti (GitHub li ruota a ogni uso) | il sito deve chiedere di ricollegare l'account |
| `502 upstream_error` con `invalid_client` | segreto sbagliato o scaduto, id diverso da quello del sito; per Microsoft di solito si è copiato l'"ID segreto" invece del "Valore" | rifai il passo del segreto (guida, sezioni 3 e 4) e carica il valore con `set-secrets.sh` |
| `502 upstream_error` per Microsoft dopo un collegamento | URI di reindirizzamento ancora sotto "Applicazione a pagina singola" (`AADSTS9002327`) | registralo sotto **Web** (guida, sezione 3: `check-microsoft-app.sh` lo mostra) |
| `400 invalid_request`, "redirectUri is not on the list" | l'URL di callback non è in `ALLOWED_REDIRECT_URIS` | aggiungilo in `wrangler.toml` e fai il deploy |
| `403 forbidden_origin` | l'origine del sito non è consentita | aggiungila in `ALLOWED_ORIGINS_EXTRA` e fai il deploy |
| `400 invalid_grant` al rinnovo | refresh token scaduto o revocato | il sito deve chiedere di ricollegare l'account |
| `429 rate_limited` | troppe richieste dallo stesso indirizzo | attendere i secondi di `Retry-After` |
| `504 upstream_timeout` | il provider non ha risposto in 10 s | riprovare |

## Deploy

Deployment is automated by `.github/workflows/deploy-auth-proxy.yml` ("Deploy auth proxy"),
which runs on every push to `main` that changes `src/auth-proxy/**` (and on demand with
`gh workflow run deploy-auth-proxy.yml`). It:

1. runs the Worker tests (`npm test`; no dependency to install);
2. lists which of the OAuth client secrets exist in the repository
   (`scripts/list-oauth-secrets.mjs`) and hands those, under the Worker's names, to
   `cloudflare/wrangler-action` through its `secrets:` input, with one notice per missing
   one. A missing repository secret never fails the deploy: that provider answers
   `501 not_configured` and `GET /oauth/status` says so;
3. runs `wrangler deploy` (Wrangler 4; the step has the id `deploy`);
4. calls `GET /oauth/status` on the live Worker: the URL is the output `deployment-url` of
   the deploy step, and the repository variable `VITE_GITHUB_MODELS_BASE` is only the
   fallback when that output is empty (the variable still points to the OLD Worker until the
   owner switches it); a few retries because a new deploy takes seconds to propagate, and writes a table to the job summary: for each of Google, Microsoft and
   GitHub "configured" or "not configured" and, when not, the one next action
   (`scripts/summarize-oauth-status.mjs`). It never fails the run and never prints a value.

The workflow has `permissions: contents: read`, never runs twice at once and times out
after 10 minutes. It also starts on demand (`gh workflow run deploy-auth-proxy.yml`, no inputs).

It needs these GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN` — a scoped token that can edit Workers (it also uploads the secrets)
- `CLOUDFLARE_ACCOUNT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_CLIENT_SECRET` and `GH_APP_CLIENT_SECRET`
  — optional, one per provider; stored in the Worker as `GOOGLE_CLIENT_SECRET`,
  `MICROSOFT_CLIENT_SECRET` and `GITHUB_APP_CLIENT_SECRET`. (GitHub forbids repository
  secret names that start with `GITHUB_`, hence `GH_APP_CLIENT_SECRET`.)

Helper scripts in `scripts/`: `set-secrets.sh` (asks for the three secrets with hidden
input and sets them with `gh secret set`, value through stdin; `--dry-run`; optionally runs
the deploy and the check), `check-status.mjs` (prints the `/oauth/status` answer in words;
takes the Worker URL as an argument and reads `VITE_GITHUB_MODELS_BASE` only as a fallback;
Italian by default, `--lang en`, `--strict` exits 2 while a provider is missing,
`--worker-name NAME` points a `*.workers.dev` URL at another Worker of the same account),
`check-microsoft-app.sh` (read-only: with `az` signed in, prints the Microsoft app
registration's audience, redirect URIs and delegated permissions, and which of the four
callback URLs are missing) and `list-oauth-secrets.mjs` / `summarize-oauth-status.mjs`
(used by the workflow).

The Worker is **not an npm workspace** (the root `package.json` lists `packages/*` and
`src/narrarium-site`) and has no dependency: Wrangler comes from `wrangler-action` in the
workflow, or from `npx wrangler` on your machine.

A deploy never deletes a secret already stored in the Worker; see
[Passi per il proprietario](#passi-per-il-proprietario) for how to remove one.

### Manual deploy

```bash
cd src/auth-proxy
npx wrangler login      # interactive, local only
npx wrangler deploy
npx wrangler secret put GOOGLE_CLIENT_SECRET      # optional, prompts for the value
npx wrangler secret put MICROSOFT_CLIENT_SECRET   # optional, prompts for the value
npx wrangler secret put GITHUB_APP_CLIENT_SECRET  # optional, prompts for the value
```

The Worker publishes to its `*.workers.dev` subdomain because `narrarium.net`
DNS is hosted on GoDaddy, not Cloudflare. After the first deploy the URL looks
like:

```
https://auth-proxy.<account-subdomain>.workers.dev
```

The Narrarium app reads that base URL from the `VITE_GITHUB_MODELS_BASE` environment
variable at build time (see `src/narrarium-site/src/config/githubModels.ts` and
`authBroker.ts`); the name is a leftover from when the Worker only proxied GitHub Models and
stays for now.

### Optional later: `cf migrate`

Cloudflare's new CLI `cf` (1.0 release candidate) can replace Wrangler, but not in a project
that still has `wrangler.toml`: `cf dev`, `cf build` and `cf deploy` must not be run in an
unmigrated Wrangler project (they write their own configuration or fail). Deploys stay with
Wrangler through the workflow; `cf migrate` (preview with `cf migrate --dry-run`) is an
optional later step, described in the guide. `cf` is meanwhile useful for read and
administrative commands (`cf workers list`, `cf workers secrets list`, `cf observability tail`).

### Custom domain (optional, future)

If `narrarium.net` is moved to Cloudflare (steps in the guide), add to `wrangler.toml`
(keep `workers_dev = true` until the migration is over: without it, `routes` turn it off):

```toml
[[routes]]
pattern = "auth.narrarium.net"
custom_domain = true
```

## Tests

```bash
cd src/auth-proxy
npm test
```

The suite uses Node's built-in test runner: no dependency to install and no network. It
calls the Worker's `fetch(request, env)` handler directly with a `Request` and stubs
`globalThis.fetch` for the providers. It covers the proxy regression, CORS and origins,
body and content-type limits, every route (happy path, `invalid_grant`, provider errors,
timeouts, oversized answers), the redirect allow-list, `client_info`, the rate limit,
the absence of secrets and tokens from logs, answers and headers, the GitHub provider
(including errors reported inside an HTTP 200), the optional rate limiting binding (with
and without a fake binding), the deploy workflow, the secret-listing and status scripts
(including a missing secret and a fake status answer), the `set-secrets.sh` dry run and
its flow with a fake `gh`, and the committed configuration.

## Local test

```bash
npx wrangler dev
curl -i -H "Origin: https://narrarium.net" http://localhost:8787/catalog/models
curl -i -H "Origin: https://narrarium.net" http://localhost:8787/oauth/status
```

To try the broker locally put the secrets in a `.dev.vars` file next to `wrangler.toml`
(it is git-ignored; never commit it):

```
GOOGLE_CLIENT_SECRET=...
MICROSOFT_CLIENT_SECRET=...
GITHUB_APP_CLIENT_SECRET=...
```

## Security note

CORS is a browser-side guard, not authentication. A non-browser client can spoof
the `Origin` header. For stronger protection add a shared secret header or a
Cloudflare Access policy in front of the Worker. For the OAuth broker see its
[security model](#security-model): the client secrets never leave the Worker, and a
stolen refresh token is as dangerous as ever.

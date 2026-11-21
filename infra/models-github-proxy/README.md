# GitHub Models CORS proxy and OAuth token broker (Cloudflare Worker)

The Narrarium web app runs entirely in the browser (GitHub Pages). This Cloudflare
Worker does two jobs for it:

1. **CORS proxy for GitHub Models.** The GitHub Models API at
   `https://models.github.ai/*` does not return CORS headers, so browser calls are
   blocked. The Worker transparently forwards every request to `models.github.ai` and
   adds CORS headers scoped to the Narrarium origins.
2. **Stateless OAuth token broker** (everything under `/oauth/`, see
   [Broker OAuth](#broker-oauth)). It keeps the Google and Microsoft client secrets
   so that the site can stay connected to Google Drive and OneDrive without asking the
   user to sign in again every hour.

## What it proxies

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

The secrets stay in the Worker. The browser keeps only the refresh token. The broker
is **stateless**: it stores nothing (no KV, no Durable Object, no cache) and writes
nothing to any log.

### API contract

Base URL: the Worker's own URL (`https://models-github-proxy.<account>.workers.dev`).
The contract is stable: the site uses it as written here.

Every response has `Cache-Control: no-store`, `Content-Type: application/json` and
`Vary: Origin`. CORS headers are sent only to allowed origins (see above). The body of
a POST is at most 8 KiB and must be `Content-Type: application/json`. Only `POST` is
accepted, plus `GET /oauth/status`.

| Route | Request body | `200` answer |
| --- | --- | --- |
| `GET /oauth/status` | none | `{"google": boolean, "microsoft": boolean}` |
| `POST /oauth/google/token` | `{"code"}` | `{"accessToken", "expiresIn", "refreshToken"?, "scope"?, "idToken"?}` |
| `POST /oauth/google/refresh` | `{"refreshToken"}` | `{"accessToken", "expiresIn", "scope"?}` |
| `POST /oauth/google/revoke` | `{"token"}` | `204`, no body |
| `POST /oauth/microsoft/token` | `{"code", "codeVerifier", "redirectUri"}` | `{"accessToken", "expiresIn", "refreshToken", "scope"?, "idToken"?, "clientInfo"?}` |
| `POST /oauth/microsoft/refresh` | `{"refreshToken"}` | `{"accessToken", "expiresIn", "refreshToken"?, "clientInfo"?}` |
| `POST /oauth/microsoft/revoke` | `{"token"}` | `204`, no body, nothing is called |

Notes:

- `GET /oauth/status` is `true` for a provider only when both its client id **and** its
  secret are configured. It never contains a secret.
- `expiresIn` is a whole number of seconds. Optional fields are omitted, never `null`.
- **Google `/token`**: the code must come from the Google Identity Services code flow
  in popup mode (`initCodeClient` with `ux_mode: "popup"`), whose redirect URI is the
  literal `postmessage`; the broker sends exactly that. Google returns a
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
| 501 | `not_configured` | client id or secret missing for that provider |
| 502 | `upstream_error` | the provider is unreachable, answers unexpectedly, or rejects the broker's own configuration (the message then names the provider's error code, e.g. `invalid_client`) |
| 504 | `upstream_timeout` | the provider did not answer within 10 seconds |

The provider's message is summarised, never relayed, and no message ever contains a
token, a code or a secret.

### Security model

- **Secrets stay in the Worker environment.** `GOOGLE_CLIENT_SECRET` and
  `MICROSOFT_CLIENT_SECRET` are Worker secrets. They are not in the repository
  (`wrangler.toml` holds only the public client ids), and they never appear in logs,
  error messages, response headers or answers. The Worker has no `console.*` call at all.
- **CORS is not authentication.** The `Origin` check stops other websites from driving a
  visitor's browser to the broker; a caller without an `Origin` header (curl, a server)
  can still use it, and a non-browser caller can spoof the header. What really protects
  the client secrets is that they never leave the Worker. A stolen refresh token stays
  exactly as dangerous as it was before the broker existed, and that is why the site
  treats it as a secret.
- **Fixed upstreams, fixed clients.** The only endpoints ever called are
  `https://oauth2.googleapis.com/token`, `https://oauth2.googleapis.com/revoke` and
  `https://login.microsoftonline.com/common/oauth2/v2.0/token`. Client ids come only
  from the configuration. Microsoft's `redirectUri` must match, exactly, an entry of
  `ALLOWED_REDIRECT_URIS`.
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
  (Cloudflare always sets it) are not limited. A hard guarantee would need a
  Cloudflare-side control, for instance a rate limiting rule on a custom domain or the
  Workers Rate Limiting binding.

### Configuration

| Name | Kind | Where | Meaning |
| --- | --- | --- | --- |
| `GOOGLE_CLIENT_ID` | variable | `wrangler.toml` | public Google client id (the one in `src/narrarium-site/src/config/publicClients.ts`) |
| `MICROSOFT_CLIENT_ID` | variable | `wrangler.toml` | public Microsoft application id (same file) |
| `GOOGLE_CLIENT_SECRET` | **secret** | Worker secret | never in the repository; uploaded by the deploy workflow |
| `MICROSOFT_CLIENT_SECRET` | **secret** | Worker secret | never in the repository; uploaded by the deploy workflow |
| `ALLOWED_REDIRECT_URIS` | variable | `wrangler.toml` | Microsoft redirect URIs the broker accepts, comma separated, exact match |
| `ALLOWED_ORIGINS_EXTRA` | variable | `wrangler.toml` | optional extra allowed origins (see above) |

`ALLOWED_REDIRECT_URIS` defaults to, and `wrangler.toml` lists:

```
https://narrarium.net/auth/microsoft-callback.html
https://www.narrarium.net/auth/microsoft-callback.html
http://localhost:5173/auth/microsoft-callback.html
http://localhost:4173/auth/microsoft-callback.html
```

When the variable has any text it **replaces** the defaults, so keep every entry you
still need. Entries that are not absolute `https` URLs (`http` only for loopback
hosts) without wildcards, fragments or credentials are dropped; a list with nothing
usable refuses every redirect URI. A site published under a sub-path (`SITE_BASE`, for
instance GitHub Pages) adds its own callback URL, e.g.
`https://<user>.github.io/<repo>/auth/microsoft-callback.html`.

The client ids in `wrangler.toml` must be the ones the site starts the sign-in with. If
the site is built with `VITE_GOOGLE_CLIENT_ID` or `VITE_MICROSOFT_CLIENT_ID`, change the
two variables to match.

### Limits (constants in `src/oauth.js`)

| Limit | Value | Over the limit |
| --- | --- | --- |
| Request body | 8 KiB | `413` |
| Provider answer read | 64 KiB | `502` |
| Provider call | 10 s | `504` |
| Rate limit | 30 POST requests per 60 s per address | `429` |

## Passi per il proprietario

Si fanno una volta sola e non richiedono altro aiuto. Prima di cominciare unisci
(merge) in `main` la modifica che introduce il broker: il workflow che parte è quello
di `main`. Finché il sito non usa il broker, per gli utenti non cambia nulla.

I nomi dei menu sono quelli delle console in italiano, con l'inglese tra parentesi.

### 1. Google Cloud Console

1. Apri la [Google Cloud Console](https://console.cloud.google.com/) nel progetto che
   contiene il client OAuth, poi **API e servizi** → **Credenziali** (*APIs & Services →
   Credentials*).
2. In "ID client OAuth 2.0" apri il client di tipo **Applicazione web** (*Web
   application*) il cui ID inizia con `91477716497-`.
3. Copia il **Client secret**. Se la console mostra solo un segreto mascherato, premi
   **Aggiungi secret** (*Add secret*) e copia subito quello nuovo: Google lo mostra una
   volta sola. Il segreto vecchio resta valido finché non lo disattivi.
4. In **Origini JavaScript autorizzate** (*Authorized JavaScript origins*) devono
   esserci `https://narrarium.net` e `https://www.narrarium.net`, più
   `http://localhost:5173` per lo sviluppo (e `https://<utente>.github.io` se il sito è
   anche su GitHub Pages). Salva: la modifica può richiedere qualche minuto. Gli "URI di
   reindirizzamento autorizzati" non servono: il flusso a popup usa `postmessage`.
5. Apri la **Schermata consenso OAuth** (*OAuth consent screen*; nella console più
   recente: **Google Auth Platform** → **Pubblico**) e premi **Pubblica l'app**
   (*Publish app*) finché lo stato è **In produzione**. In stato "Testing" i refresh
   token scadono dopo 7 giorni. Gli ambiti usati sono `drive.appdata`, `drive`, `openid`,
   `profile`, `email`. Poiché `drive` è un ambito riservato, finché l'app non è
   verificata da Google gli utenti vedono l'avviso "app non verificata" e (regola di
   Google, da controllare) l'app è limitata a 100 utenti; non incide sulla durata dei
   refresh token.

### 2. Microsoft Entra ID (Azure)

1. Apri [Microsoft Entra](https://entra.microsoft.com/) (o il portale Azure) →
   **Registrazioni app** (*App registrations*) → l'app con ID applicazione (client)
   `a80b2024-b9e3-4cb1-8480-aac7f164a6eb`.
2. **Autenticazione** (*Authentication*) → **Aggiungi una piattaforma** (*Add a
   platform*) → **Web**. Negli **URI di reindirizzamento** inserisci
   `https://narrarium.net/auth/microsoft-callback.html` e, se servono,
   `https://www.narrarium.net/auth/microsoft-callback.html`,
   `http://localhost:5173/auth/microsoft-callback.html`,
   `http://localhost:4173/auth/microsoft-callback.html`. Se il sito è su GitHub Pages
   aggiungi anche
   `https://<utente>.github.io/<repo>/auth/microsoft-callback.html`, e lo stesso URL in
   `ALLOWED_REDIRECT_URIS` di `wrangler.toml`.
   - La piattaforma deve essere **Web**, non "Applicazione a pagina singola" (*Single-page
     application*): con quest'ultima il refresh token dura al massimo 24 ore e Microsoft
     rifiuta lo scambio del codice con il segreto (errore `AADSTS9002327`).
   - Non toccare gli URI già registrati per MSAL (`.../msal-popup.html`, di solito sotto
     la piattaforma a pagina singola): servono al collegamento attuale.
   - In **Impostazioni avanzate** "Consenti flussi client pubblici" (*Allow public client
     flows*) deve restare **No**.
3. **Certificati e segreti** (*Certificates & secrets*) → **Segreti client** → **Nuovo
   segreto client** (*New client secret*): dagli un nome (per esempio `narrarium-worker`)
   e una scadenza, premi **Aggiungi** e copia subito il **Valore** (non l'"ID segreto"): non
   sarà più visibile. Annota la data di scadenza (massimo 24 mesi): a quella data va
   ruotato (vedi il passo 5).
4. **Autorizzazioni API** (*API permissions*): devono esserci, come autorizzazioni
   delegate di Microsoft Graph, `User.Read`, `Files.ReadWrite` e `offline_access`. Il tipo
   di account supportato deve includere gli account Microsoft personali (il broker usa
   l'authority `common`).

### 3. Segreti del repository GitHub

Dalla cartella del repository:

```bash
gh secret set GOOGLE_OAUTH_CLIENT_SECRET
gh secret set MICROSOFT_OAUTH_CLIENT_SECRET
```

`gh` chiede il valore: incollalo al prompt, **mai nella riga di comando** (finirebbe nella
cronologia della shell). `gh secret list` mostra i nomi, mai i valori. Poi rilancia il
workflow "Deploy Cloudflare Worker":

```bash
gh workflow run deploy-worker.yml
gh run watch            # scegli l'esecuzione appena avviata
```

Il workflow esegue prima i test del Worker, poi carica nel Worker i segreti che esistono
(il passo "Select the OAuth client secrets to upload" segnala, solo per nome, quali
segreti GitHub mancano, con un'annotazione nella pagina dell'esecuzione) e infine
pubblica. Se manca un segreto non fallisce: quel provider risponde
`501 not_configured`. Servono anche i segreti `CLOUDFLARE_API_TOKEN` (con il permesso di
modificare i Worker: è lui a caricare i segreti) e `CLOUDFLARE_ACCOUNT_ID`, già usati dal
deploy.

### 4. Verifica

L'indirizzo del Worker è `https://models-github-proxy.<sottodominio-account>.workers.dev`,
lo stesso valore della variabile `VITE_GITHUB_MODELS_BASE` (`gh variable get
VITE_GITHUB_MODELS_BASE`).

```bash
curl https://<worker>.workers.dev/oauth/status
# {"google":true,"microsoft":true}
```

Per controllare anche id e segreto di Google senza usare token veri:

```bash
curl -s -X POST https://<worker>.workers.dev/oauth/google/refresh \
  -H 'Content-Type: application/json' -d '{"refreshToken":"prova"}'
```

La risposta attesa è `{"error":"invalid_grant",...}`: Google ha accettato id e segreto e
ha rifiutato il token inventato. Se invece dice `upstream_error` con `invalid_client`,
il segreto o l'id sono sbagliati. Per Microsoft la prova vera è collegare un account dal
sito.

### 5. Rotazione e disattivazione

**Rotazione di un segreto**, senza interruzioni (i refresh token già emessi restano
validi: non dipendono dal segreto):

1. Crea il segreto nuovo dal provider (Google: **Aggiungi secret**; Microsoft: **Nuovo
   segreto client**) e lascia il vecchio.
2. `gh secret set GOOGLE_OAUTH_CLIENT_SECRET` (o `MICROSOFT_OAUTH_CLIENT_SECRET`),
   incollando il valore nuovo, poi `gh workflow run deploy-worker.yml`.
3. Controlla `/oauth/status` e collega un account di prova.
4. Solo ora elimina o disattiva il segreto vecchio dal provider.

**Disattivare tutto** (o un solo provider): togli il segreto **dal Worker**. Togliere
solo quello di GitHub non basta, perché un deploy non cancella i segreti già presenti nel
Worker:

```bash
cd infra/models-github-proxy
npx wrangler login                              # una volta, interattivo
npx wrangler secret delete GOOGLE_CLIENT_SECRET
npx wrangler secret delete MICROSOFT_CLIENT_SECRET
```

In alternativa dal dashboard Cloudflare: **Workers & Pages** → `models-github-proxy` →
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
| `/oauth/status` dà `false`, o `501 not_configured` | il Worker non ha il segreto del provider | `gh secret list`, controlla il log del workflow e rilancialo |
| `502 upstream_error` con `invalid_client` | segreto sbagliato o scaduto, id diverso da quello del sito; per Microsoft di solito si è copiato l'"ID segreto" invece del "Valore" | rifai il passo 1.3 o 2.3 e il passo 3 |
| `502 upstream_error` per Microsoft dopo un collegamento | URI di reindirizzamento ancora sotto "Applicazione a pagina singola" (`AADSTS9002327`) | registralo sotto **Web** (passo 2.2) |
| `400 invalid_request`, "redirectUri is not on the list" | l'URL di callback non è in `ALLOWED_REDIRECT_URIS` | aggiungilo in `wrangler.toml` e fai il deploy |
| `403 forbidden_origin` | l'origine del sito non è consentita | aggiungila in `ALLOWED_ORIGINS_EXTRA` e fai il deploy |
| `400 invalid_grant` al rinnovo | refresh token scaduto o revocato | il sito deve chiedere di ricollegare l'account |
| `429 rate_limited` | troppe richieste dallo stesso indirizzo | attendere i secondi di `Retry-After` |
| `504 upstream_timeout` | il provider non ha risposto in 10 s | riprovare |

## Deploy

Deployment is automated by `.github/workflows/deploy-worker.yml`, which runs on every
push to `main` that changes `infra/**` (and on demand with `gh workflow run
deploy-worker.yml`). It:

1. runs the Worker tests (`npm test`; no dependency to install);
2. lists which of the OAuth client secrets exist in the repository
   (`scripts/list-oauth-secrets.mjs`) and hands those, under the Worker's names, to
   `cloudflare/wrangler-action` through its `secrets:` input. A missing repository secret
   never fails the deploy: that provider answers `501 not_configured` and
   `GET /oauth/status` says so;
3. runs `wrangler deploy`.

It needs these GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN` — a scoped token that can edit Workers (it also uploads the secrets)
- `CLOUDFLARE_ACCOUNT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET` and `MICROSOFT_OAUTH_CLIENT_SECRET` — optional, one per
  provider; stored in the Worker as `GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_SECRET`

A deploy never deletes a secret already stored in the Worker; see
[Passi per il proprietario](#passi-per-il-proprietario) for how to remove one.

### Manual deploy

```bash
cd infra/models-github-proxy
npm install
npx wrangler login      # interactive, local only
npx wrangler deploy
npx wrangler secret put GOOGLE_CLIENT_SECRET      # optional, prompts for the value
npx wrangler secret put MICROSOFT_CLIENT_SECRET   # optional, prompts for the value
```

The Worker publishes to its `*.workers.dev` subdomain because `narrarium.net`
DNS is hosted on GoDaddy, not Cloudflare. After the first deploy the URL looks
like:

```
https://models-github-proxy.<account-subdomain>.workers.dev
```

The Narrarium app reads that base URL from the `VITE_GITHUB_MODELS_BASE`
environment variable at build time (see `src/narrarium-site/src/config/githubModels.ts`).

### Custom domain (optional, future)

If `narrarium.net` is moved to Cloudflare, replace `workers_dev = true` in
`wrangler.toml` with:

```toml
[[routes]]
pattern = "models-proxy.narrarium.net"
custom_domain = true
```

## Tests

```bash
cd infra/models-github-proxy
npm test
```

The suite uses Node's built-in test runner: no dependency to install and no network. It
calls the Worker's `fetch(request, env)` handler directly with a `Request` and stubs
`globalThis.fetch` for the providers. It covers the proxy regression, CORS and origins,
body and content-type limits, every route (happy path, `invalid_grant`, provider errors,
timeouts, oversized answers), the redirect allow-list, `client_info`, the rate limit,
the absence of secrets and tokens from logs, answers and headers, the deploy workflow and
the committed configuration.

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
```

## Security note

CORS is a browser-side guard, not authentication. A non-browser client can spoof
the `Origin` header. For stronger protection add a shared secret header or a
Cloudflare Access policy in front of the Worker. For the OAuth broker see its
[security model](#security-model): the client secrets never leave the Worker, and a
stolen refresh token is as dangerous as ever.

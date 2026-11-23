# Cloudflare and sign-in setup (short English version)

What the owner must do by hand so the `models-github-proxy` Worker can keep the site connected to Google Drive, OneDrive and (with a later site release) GitHub, and what to **enforce**. The full step-by-step guide, with every field and a **verify** line per step, is in Italian: [`guida-cloudflare-e-accessi.it.md`](guida-cloudflare-e-accessi.it.md). Technical reference: [`infra/models-github-proxy/README.md`](../README.md).

Rule zero: never paste a secret (API token, client secret, refresh token) into an issue, chat, commit or `wrangler.toml`. Secrets go only into GitHub repository secrets (`set-secrets.sh` or `gh secret set`) and from there into Worker secrets.

Menu names below come from the official docs of 2026-11-23 (sources at the end); I could not open the real forms (they need your login), so where a UI label may differ I say so.

## 0. State

- Done: the Worker is live at `https://models-github-proxy.alessandro-rapiti44.workers.dev`; the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist; the deploy workflow uploads the OAuth secrets that exist and writes a "configured / not configured" table (Google, Microsoft, GitHub) in the run summary; the Worker has the `github` provider and `GET /oauth/status` reports it; `scripts/set-secrets.sh` and `scripts/check-status.mjs` exist.
- Not done (yours): `/oauth/status` still says `google:false, microsoft:false` (plus `github:false`) because no client secret is in the Worker. You must: check or recreate the Cloudflare API token with least privilege; set up Google, Microsoft and the GitHub App; run `set-secrets.sh`.
- Merge this change into `main` first (the workflow that runs is the one on `main`).

## 1. Cloudflare

1. **Account ID:** dashboard → `Ctrl/Cmd+K` → "Copy account ID" (or **Workers & Pages** → **Account Details**). *Verify:* 32 hex characters; the deploy step succeeding proves the stored secret is right.
2. **`workers.dev` subdomain:** **Workers & Pages** → **Your subdomain** (change it only if you must: it changes the Worker's URL). *Verify:* `gh variable get VITE_GITHUB_MODELS_BASE` prints the Worker URL.
3. **Check the current token:** **Manage Account** → **Account API Tokens** (or **My Profile** → **API Tokens** for a user token). The "Edit Cloudflare Workers" template carries Workers Scripts, KV, R2, Routes, Tail, Account Settings, User Details and Memberships permissions: more than this Worker needs. *Verify:* the last "Deploy Cloudflare Worker" run is green.
4. **Least-privilege token:** **Account API Tokens** → **Create Token** → **Create Custom Token**. Name `narrarium-worker-deploy-github-actions`. One *Account* policy: the documented minimum for `wrangler deploy` and `wrangler secret put` of an existing Worker is the **Editor** role on that Worker (if the picker offers Workers roles, scope it to `models-github-proxy`; otherwise **Workers Scripts → Edit**). Account resource: your account only. Set an expiry (12 months suggested) and a calendar reminder; no IP filtering (GitHub runner IPs change). Create, copy the value once, `gh secret set CLOUDFLARE_API_TOKEN` (paste at the prompt), run `gh workflow run deploy-worker.yml`, delete the old token. If the deploy fails with an authentication error (code 10000), add **Account Settings → Read**. A custom domain later also needs **Zone → Workers Routes → Edit** on `narrarium.net` only. *Verify:* deploy is green. (Not tried: it needs your credentials.)
5. **Workers & Pages → `models-github-proxy`:** **Metrics** (requests, errors, CPU), **Deployments** (roll back), **Settings → Variables and Secrets** (plaintext variables come from `wrangler.toml`, edit them there; **secrets are encrypted and never shown again**), **Settings → Domains & Routes**.
6. **Live logs without leaking:** dashboard → the Worker → **Logs** → **Live** (the tab may be called **Observability**), or `npx wrangler login` then `npx wrangler tail models-github-proxy --status error --format pretty`. The Worker logs nothing itself. Never paste the output anywhere; do not enable `[observability]` without a reason.
7. **Enforce rate limiting:** (a) the Worker's in-memory limit, 30 POSTs/min per address (per isolate: weak); (b) new, optional: the Workers Rate Limiting binding `OAUTH_RATE_LIMITER` in `wrangler.toml` (30 per 60 s per address, per Cloudflare location, approximate, not shown in the dashboard; needs Wrangler ≥ 4.36.0; `namespace_id` `7301` must be unique in your account); a missing or failing binding never breaks the Worker; (c) WAF rate-limiting rules **cannot be applied on `workers.dev`** (a zone Cloudflare owns); they need a custom domain. On the Free plan: 1 rule, 10 s period, per IP, path filter, e.g. path starts with `/oauth/` → 10 requests / 10 s → block 10 s.
8. **Optional: `auth.narrarium.net`.** Pros: your own stable URL, WAF rules, zone analytics. Cons: you move the DNS of the whole `narrarium.net` from GoDaddy to Cloudflare (a wrong record breaks the site or mail), more upkeep. Steps: **Domains → Onboard a domain** → `narrarium.net` → Free plan; review every imported DNS record against GoDaddy (keep GitHub Pages and mail records, **DNS only** / grey cloud for the site); turn DNSSEC off at GoDaddy first; change the nameservers at GoDaddy to the two Cloudflare gives you; wait for **Active**; in `wrangler.toml` add `[[routes]] pattern = "auth.narrarium.net"` + `custom_domain = true` (keep `workers_dev = true` until done; the token needs Zone → Workers Routes → Edit); deploy; `gh variable set VITE_GITHUB_MODELS_BASE --body https://auth.narrarium.net` and republish the site. `ALLOWED_ORIGINS_EXTRA` does not change (it lists *site* origins), and no Google/Microsoft/GitHub console needs a change. Then set `workers_dev = false`.
9. **Rotation:** reminder 2 weeks before expiry; **Roll** the token (**API Tokens** → ⋮ → **Roll**, which invalidates the old one at once), `gh secret set CLOUDFLARE_API_TOKEN`, re-run the deploy. If you suspect a leak, roll now and rotate the client secrets too.
10. **Never:** paste secrets anywhere, put them in `wrangler.toml`, give the token account-wide admin or "all accounts/zones", use the Global API Key, edit Worker variables in the dashboard (the next deploy overwrites them).

## 2. GitHub App

Settings → **Developer settings** → **GitHub Apps** → **New GitHub App**:

- **Name** `Narrarium` (unique, ≤ 34 characters). **Homepage URL** `https://narrarium.net`.
- **Callback URLs** (4): `https://narrarium.net/auth/github/callback`, `https://www.narrarium.net/auth/github/callback`, `http://localhost:5173/auth/github/callback`, `http://localhost:4173/auth/github/callback`. **Wildcard matching: off** for each.
- **Expire user authorization tokens: on.** **Request user authorization (OAuth) during installation: on.** **Enable Device Flow: off.** **Setup URL:** empty. **Webhook → Active: off.**
- **Repository permissions:** Contents **Read & write**; Pull requests **Read & write**; Workflows **Read & write**; **Repository creation → Write** (new on 2026-10-13: lets the app create repositories without Administration; if you cannot find it, do not substitute Administration, tell the developer); Metadata Read is automatic. **No Administration, no Pages, no organization/account permissions.**
- **Where can this GitHub App be installed?** **Any account.** → **Create GitHub App**.
- On the app page: copy the **Client ID** (not the App ID); in **Optional features** make sure "User-to-server token expiration" is on; **Generate a new client secret** (shown once).
- **Where the values go:** Client ID → `GITHUB_APP_CLIENT_ID` in `wrangler.toml` `[vars]` (and later the site's public config); client secret → repository secret **`GH_APP_CLIENT_SECRET`** via `set-secrets.sh` (GitHub forbids secret names starting with `GITHUB_`; the deploy uploads it to the Worker as `GITHUB_APP_CLIENT_SECRET`). While the Client ID is empty `/oauth/status` says `github:false`.
- **Install:** app page → **Install App** → your account → **Only select repositories** (the books) → **Install**. Change later under **Settings → Applications → Installed GitHub Apps → Configure**.
- **Revoke:** the user: **Settings → Applications → Authorized GitHub Apps → Revoke**; you: **Installed GitHub Apps → Configure → Suspend/Uninstall**; the site's disconnect calls the Worker, which deletes the app's grant for that user (`DELETE /applications/{client_id}/grant`).
- *Verify the id and secret:* `curl -s -X POST <worker>/oauth/github/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"test"}'` → `invalid_grant` means GitHub accepted them; `not_configured … wrong client id or secret` means they do not match.

## 3. Google

- Google Cloud Console → **Google Auth Platform** → **Audience**: publishing status **In production** (in *Testing* refresh tokens expire after 7 days).
- **Clients** → the **Web application** client `91477716497-…`: **Authorized JavaScript origins** `https://narrarium.net`, `https://www.narrarium.net`, `http://localhost:5173`, `http://localhost:4173`; **no** redirect URIs (popup code flow). **Add secret**, copy it at once.
- **Data Access:** the site requests `drive.appdata` (non-sensitive), `drive` (**restricted**: needs Google verification and a security assessment for apps storing data on servers; until then users see "unverified app", and a cap of 100 new users applies — re-confirm in the console), `openid`, `profile`, `email`. Options: stay as is for personal use, request verification, or have the site request only `drive.file`/`drive.appdata` (a site change).
- Secret → `set-secrets.sh` (first prompt; Google secrets usually start with `GOCSPX-`). *Verify:* `/oauth/google/refresh` with a made-up token → `invalid_grant`; `invalid_client` means a wrong id or secret.
- **Caveat I could not test:** Google's docs (updated 2026-10-29) say that in popup mode the `redirect_uri` used for the code exchange is the page's origin; the Worker sends the undocumented `postmessage`, which many developers report working. If the first Google connection fails with `redirect_uri_mismatch`, tell the developer (the fix is in the Worker).

## 4. Microsoft (Entra)

- Entra admin center → **Entra ID** → **App registrations** → client ID `a80b2024-b9e3-4cb1-8480-aac7f164a6eb`.
- **Supported account types** must include personal accounts (**Any Entra ID Tenant + Personal Microsoft accounts**); the Worker uses the `common` authority.
- **Authentication** → **Redirect URI configuration** → **Add Redirect URI** → **Web**: `https://narrarium.net/auth/microsoft-callback.html`, `https://www.narrarium.net/auth/microsoft-callback.html`, `http://localhost:5173/auth/microsoft-callback.html`, `http://localhost:4173/auth/microsoft-callback.html`. Keep the existing MSAL SPA URIs; **do not** register the new ones as "Single-page application" (24-hour refresh tokens, `AADSTS9002327`). "Allow public client flows": **No**.
- **Certificates & secrets** → **Client secrets** → **New client secret**, expiry **24 months** (the maximum; Microsoft recommends under 12), copy the **Value** (not the Secret ID), put the expiry date in your calendar 30 days ahead. `set-secrets.sh` second prompt (it refuses a GUID-shaped Secret ID).
- **Rotate without downtime:** create a second secret → `set-secrets.sh` + deploy → check status and connect a test account → delete the old secret.
- **API permissions** → Microsoft Graph → Delegated: `User.Read`, `Files.ReadWrite`, `offline_access` (the site also asks for `openid` and `profile`).

## 5. Final checklist

```bash
gh secret list                                              # names only
infra/models-github-proxy/scripts/set-secrets.sh --dry-run  # what it would do
infra/models-github-proxy/scripts/set-secrets.sh            # hidden prompts, optional deploy
gh workflow run deploy-worker.yml && gh run watch
curl https://models-github-proxy.alessandro-rapiti44.workers.dev/oauth/status
node infra/models-github-proxy/scripts/check-status.mjs
```

`{"google":true,"microsoft":true,"github":true}` = every provider has id and secret. A `false` = that secret (or, for GitHub, `GITHUB_APP_CLIENT_ID`) is missing; the run summary and `check-status.mjs` say which. An answer without `github` = the old Worker is still live (deploy failed or not propagated yet). From the site: reconnect Google (stay signed in beyond 1 hour) and OneDrive (beyond 24 hours); GitHub comes with a later site release.

## 6. What to enforce

| Setting | Where | Why |
| --- | --- | --- |
| Cloudflare token: Worker Editor (or Workers Scripts: Edit) only, your account only, with expiry, no IP filter | Cloudflare → Account API Tokens | a leak can only redeploy this Worker |
| Calendar reminders: Cloudflare token (2 weeks before), Microsoft secret (30 days before) | your calendar | avoids blocked deploys and an OneDrive outage |
| Expire user authorization tokens **on**; wildcard callback matching **off**; webhook **off**; no Administration/Pages | GitHub App | short-lived tokens, no code theft on subdomains, minimal consent |
| App installed only on the book repositories | GitHub → Installed GitHub Apps | the token sees only those |
| Consent screen **In production**; exact JavaScript origins | Google Auth Platform | 7-day refresh tokens in *Testing* |
| **Web** platform URIs, public client flows **No**, secret ≤ 24 months with a second secret to rotate | Entra | the secret is accepted and refresh tokens last 90 days |
| Secrets only in GitHub secrets (then Worker secrets), loaded with `set-secrets.sh`; repository secret named `GH_APP_CLIENT_SECRET` | GitHub / Worker | never in `wrangler.toml`, chat or shell history; `GITHUB_*` names are forbidden |
| No PAT or app token in synced data | site | a token in plaintext on Drive or a public repo is a lost token |
| Variables only from `wrangler.toml`; Workers Logs off | repo / Cloudflare | no traces, no file/dashboard drift |
| Rate limiting: in-code limit + `OAUTH_RATE_LIMITER`; a WAF rule on `/oauth/` once there is a custom domain | Worker / Cloudflare | `workers.dev` accepts no WAF rules |
| Workflow permissions `contents: read` only | `deploy-worker.yml` | the workflow cannot write to the repository |

## Sources (all read 2026-11-23)

Cloudflare: [GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [create a token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [templates](https://developers.cloudflare.com/fundamentals/api/reference/template/), [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/), [roll a token](https://developers.cloudflare.com/fundamentals/api/how-to/roll-token/), [account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/), [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [variables](https://developers.cloudflare.com/workers/configuration/environment-variables/) and [secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/), [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [WAF rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/), [onboard a domain](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/), [update nameservers](https://developers.cloudflare.com/dns/nameservers/update-nameservers/), [GoDaddy nameservers](https://www.godaddy.com/help/change-nameservers-for-your-domain-names-664).
GitHub: [register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), [callback URLs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url), [user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [refreshing](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens), [token request errors](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors), [OAuth applications API](https://docs.github.com/en/rest/apps/oauth-applications), [modify a registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration), [install your own app](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app), [revoke authorizations](https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps), [installed apps](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps), [changelog 2026-10-13](https://github.blog/changelog/2026-10-13-github-app-improvements-for-least-privilege-and-management/), [secret names](https://docs.github.com/en/actions/reference/security/secrets).
Google: [audience](https://support.google.com/cloud/answer/15549945), [Google Auth Platform](https://support.google.com/cloud/answer/15544987), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [code model](https://developers.google.com/identity/oauth2/web/guides/use-code-model).
Microsoft: [register an app](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [redirect URIs](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri), [credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials?tabs=client-secret).

**Not verified** (see the Italian guide for the full list): the live forms and exact menu labels (they need your login); the minimal Cloudflare token itself; the "Repository creation" label and its behaviour on selected-repository installs; Google's `postmessage` code exchange; the 100-user cap for unverified restricted scopes; **Roll** for account-owned tokens; GitHub accepting a revoke with an expired access token; GoDaddy's menus.

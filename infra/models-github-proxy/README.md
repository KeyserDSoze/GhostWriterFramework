# GitHub Models CORS proxy (Cloudflare Worker)

The Narrarium web app runs entirely in the browser (GitHub Pages). The GitHub
Models API at `https://models.github.ai/*` does not return CORS headers, so
browser calls are blocked. This Cloudflare Worker transparently forwards every
request to `models.github.ai` and adds CORS headers scoped to the Narrarium
origins.

## What it proxies

- `POST /inference/...` — chat/inference (OpenAI-compatible endpoint)
- `GET /catalog/models` — model catalog

Path, query string, HTTP method, body (streamed), and application headers
(`Authorization`, `Content-Type`, `Accept`, `X-GitHub-Api-Version`, ...) are
preserved. Cookies are stripped before forwarding.

## Allowed origins

Set in `src/index.js` (`ALLOWED_ORIGINS`):

- `https://narrarium.net`
- `https://www.narrarium.net`
- `http://localhost:5173`, `http://localhost:4173` (local dev)

## Deploy

Deployment is automated by `.github/workflows/deploy-worker.yml`, which runs
`wrangler deploy` on every push to `main` that changes `infra/**`. It needs two
GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN` — a scoped token that can edit Workers
- `CLOUDFLARE_ACCOUNT_ID`

### Manual deploy

```bash
cd infra/models-github-proxy
npm install
npx wrangler login      # interactive, local only
npx wrangler deploy
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

## Local test

```bash
npx wrangler dev
curl -i -H "Origin: https://narrarium.net" http://localhost:8787/catalog/models
```

## Security note

CORS is a browser-side guard, not authentication. A non-browser client can spoof
the `Origin` header. For stronger protection add a shared secret header or a
Cloudflare Access policy in front of the Worker.
